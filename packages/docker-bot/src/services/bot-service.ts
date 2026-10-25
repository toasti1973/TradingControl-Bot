// ============================================================
// BotService — Lebenszyklus der TradingEngine
//
// Die Engine fuehrt ausschliesslich die bot-eigenen Plaene aus
// (`local_plans`). Sie spricht nicht mit TradingControl; das Journal
// liefert seine Plaene ueber den TcPlanSyncService an den
// TradePlanMonitor, nicht hierher.
// ============================================================

import {
  TradingEngine,
  PaperBroker,
  type BrokerAdapter,
  type TradingEngineConfig,
  type TrackedOrder,
} from '@tradingcontrol/core';
import { BotConfig } from '../config.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { Logger } from './log-service.js';
import { LocalPlanSource, SqliteExecutionJournal } from './local-plan-source.js';
import { createBroker } from './broker-factory.js';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface BotStats {
  status: BotStatus;
  broker: string;
  uptime: number;
  activePlans: number;
  totalTrades: number;
  lastError: string | null;
}

export class BotService {
  private engine: TradingEngine | null = null;
  private broker: BrokerAdapter | null = null;
  private status: BotStatus = 'stopped';
  private startTime = 0;
  private lastError: string | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;
  private readonly maxRestartAttempts = 5;

  // Event-Listener für WebSocket-Broadcasting
  private listeners: Array<(event: string, data: unknown) => void> = [];

  constructor(
    private config: BotConfig,
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {}

  /** Config aktualisieren und Bot neu starten (falls er lief) */
  async restart(newConfig: BotConfig): Promise<void> {
    const wasRunning = this.status === 'running';

    if (wasRunning) {
      await this.stop();
    }

    this.config = newConfig;

    if (wasRunning) {
      await this.start();
    }

    this.logger.info('Bot config updated' + (wasRunning ? ' and restarted' : ''));
    this.notifyListeners('bot:config-updated', { restarted: wasRunning });
  }

  getConfig(): BotConfig {
    return this.config;
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;

    this.status = 'starting';
    this.logger.info('Bot starting...');

    try {
      // Die Engine braucht kein Journal — sie fuehrt die bot-eigenen
      // Plaene aus. Frueher stieg sie ohne TC-Schluessel gar nicht erst
      // an; damit war der Bot allein nicht arbeitsfaehig.
      this.broker = this.createBroker();

      // Engine-Config
      const engineConfig: TradingEngineConfig = {
        planPollInterval: this.config.planPollInterval,
        pricePollInterval: this.config.pricePollInterval,
        orderCheckInterval: this.config.orderCheckInterval,
      };

      this.engine = new TradingEngine(
        this.broker,
        new LocalPlanSource(this.store),
        new SqliteExecutionJournal(this.store, this.logger),
        engineConfig,
      );
      this.engine.setLogger((level: string, msg: string, data?: Record<string, unknown>) => {
        (this.logger as unknown as Record<string, (d: unknown, m: string) => void>)[level]?.(data ?? {}, msg) ?? this.logger.info(data ?? {}, msg);
      });
      this.wireEngineEvents();

      await this.engine.start();

      // Symbole aus lokalen Plaenen fuer VolatilityService registrieren
      const volService = this.engine.getVolatilityService();
      const localPlans = this.store.getLocalPlans();
      for (const lp of localPlans) {
        if (lp.status === 'planned' || lp.status === 'active') {
          volService.watchSymbol(lp.symbol);
        }
      }
      // Initiale ATR-Berechnung triggern
      volService.refresh().catch(() => {});

      this.status = 'running';
      this.startTime = Date.now();
      this.lastError = null;
      this.restartAttempts = 0;
      this.startWatchdog();
      this.logger.info({ broker: this.broker.name }, 'Bot started successfully');
      this.notifyListeners('bot:started', { broker: this.broker.name });
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, 'Bot failed to start');
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'error') return;

    this.stopWatchdog();
    this.status = 'stopping';
    this.logger.info('Bot stopping...');

    if (this.engine) {
      await this.engine.stop();
      this.engine = null;
    }

    this.broker = null;
    this.status = 'stopped';
    this.logger.info('Bot stopped');
    this.notifyListeners('bot:stopped', {});
  }

  getStats(): BotStats {
    return {
      status: this.status,
      broker: this.broker?.name ?? this.config.defaultExchange,
      uptime: this.status === 'running' ? Date.now() - this.startTime : 0,
      activePlans: this.engine?.getActivePlans().length ?? 0,
      totalTrades: this.store.getTradeCount(),
      lastError: this.lastError,
    };
  }

  getEngine(): TradingEngine | null {
    return this.engine;
  }

  getBroker(): import('@tradingcontrol/core').BrokerAdapter | null {
    return this.broker;
  }

  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * Broker fuer die bot-eigenen Plaene.
   *
   * `local_plans` fuehrt keine Boerse pro Plan — hier gilt die
   * voreingestellte. Fehlen deren Zugangsdaten, wird der Uebungsbroker
   * genommen statt den Start abzubrechen: Ein Bot, der wegen einer
   * fehlenden Boerse gar nicht laeuft, ueberwacht auch nichts.
   */
  private createBroker(): BrokerAdapter {
    const exchange = this.config.defaultExchange;

    if (exchange === 'paper') {
      return new PaperBroker({ priceSource: 'phemex' });
    }

    try {
      return createBroker(this.config, exchange);
    } catch (err) {
      this.logger.warn(
        { exchange, err: err instanceof Error ? err.message : err },
        'Voreingestellte Boerse nicht verfuegbar — es wird im Uebungsbetrieb gehandelt',
      );
      return new PaperBroker({ priceSource: 'phemex' });
    }
  }

