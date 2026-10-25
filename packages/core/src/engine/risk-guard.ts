import { EventEmitter } from 'node:events';

export interface RiskGuardConfig {
  /** Max daily loss as fraction of account (e.g. 0.05 = 5%). 0 = disabled */
  maxDailyLossPct?: number;
  /** Max weekly loss as fraction of account (e.g. 0.10 = 10%). 0 = disabled */
  maxWeeklyLossPct?: number;
  /** Max total drawdown as fraction of account (e.g. 0.20 = 20%). 0 = disabled */
  maxDrawdownPct?: number;
  /** Cooldown in ms after a stop-loss is triggered per symbol (default: 2h) */
  slCooldownMs?: number;
  /** Max concurrent active plans (default: 5) */
  maxConcurrentPlans?: number;
  /** Starting account balance for drawdown calculation */
  accountBalance?: number;
}

export interface RiskGuardEvents {
  'risk:daily-limit': [lossPct: number];
  'risk:weekly-limit': [lossPct: number];
  'risk:drawdown-limit': [drawdownPct: number];
  'risk:cooldown-blocked': [symbol: string, remainingMs: number];
  'risk:max-plans-blocked': [current: number, max: number];
  'risk:circuit-breaker': [reason: string];
}

interface LossRecord {
  amount: number;
  timestamp: number;
}

export class RiskGuard extends EventEmitter<RiskGuardEvents> {
  private readonly maxDailyLossPct: number;
  private readonly maxWeeklyLossPct: number;
  private readonly maxDrawdownPct: number;
  private readonly slCooldownMs: number;
  private readonly maxConcurrentPlans: number;

  private accountBalance: number;
  private peakBalance: number;
  private losses: LossRecord[] = [];
  private slCooldowns = new Map<string, number>(); // symbol → cooldown-end timestamp
  private activePlanCount = 0;
  private halted = false;
  private haltReason = '';

  constructor(config: RiskGuardConfig = {}) {
    super();
    this.maxDailyLossPct = config.maxDailyLossPct ?? 0.05;
    this.maxWeeklyLossPct = config.maxWeeklyLossPct ?? 0.10;
    this.maxDrawdownPct = config.maxDrawdownPct ?? 0.20;
    this.slCooldownMs = config.slCooldownMs ?? 2 * 60 * 60 * 1000; // 2h
    this.maxConcurrentPlans = config.maxConcurrentPlans ?? 5;
    this.accountBalance = config.accountBalance ?? 0;
    this.peakBalance = this.accountBalance;
  }

  /** Update account balance (call periodically or after trades) */
  updateBalance(balance: number): void {
    this.accountBalance = balance;
    if (balance > this.peakBalance) {
      this.peakBalance = balance;
    }
  }

  /** Record a realized loss (positive number = loss amount) */
  recordLoss(amount: number, symbol?: string): void {
    if (amount <= 0) return;
    this.losses.push({ amount, timestamp: Date.now() });
    this.checkLimits();

    // If loss came from a stop-loss, record cooldown
    if (symbol) {
      this.slCooldowns.set(symbol, Date.now() + this.slCooldownMs);
    }
  }

  /** Record a stop-loss event for cooldown tracking */
  recordStopLoss(symbol: string): void {
    this.slCooldowns.set(symbol, Date.now() + this.slCooldownMs);
  }

  /** Set active plan count (call from engine) */
  setActivePlanCount(count: number): void {
    this.activePlanCount = count;
  }

