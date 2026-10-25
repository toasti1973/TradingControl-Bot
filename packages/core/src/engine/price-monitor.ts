import { EventEmitter } from 'node:events';
import { BrokerAdapter } from '../types/broker.js';
import { ActivationCondition, TcPlan } from '../types/plan.js';

export interface PriceMonitorEvents {
  'price:update': [symbol: string, price: number];
  'activation:triggered': [planId: string, plan: TcPlan];
  'price:error': [symbol: string, error: Error];
}

interface WatchedPlan {
  plan: TcPlan;
  conditionsMet: boolean[];
  activated: boolean;
}

export class PriceMonitor extends EventEmitter<PriceMonitorEvents> {
  private watchedPlans = new Map<string, WatchedPlan>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private prices = new Map<string, number>();

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly pollInterval: number = 2000
  ) {
    super();
  }

  start(): void {
    this.running = true;
    this.schedulePoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollPrices().finally(() => {
      if (this.running) {
        this.pollTimer = setTimeout(() => this.schedulePoll(), this.pollInterval);
      }
    });
  }

  watchPlan(plan: TcPlan): void {
    if (this.watchedPlans.has(plan.id)) return;
    const conditions = plan.activation_conditions ?? [];
    this.watchedPlans.set(plan.id, {
      plan,
      conditionsMet: conditions.map(() => false),
      activated: false,
    });
  }

  unwatchPlan(planId: string): void {
    this.watchedPlans.delete(planId);
  }

  updatePlan(plan: TcPlan): void {
    const watched = this.watchedPlans.get(plan.id);
    if (watched) {
      watched.plan = plan;
    }
  }

  isActivated(planId: string): boolean {
    return this.watchedPlans.get(planId)?.activated ?? false;
  }

  getPrice(symbol: string): number | undefined {
    return this.prices.get(symbol);
  }

  private async pollPrices(): Promise<void> {
    // Sammle alle einzigartigen Symbole
    const symbols = new Set<string>();
    for (const watched of this.watchedPlans.values()) {
      symbols.add(watched.plan.symbol);
    }

    // Preise parallel abfragen
    const pricePromises = [...symbols].map(async symbol => {
      try {
        const price = await this.broker.getPrice(symbol);
        if (price !== null) {
          this.prices.set(symbol, price);
          this.emit('price:update', symbol, price);
        }
      } catch (err) {
        this.emit('price:error', symbol, err instanceof Error ? err : new Error(String(err)));
      }
    });

    await Promise.allSettled(pricePromises);

    // Aktivierungsbedingungen prüfen
    for (const [planId, watched] of this.watchedPlans) {
      if (watched.activated) continue;

      const currentPrice = this.prices.get(watched.plan.symbol);
      if (currentPrice === undefined) continue;

      this.checkActivation(planId, watched, currentPrice);
    }
  }

  private checkActivation(planId: string, watched: WatchedPlan, currentPrice: number): void {
    const { plan } = watched;
    const conditions = plan.activation_conditions ?? [];

    // Keine Bedingungen = sofort aktiv
    if (conditions.length === 0) {
      watched.activated = true;
      this.emit('activation:triggered', planId, plan);
      return;
    }

    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i]!;
      watched.conditionsMet[i] = this.evaluateCondition(condition, currentPrice, plan);
    }

    // Alle Bedingungen müssen erfüllt sein
    if (watched.conditionsMet.every(Boolean)) {
      watched.activated = true;
      this.emit('activation:triggered', planId, plan);
    }
  }

  private evaluateCondition(
    condition: ActivationCondition,
    currentPrice: number,
    _plan: TcPlan
  ): boolean {
    // TC-Style: nur 'price' Feld → sequential, jede Bedingung gilt als erreicht wenn Preis sie kreuzt
    if (condition.price !== undefined && condition.type === undefined) {
      return true; // TC-Logik wird vom TradePlanMonitor (Bitmask) gehandhabt
    }

    switch (condition.type) {
      case 'immediate':
        return true;

      case 'price_above':
        return condition.value != null && currentPrice >= condition.value;

      case 'price_below':
        return condition.value != null && currentPrice <= condition.value;

      default:
        return false;
    }
  }
}