  private wireEngineEvents(): void {
    if (!this.engine) return;

    this.engine.on('plan:activated', (planId: string) => {
      this.logger.info({ planId }, 'Plan activated');
      this.notifyListeners('plan:activated', { planId });
    });

    this.engine.on('plan:completed', (planId: string) => {
      this.logger.info({ planId }, 'Plan completed');
      this.notifyListeners('plan:completed', { planId });
    });

    this.engine.on('plan:error', (planId: string, error: Error) => {
      this.lastError = error.message;
      this.logger.error({ planId, err: error }, 'Plan error');
      this.notifyListeners('plan:error', { planId, error: error.message });
    });

    this.engine.on('engine:error', (error: Error) => {
      this.lastError = error.message;
      this.logger.error({ err: error }, 'Engine error');
      this.notifyListeners('engine:error', { error: error.message });
    });

    // Order-Events vom OrderManager
    const orderManager = this.engine.getOrderManager();

    orderManager.on('order:placed', (order: TrackedOrder) => {
      this.logger.info({ order }, 'Order placed');
      this.notifyListeners('order:placed', order);
    });

    orderManager.on('order:filled', (order: TrackedOrder) => {
      this.logger.info({ order }, 'Order filled');
      this.store.insertTrade({
        plan_id: order.planId,
        symbol: '',
        side: order.type === 'entry' ? 'entry' : 'exit',
        type: order.type,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: order.filledQuantity,
        avg_fill_price: order.avgFillPrice,
        fee: 0,
        pnl: 0,
        action: `${order.type}_filled`,
        order_id: order.orderId,
        timestamp: new Date().toISOString(),
      });
      this.notifyListeners('order:filled', order);
    });

    // Trailing-Events
    orderManager.on('sl:adjusted', (planId: string, oldPrice: number, newPrice: number) => {
      this.logger.info({ planId, oldPrice, newPrice }, 'Stop-Loss adjusted');
      this.notifyListeners('sl:adjusted', { planId, oldPrice, newPrice });
    });

    orderManager.on('trailing:activated', (planId: string, pct: number) => {
      this.logger.info({ planId, pct }, 'Trailing stop activated');
      this.notifyListeners('trailing:activated', { planId, pct });
    });

    orderManager.on('trailing:updated', (planId: string, newStopPrice: number) => {
      this.logger.debug({ planId, newStopPrice }, 'Trailing stop updated');
    });

    // RiskGuard-Events
    const riskGuard = this.engine.getRiskGuard();

    riskGuard.on('risk:circuit-breaker', (reason: string) => {
      this.logger.warn({ reason }, 'RiskGuard circuit breaker triggered');
      this.notifyListeners('engine:error', { error: `Circuit Breaker: ${reason}` });
    });

    riskGuard.on('risk:cooldown-blocked', (symbol: string, remainingMs: number) => {
      this.logger.info({ symbol, remainingMin: Math.ceil(remainingMs / 60000) }, 'Plan blocked by cooldown');
    });

    // Price-Events vom PriceMonitor
    const priceMonitor = this.engine.getPriceMonitor();

    priceMonitor.on('price:update', (symbol: string, price: number) => {
      this.notifyListeners('price:update', { symbol, price });
    });
  }

  private notifyListeners(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch {
        // Listener-Fehler nicht propagieren
      }
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    // Pruefe alle 30 Sekunden ob die Engine noch laeuft
    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'running') return;

      const engine = this.engine;
      if (!engine || engine.getStatus() === 'stopped') {
        this.logger.warn('Watchdog: Engine stopped unexpectedly, attempting restart...');
        this.attemptRestart();
      }
    }, 30_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async attemptRestart(): Promise<void> {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.status = 'error';
      this.lastError = `Watchdog: ${this.maxRestartAttempts} Neustartversuche fehlgeschlagen`;
      this.logger.error('Watchdog: Max restart attempts reached, giving up');
      this.notifyListeners('engine:error', { error: this.lastError });
      this.stopWatchdog();
      return;
    }

    this.restartAttempts++;
    this.logger.info({ attempt: this.restartAttempts }, 'Watchdog: Restarting bot...');

    try {
      // Cleanup
      if (this.engine) {
        try { await this.engine.stop(); } catch { /* ignore */ }
        this.engine = null;
      }
      this.broker = null;
      this.status = 'stopped';

      // Restart
      await this.start();
      this.logger.info('Watchdog: Bot restarted successfully');
      this.notifyListeners('bot:started', { broker: this.getStats().broker, watchdog: true });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, attempt: this.restartAttempts }, 'Watchdog: Restart failed');
      // Exponential backoff: 30s * attempt
      const delay = 30_000 * this.restartAttempts;
      setTimeout(() => this.attemptRestart(), delay);
    }
  }
}
