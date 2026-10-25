// ============================================================
// TradingEngine — Ausfuehrung der bot-eigenen Handelsplaene
//
// Arbeitet auf einer uebergebenen Planquelle, nicht auf dem Journal. Die
// aus dem Journal gespiegelten Plaene laufen ueber den TradePlanMonitor;
// beide Bestaende sind getrennt, damit keine Order doppelt herausgeht.
//
// Die Engine spricht nicht mit TradingControl — weder lesend noch
// schreibend. Ohne Journal laeuft sie unveraendert weiter.
// ============================================================

import { EventEmitter } from 'node:events';
import { BrokerAdapter } from '../types/broker.js';
import { ExecutionJournal } from '../types/execution.js';
import { TcPlan } from '../types/plan.js';
import { PlanManager, PlanSource } from './plan-manager.js';
import { PriceMonitor } from './price-monitor.js';
import { OrderManager } from './order-manager.js';
import { RiskGuard, RiskGuardConfig } from './risk-guard.js';
import { VolatilityService, VolatilityServiceConfig } from './volatility-service.js';

export interface TradingEngineConfig {
  planPollInterval?: number;
  pricePollInterval?: number;
  orderCheckInterval?: number;
  maxOrdersPerHour?: number;
  maxOrdersPerDay?: number;
  maxPriceDeviationPct?: number;
  riskGuard?: RiskGuardConfig;
  volatility?: VolatilityServiceConfig;
}

export interface TradingEngineEvents {
  'engine:started': [];
  'engine:stopped': [];
  'engine:error': [error: Error];
  'plan:activated': [planId: string];
  'plan:completed': [planId: string];
  'plan:error': [planId: string, error: Error];
}