  /** Check if a new plan activation is allowed */
  canActivatePlan(symbol: string): { allowed: boolean; reason?: string } {
    // Circuit breaker
    if (this.halted) {
      return { allowed: false, reason: `Circuit Breaker aktiv: ${this.haltReason}` };
    }

    // Max concurrent plans
    if (this.activePlanCount >= this.maxConcurrentPlans) {
      this.emit('risk:max-plans-blocked', this.activePlanCount, this.maxConcurrentPlans);
      return {
        allowed: false,
        reason: `Max. ${this.maxConcurrentPlans} gleichzeitige Plaene erreicht (aktuell: ${this.activePlanCount})`,
      };
    }

    // Symbol cooldown after SL
    const cooldownEnd = this.slCooldowns.get(symbol);
    if (cooldownEnd && Date.now() < cooldownEnd) {
      const remainingMs = cooldownEnd - Date.now();
      this.emit('risk:cooldown-blocked', symbol, remainingMs);
      const remainingMin = Math.ceil(remainingMs / 60_000);
      return {
        allowed: false,
        reason: `Cooldown fuer ${symbol}: noch ${remainingMin} Min. nach Stop-Loss`,
      };
    }

    // Cleanup expired cooldown
    if (cooldownEnd && Date.now() >= cooldownEnd) {
      this.slCooldowns.delete(symbol);
    }

    return { allowed: true };
  }

  /** Check if system is halted */
  isHalted(): boolean {
    return this.halted;
  }

  getHaltReason(): string {
    return this.haltReason;
  }

  /** Manually reset the circuit breaker */
  reset(): void {
    this.halted = false;
    this.haltReason = '';
    this.losses = [];
  }

  /** Get current risk stats */
  getStats(): {
    dailyLossPct: number;
    weeklyLossPct: number;
    drawdownPct: number;
    activePlans: number;
    maxPlans: number;
    halted: boolean;
    haltReason: string;
    cooldowns: Record<string, number>;
  } {
    const now = Date.now();
    return {
      dailyLossPct: this.accountBalance > 0 ? this.getLossSince(now - 86_400_000) / this.accountBalance : 0,
      weeklyLossPct: this.accountBalance > 0 ? this.getLossSince(now - 7 * 86_400_000) / this.accountBalance : 0,
      drawdownPct: this.peakBalance > 0 ? (this.peakBalance - this.accountBalance) / this.peakBalance : 0,
      activePlans: this.activePlanCount,
      maxPlans: this.maxConcurrentPlans,
      halted: this.halted,
      haltReason: this.haltReason,
      cooldowns: Object.fromEntries(
        [...this.slCooldowns.entries()]
          .filter(([, end]) => end > now)
          .map(([sym, end]) => [sym, Math.ceil((end - now) / 60_000)])
      ),
    };
  }

  private checkLimits(): void {
    if (this.accountBalance <= 0) return;
    const now = Date.now();

    // Daily loss check
    if (this.maxDailyLossPct > 0) {
      const dailyLoss = this.getLossSince(now - 86_400_000);
      const dailyPct = dailyLoss / this.accountBalance;
      if (dailyPct >= this.maxDailyLossPct) {
        this.halt(`Tageslimit erreicht: ${(dailyPct * 100).toFixed(1)}% Verlust`);
        this.emit('risk:daily-limit', dailyPct);
      }
    }

    // Weekly loss check
    if (this.maxWeeklyLossPct > 0) {
      const weeklyLoss = this.getLossSince(now - 7 * 86_400_000);
      const weeklyPct = weeklyLoss / this.accountBalance;
      if (weeklyPct >= this.maxWeeklyLossPct) {
        this.halt(`Wochenlimit erreicht: ${(weeklyPct * 100).toFixed(1)}% Verlust`);
        this.emit('risk:weekly-limit', weeklyPct);
      }
    }

    // Max drawdown check
    if (this.maxDrawdownPct > 0 && this.peakBalance > 0) {
      const drawdownPct = (this.peakBalance - this.accountBalance) / this.peakBalance;
      if (drawdownPct >= this.maxDrawdownPct) {
        this.halt(`Max. Drawdown erreicht: ${(drawdownPct * 100).toFixed(1)}%`);
        this.emit('risk:drawdown-limit', drawdownPct);
      }
    }
  }

  private halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    this.emit('risk:circuit-breaker', reason);
  }

  private getLossSince(since: number): number {
    return this.losses
      .filter(l => l.timestamp >= since)
      .reduce((sum, l) => sum + l.amount, 0);
  }
}
