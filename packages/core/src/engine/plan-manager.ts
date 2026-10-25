import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TcPlan } from '../types/plan.js';

export interface PlanManagerEvents {
  'plan:new': [plan: TcPlan];
  'plan:updated': [plan: TcPlan, previous: TcPlan];
  'plan:removed': [planId: string];
  'plan:error': [error: Error];
}

/**
 * Woher die Plaene kommen, die dieser Manager ueberwacht.
 *
 * Die Quelle ist austauschbar, weil der Bot zwei getrennte Bestaende
 * fuehrt: die einfachen, hier im Bot angelegten Plaene und die aus dem
 * Journal gespiegelten. Jeder Bestand hat genau einen Ausfuehrer — sonst
 * ginge dieselbe Order zweimal an die Boerse.
 */
export interface PlanSource {
  /** Sprechender Name, taucht in Protokollen auf. */
  readonly name: string;
  fetchPlans(): Promise<TcPlan[]>;
}

export class PlanManager extends EventEmitter<PlanManagerEvents> {
  private plans = new Map<string, TcPlan>();
  private planHashes = new Map<string, string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastSuccessfulFetch = 0;
  private readonly cacheMaxAge: number;
  private _lastPollErrorLog = 0;
  private _lastCacheErrorLog = 0;

  private log: ((level: string, msg: string, data?: Record<string, unknown>) => void) | null = null;

  constructor(
    private readonly source: PlanSource,
    private readonly pollInterval: number = 30_000,
    cacheMaxAge: number = 300_000 // 5 Min Cache-Fallback
  ) {
    super();
    this.cacheMaxAge = cacheMaxAge;
  }

  setLogger(log: (level: string, msg: string, data?: Record<string, unknown>) => void): void {
    this.log = log;
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
    this.poll().finally(() => {
      if (this.running) {
        this.pollTimer = setTimeout(() => this.schedulePoll(), this.pollInterval);
      }
    });
  }

  getPlan(planId: string): TcPlan | undefined {
    return this.plans.get(planId);
  }

  getActivePlans(): TcPlan[] {
    return [...this.plans.values()].filter(
      p => p.bot_enabled && (p.status === 'planned' || p.status === 'active' || p.status === 'monitoring')
    );
  }

  getAllPlans(): TcPlan[] {
    return [...this.plans.values()];
  }

  private async poll(): Promise<void> {
    try {
      const plans = await this.source.fetchPlans();
      this.lastSuccessfulFetch = Date.now();
      this.log?.('debug', 'Plan poll successful', {
        source: this.source.name, planCount: plans.length, activeInCache: this.plans.size,
      });
      this.processPlanUpdate(plans);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Nicht staendig loggen — nur alle 5 Minuten
      const now = Date.now();
      if (!this._lastPollErrorLog || now - this._lastPollErrorLog > 300_000) {
        this.log?.('warn', 'Plan poll failed', { source: this.source.name, error: error.message });
        this._lastPollErrorLog = now;
      }

      // Cache-Fallback: Bei temporärem Ausfall der Quelle weiterarbeiten
      if (Date.now() - this.lastSuccessfulFetch > this.cacheMaxAge) {
        if (!this._lastCacheErrorLog || now - this._lastCacheErrorLog > 300_000) {
          this.emit('plan:error', new Error(
            `Planquelle "${this.source.name}" seit ${this.cacheMaxAge / 1000}s nicht erreichbar`,
          ));
          this._lastCacheErrorLog = now;
        }
      }
    }
  }

  private processPlanUpdate(freshPlans: TcPlan[]): void {
    const freshIds = new Set<string>();

    for (const plan of freshPlans) {
      freshIds.add(plan.id);
      const hash = this.hashPlan(plan);
      const existingHash = this.planHashes.get(plan.id);

      if (!existingHash) {
        // Neuer Plan
        this.plans.set(plan.id, plan);
        this.planHashes.set(plan.id, hash);
        this.emit('plan:new', plan);
      } else if (existingHash !== hash) {
        // Plan geändert — zusätzlich updated_at vergleichen
        const existing = this.plans.get(plan.id)!;
        this.plans.set(plan.id, plan);
        this.planHashes.set(plan.id, hash);
        this.emit('plan:updated', plan, existing);
      }
    }

    // Entfernte Pläne
    for (const planId of this.plans.keys()) {
      if (!freshIds.has(planId)) {
        this.plans.delete(planId);
        this.planHashes.delete(planId);
        this.emit('plan:removed', planId);
      }
    }
  }

  private hashPlan(plan: TcPlan): string {
    // Schneller Hash-Vergleich über alle relevanten Felder
    const payload = JSON.stringify({
      id: plan.id,
      status: plan.status,
      bot_enabled: plan.bot_enabled,
      updated_at: plan.updated_at,
      entry_orders: plan.entry_orders,
      take_profits: plan.take_profits,
      stop_loss_price: plan.stop_loss_price,
      activation_conditions: plan.activation_conditions,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }
}