export type EngineStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export class TradingEngine extends EventEmitter<TradingEngineEvents> {
  private readonly planManager: PlanManager;
  private readonly priceMonitor: PriceMonitor;
  private readonly orderManager: OrderManager;
  private readonly riskGuard: RiskGuard;
  private readonly volatilityService: VolatilityService;
  private status: EngineStatus = 'stopped';

  constructor(
    private readonly broker: BrokerAdapter,
    planSource: PlanSource,
    journal: ExecutionJournal | null,
    config: TradingEngineConfig = {}
  ) {
    super();

    this.planManager = new PlanManager(planSource, config.planPollInterval ?? 30_000);

    this.priceMonitor = new PriceMonitor(broker, config.pricePollInterval ?? 2000);

    this.orderManager = new OrderManager(broker, journal, {
      maxOrdersPerHour: config.maxOrdersPerHour,
      maxOrdersPerDay: config.maxOrdersPerDay,
      maxPriceDeviationPct: config.maxPriceDeviationPct,
    });

    this.riskGuard = new RiskGuard(config.riskGuard);
    this.volatilityService = new VolatilityService(config.volatility);

    this.wireEvents();
  }

  /** Inject a log function for engine-internal events (optional) */
  setLogger(log: (level: string, msg: string, data?: Record<string, unknown>) => void): void {
    this.planManager.setLogger(log);
  }

  async start(): Promise<void> {
    if (this.status !== 'stopped') return;
    this.status = 'starting';

    try {
      await this.broker.connect();

      this.planManager.start();
      this.priceMonitor.start();
      this.orderManager.start();
      this.volatilityService.start();

      this.status = 'running';
      this.emit('engine:started');
    } catch (err) {
      this.status = 'stopped';
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status !== 'running') return;
    this.status = 'stopping';

    this.planManager.stop();
    this.priceMonitor.stop();
    this.orderManager.stop();
    this.volatilityService.stop();

    // Alle aktiven Pläne canceln
    for (const planId of this.orderManager.getActivePlanIds()) {
      await this.orderManager.cancelPlan(planId);
    }

    await this.broker.disconnect();
    this.status = 'stopped';
    this.emit('engine:stopped');
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getActivePlans(): TcPlan[] {
    return this.planManager.getActivePlans();
  }

  getAllPlans(): TcPlan[] {
    return this.planManager.getAllPlans();
  }

  getPlanManager(): PlanManager {
    return this.planManager;
  }

  getPriceMonitor(): PriceMonitor {
    return this.priceMonitor;
  }

  getOrderManager(): OrderManager {
    return this.orderManager;
  }

  getRiskGuard(): RiskGuard {
    return this.riskGuard;
  }

  getVolatilityService(): VolatilityService {
    return this.volatilityService;
  }

  private wireEvents(): void {
    // PlanManager Events
    this.planManager.on('plan:error', (error) => {
      this.emit('engine:error', error);
    });

    this.planManager.on('plan:new', (plan) => {
      if (plan.bot_enabled && plan.status === 'planned') {
        this.priceMonitor.watchPlan(plan);
        this.volatilityService.watchSymbol(plan.symbol);
      }
    });

    this.planManager.on('plan:updated', (plan, _previous) => {
      this.priceMonitor.updatePlan(plan);

      if (plan.status === 'cancelled') {
        this.priceMonitor.unwatchPlan(plan.id);
        this.orderManager.cancelPlan(plan.id).catch((err) => {
          this.emit('engine:error', err instanceof Error ? err : new Error(String(err)));
        });
      }
    });

    this.planManager.on('plan:removed', (planId) => {
      this.priceMonitor.unwatchPlan(planId);
      this.orderManager.cancelPlan(planId).catch((err) => {
        this.emit('engine:error', err instanceof Error ? err : new Error(String(err)));
      });
    });

    // PriceMonitor Events — Aktivierung → RiskGuard + Volatilitaet → Order-Ausführung
    this.priceMonitor.on('activation:triggered', (planId, plan) => {
      // RiskGuard check
      const check = this.riskGuard.canActivatePlan(plan.symbol);
      if (!check.allowed) {
        this.emit('plan:error', planId, new Error(`RiskGuard: ${check.reason}`));
        return;
      }

      // Volatility filter
      if (this.volatilityService.isHighVolatility(plan.symbol)) {
        this.emit('plan:error', planId, new Error(
          `Volatilitaet zu hoch fuer ${plan.symbol} (ATR > 2x Durchschnitt). Aktivierung verzoegert.`
        ));
        return;
      }

      // Low-liquidity window check
      if (this.volatilityService.isLowLiquidityWindow()) {
        this.emit('plan:error', planId, new Error(
          `Low-Liquidity-Fenster (00:00-04:00 UTC). Aktivierung verzoegert.`
        ));
        return;
      }

      this.riskGuard.setActivePlanCount(this.orderManager.getActivePlanIds().length + 1);
      this.emit('plan:activated', planId);
      this.orderManager.executePlan(plan).catch((err) => {
        this.emit('plan:error', planId, err instanceof Error ? err : new Error(String(err)));
      });
    });

    // OrderManager Events
    this.orderManager.on('plan:completed', (planId) => {
      this.priceMonitor.unwatchPlan(planId);
      this.riskGuard.setActivePlanCount(this.orderManager.getActivePlanIds().length);
      this.emit('plan:completed', planId);
    });

    this.orderManager.on('plan:error', (planId, error) => {
      this.priceMonitor.unwatchPlan(planId);
      this.riskGuard.setActivePlanCount(this.orderManager.getActivePlanIds().length);
      this.emit('plan:error', planId, error);
    });

    // SL-Fill → RiskGuard Cooldown tracken
    this.orderManager.on('order:filled', (order) => {
      if (order.type === 'stop_loss') {
        const state = this.orderManager.getPlanState(order.planId);
        if (state) {
          this.riskGuard.recordStopLoss(state.plan.symbol);
        }
      }
    });

    // RiskGuard Circuit Breaker → Engine-Error emittieren
    this.riskGuard.on('risk:circuit-breaker', (reason) => {
      this.emit('engine:error', new Error(`Circuit Breaker: ${reason}`));
    });
  }
}
