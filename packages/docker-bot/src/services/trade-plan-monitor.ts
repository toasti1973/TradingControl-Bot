// ============================================================
// TradePlanMonitor — Ausfuehrung vollstaendiger Handelsplaene
//
// Zustaendig fuer Plaene aus `bot_trade_plans` — gleich ob aus dem Journal
// gespiegelt (source='tc') oder hier im Bot angelegt (source='local'). Die
// einfacheren Plaene aus `local_plans` laufen ueber die TradingEngine; die
// beiden Bestaende ueberschneiden sich nicht, damit keine Order doppelt
// herausgeht.
//
// Pipeline:
//   1. Polling alle 3s
//   2. Activation Conditions (Bitmask)
//   3. Trigger-Auswertung (Indikatoren)
//   4. Entry-Order-Placement
//   5. TP-Hit Logic mit per-TP SL-Adjust + Trailing-Activation
//   6. Trailing-Stop Logic
//   7. SL-Hit Handler
//
// Der Monitor meldet nichts an das Journal zurueck. Er fuehrt ein eigenes
// Ausfuehrungsprotokoll — es haelt auch fest, was NICHT geschah (ein wegen
// Trigger abgelehnter Einstieg etwa), wovon die Boerse nichts weiss.
// ============================================================

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  BrokerAdapter, TradePlan, EntryOrder, TakeProfit,
  ActivationCondition, TriggerBlock, SignalTrigger, OrderResult,
} from '@tradingcontrol/core';
import { getTpPercentage, checkMarketSupport, isMicaCompliant } from '@tradingcontrol/core';
import type { BrokerRegistry } from './broker-factory.js';
import {
  KlineFetcher, TriggerEvaluator, type EvaluationContext, type Candle,
} from '@tradingcontrol/indicators';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Logger } from './log-service.js';

const BOT_FIRMWARE = 'docker-bot-v0.1.0';
const BOT_DEVICE_ID = process.env['HOSTNAME'] || 'docker-bot';

interface MonitorState {
  plan: TradePlan;
  status: 'waiting_activation' | 'monitoring' | 'completed' | 'cancelled' | 'error';
  activationStep: number;                 // Bitmask
  tpState: TpStateEntry[];
  slCurrent: number | null;
  slType: 'fixed' | 'trailing';
  trailingActive: boolean;
  trailingBestPrice: number | null;
  trailingSizePct: number | null;
  remainingSize: number;
  lastPrice: number | null;
  errorCount: number;
  triggeredEntries: Set<string>;          // Entry-Order UUIDs die schon getriggert wurden
  /**
   * Hat ein externes Signal diesen Plan freigegeben?
   *
   * Gilt fuer den ganzen Plan, nicht je Einstieg: Das Signal entscheidet
   * ueber das Ob des Trades, die Einstiegspreise ueber das Wann der
   * einzelnen Teil-Orders. Wuerde je Teil-Order ein eigenes Signal
   * verlangt, bliebe ein gestaffelter Einstieg nach der ersten Order
   * stecken.
   */
  signalFreigabe: boolean;
  /**
   * Sind nach dem ersten Take-Profit alle offenen Einstiegs-Orders
   * zurueckgenommen worden — vollstaendig und ohne Fehler?
   *
   * Wird nicht gespeichert, und das mit Absicht: Nach einem Neustart
   * steht der Merker wieder auf false, der Nachlauf sieht einmal nach
   * und findet im Regelfall nichts mehr. Ein gespeicherter Merker
   * koennte dagegen "erledigt" behaupten, waehrend an der Boerse noch
   * ein Kauf-Limit liegt.
   */
  einstiegeStorniert: boolean;
}

interface TpStateEntry {
  index: number;
  price: number;
  percentage: number;
  triggered: boolean;
  filledAt?: string;
  filledPrice?: number;
  filledSize?: number;
}

export interface TradePlanMonitorEvents {
  'plan:activation_step': [planId: string, step: number, total: number];
  'plan:activated': [planId: string];
  'plan:entry_filled': [planId: string, entryOrderId: string, price: number, size: number];
  'plan:tp_hit': [planId: string, tpIndex: number, price: number];
  'plan:sl_hit': [planId: string, price: number];
  'plan:completed': [planId: string];
  'plan:error': [planId: string, error: string];
  'plan:trailing_activated': [planId: string, fromPrice: number];
}

export interface TradePlanMonitorConfig {
  pollIntervalMs?: number;     // Default: 3000
  maxErrorCount?: number;      // Default: 10
  klineLimit?: number;         // Default: 200
  /**
   * Plaene auf Boersen ohne EWR-Zulassung ablehnen. Voreingestellt an —
   * wer bewusst anderswo handeln will, schaltet es ausdruecklich ab.
   */
  nurMicaBoersen?: boolean;
  /** Boerse fuer Plaene, die keine eigene nennen. */
  defaultExchange?: string;
  /**
   * Alles laeuft im Uebungsbetrieb.
   *
   * Der Monitor muss das wissen, obwohl der eigentliche Riegel in
   * `createBroker` sitzt: Sonst prueft er Pläne weiter gegen die Boerse,
   * die im Plan steht. Ein Signal mit `exchange: "phemex"` scheiterte
   * dann an der fehlenden EWR-Zulassung — fuer einen Handel, der gar
   * nicht stattfindet. Und das Protokoll wuerde "phemex" ausweisen,
   * obwohl nichts dorthin ging.
   */
  nurUebungsbetrieb?: boolean;
}

export class TradePlanMonitor extends EventEmitter {
  private states = new Map<string, MonitorState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly evaluator: TriggerEvaluator;
  private readonly klines: KlineFetcher;
  private readonly pollMs: number;
  private readonly maxErrors: number;
  private readonly klineLimit: number;
  private readonly nurMicaBoersen: boolean;
  private readonly defaultExchange: string;
  private readonly nurUebungsbetrieb: boolean;

  constructor(
    private readonly brokers: BrokerRegistry,
    private readonly store: SqliteStore,
    private readonly logger: Logger,
    config: TradePlanMonitorConfig = {},
  ) {
    super();
    this.pollMs = config.pollIntervalMs ?? 3000;
    this.maxErrors = config.maxErrorCount ?? 10;
    this.klineLimit = config.klineLimit ?? 200;
    this.nurMicaBoersen = config.nurMicaBoersen ?? true;
    this.defaultExchange = config.defaultExchange ?? 'paper';
    this.nurUebungsbetrieb = config.nurUebungsbetrieb ?? false;
    this.evaluator = new TriggerEvaluator();
    this.klines = new KlineFetcher({
      cache: {
        get: (symbol, interval) => {
          const cached = store.getIndicatorCache(symbol, interval);
          if (!cached) return undefined;
          return {
            candles: JSON.parse(cached.candles_json) as Candle[],
            lastUpdated: new Date(cached.last_updated_at).getTime(),
          };
        },
        set: (symbol, interval, candles, lastUpdated) => {
          store.setIndicatorCache(symbol, interval, JSON.stringify(candles));
          void lastUpdated;
        },
      },
    });
  }

  // ============================================================
  // Lebenszyklus
  // ============================================================

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loadActiveMonitors();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.logger.info('TradePlanMonitor: gestartet');
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.logger.info('TradePlanMonitor: gestoppt');
  }

  // Plan zur Ueberwachung anmelden
  registerPlan(plan: TradePlan): void {
    if (this.states.has(plan.id)) return;

    const conditions = plan.activation_conditions ?? [];
    const initialStatus: MonitorState['status'] =
      conditions.length > 0 || this.hasAnyTrigger(plan) ? 'waiting_activation' : 'monitoring';

    const bereitsPlatziert = this.resolveTriggeredEntries(plan);

    const state: MonitorState = {
      plan,
      status: initialStatus,
      activationStep: 0,
      tpState: (plan.take_profits ?? []).map((tp, i) => ({
        index: i,
        price: tp.price,
        percentage: getTpPercentage(tp),
        triggered: false,
      })),
      slCurrent: plan.stop_loss_price,
      slType: plan.stop_loss_type ?? 'fixed',
      trailingActive: plan.stop_loss_type === 'trailing',
      trailingBestPrice: null,
      trailingSizePct: plan.trailing_stop_size_pct ?? null,
      // Nicht die geplante Groesse, sondern die tatsaechlich offene:
      // Bei einem frischen Plan ist das 0, bei einem wieder aufgenommenen
      // das, was die Orders hergeben.
      remainingSize: 0,
      lastPrice: null,
      errorCount: 0,
      triggeredEntries: bereitsPlatziert,
      // Ein Plan mit bereits platzierten Einstiegen wurde offenkundig
      // schon einmal freigegeben; nach einem Neustart soll er nicht auf
      // ein zweites Signal warten.
      signalFreigabe: bereitsPlatziert.size > 0,
      einstiegeStorniert: false,
    };

    this.states.set(plan.id, state);
    // Jetzt, da der Zustand steht, die tatsaechlich offene Position
    // nachtragen — ein wieder aufgenommener Plan kann bereits eine haben.
    state.remainingSize = this.offenePosition(state);
    this.persistMonitor(state);
    this.logger.info({
      planId: plan.id, symbol: plan.symbol, status: initialStatus,
      offenePosition: state.remainingSize,
    }, 'Plan registriert');
  }

  /**
   * Nimmt einen Plan aus der Ueberwachung — ohne an der Boerse etwas zu
   * tun.
   *
   * ACHTUNG: Das ist nur dann die richtige Methode, wenn an der Boerse
   * nichts mehr liegt. Liegen noch Orders oder steht eine Position
   * offen, gehoert `beendePlan()` hierher. Wer einen Plan mit offener
   * Position abmeldet, laesst sie ohne Stop-Loss-Ueberwachung zurueck:
   * Niemand zieht den Stop mehr nach, niemand nimmt einen Gewinn mit,
   * und die Position laeuft, bis sie jemand von Hand findet.
   */
  unregisterPlan(planId: string): void {
    const state = this.states.get(planId);
    if (state) {
      state.status = 'cancelled';
      this.persistMonitor(state);
    }
    this.states.delete(planId);
    this.store.deleteMonitor(planId);
  }

  /**
   * Beendet einen Plan ordentlich: erst aufraeumen, dann abmelden.
   *
   * Die Reihenfolge ist zwingend, und zwar in dieser:
   *
   *   1. Offene Position zu Markt schliessen. Zuerst, weil die
   *      Stop-Loss-Order noch liegt: Scheitert das Schliessen, ist die
   *      Position wenigstens weiter abgesichert.
   *   2. Alle verbliebenen Orders zuruecknehmen — Kauf-Limits ebenso
   *      wie die nun gegenstandslosen TP- und SL-Orders.
   *   3. Erst jetzt den Plan abmelden.
   *
   * Schlaegt Schritt 1 fehl, bricht die Methode ab und meldet den Plan
   * NICHT ab. Lieber ein Plan, der sich nicht beenden laesst und das
   * sagt, als eine stillschweigend unbeaufsichtigte Position.
   */
  async beendePlan(
    planId: string,
    grund: 'benutzer_abbruch' | 'benutzer_beendet' = 'benutzer_beendet',
  ): Promise<{ geschlosseneMenge: number; stornierteOrders: number; status: 'cancelled' | 'completed' }> {
    const state = this.states.get(planId);

    // Ohne Zustand im Arbeitsspeicher laesst sich nur aufraeumen, was in
    // der Datenbank steht. Das kommt vor: ein Plan, der nie angemeldet
    // wurde, oder einer nach einem Neustart ohne geladenen Monitor.
    if (!state) {
      const stornierte = await this.storniereAlleOrders(planId);
      this.states.delete(planId);
      this.store.deleteMonitor(planId);
      this.logger.info({ planId, stornierte, grund }, 'Plan beendet (ohne laufende Ueberwachung)');
      return { geschlosseneMenge: 0, stornierteOrders: stornierte, status: 'cancelled' };
    }

    const offen = this.offenePosition(state);
    let geschlossen = 0;

    if (offen > 0) {
      // Wirft weiter, wenn es scheitert — siehe oben.
      geschlossen = await this.schliessePositionZuMarkt(state, offen, grund);
    }

    const stornierte = await this.storniereAlleOrders(planId, state);

    // Ein Plan, der im Markt war, ist abgeschlossen; einer, der es nie
    // war, ist abgebrochen. Der Unterschied steht spaeter im Verlauf.
    const status: 'cancelled' | 'completed' =
      this.hatJeEingestiegen(planId) ? 'completed' : 'cancelled';

    state.status = status;
    state.remainingSize = 0;
    this.persistMonitor(state);

    this.states.delete(planId);
    this.store.deleteMonitor(planId);

    this.emit(status === 'completed' ? 'plan:completed' : 'plan:cancelled', planId);
    this.logger.info({
      planId, geschlossen, stornierte, status, grund,
    }, 'Plan beendet');

    return { geschlosseneMenge: geschlossen, stornierteOrders: stornierte, status };
  }

  /**
   * Plan-Update vom TC-Sync. Bei aktivem Trade (remainingSize < total_size):
   * cancelled offene TP/SL-Orders und re-setzt sie aus dem neuen Plan.
   */
  async updatePlan(plan: TradePlan): Promise<void> {
    const state = this.states.get(plan.id);
    if (!state) {
      this.registerPlan(plan);
      return;
    }

    const wasActive = state.remainingSize < plan.total_size;

    // TP-Liste neu aus Plan aufbauen, aber bereits gefuellte TPs behalten
    const newTps = plan.take_profits ?? [];
    const oldTpState = state.tpState;
    state.tpState = newTps.map((tp, i) => {
      const oldEntry = oldTpState.find(t => Math.abs(t.price - tp.price) / tp.price < 0.001);
      return oldEntry ? { ...oldEntry, percentage: getTpPercentage(tp) } : {
        index: i,
        price: tp.price,
        percentage: getTpPercentage(tp),
        triggered: false,
      };
    });

    // SL-Update — nur wenn nicht in trailing
    if (!state.trailingActive) {
      state.slCurrent = plan.stop_loss_price;
      state.slType = plan.stop_loss_type ?? 'fixed';
    }

    // Plan-Referenz aktualisieren. Der Ausfuehrungsstand wird dabei nur
    // erweitert, nie zurueckgesetzt — ein bereits platzierter Einstieg darf
    // durch eine Plan-Aenderung nicht wieder als offen gelten.
    state.plan = plan;
    for (const id of this.resolveTriggeredEntries(plan)) {
      state.triggeredEntries.add(id);
    }

    if (wasActive) {
      // Bei aktivem Trade: alte TP/SL Broker-Orders cancellen → werden vom Polling-Loop neu gesetzt
      const orders = this.store.getPlanOrders(plan.id);
      const openTpSl = orders.filter(o => {
        const isOpen = ['new', 'placed', 'partially_filled'].includes(o.status as string);
        const isTpSl = ['take_profit', 'stop_loss', 'trailing_stop'].includes(o.role as string);
        return isOpen && isTpSl;
      });
      for (const o of openTpSl) {
        const brokerOrderId = o.broker_order_id as string | null;
        if (!brokerOrderId) continue;
        try {
          const broker = await this.brokerFor(plan);
          await broker.cancelOrder(plan.symbol, brokerOrderId);
          this.store.updatePlanOrder(o.id as string, { status: 'cancelled' });
        } catch (err) {
          this.logger.warn({ err, orderId: o.id }, 'TP/SL-Cancel beim Plan-Update fehlgeschlagen');
        }
      }
      this.logger.info({ planId: plan.id, cancelledOrders: openTpSl.length }, 'Plan-Update angewendet — TP/SL re-placed beim naechsten Tick');
    }

    this.persistMonitor(state);
  }

  getState(planId: string): MonitorState | undefined {
    return this.states.get(planId);
  }

  getAllStates(): MonitorState[] {
    return Array.from(this.states.values());
  }

  // ============================================================
  // Polling-Loop
  // ============================================================

  private async poll(): Promise<void> {
    if (!this.running || this.states.size === 0) return;

    // Kurse je Boerse UND Symbol holen: Dasselbe Kuerzel steht an
    // verschiedenen Boersen unterschiedlich, und ein Plan muss gegen den
    // Kurs der Boerse laufen, auf der er auch ausgefuehrt wird.
    const abzufragen = new Map<string, { exchangeId: string; symbol: string; plan: TradePlan }>();
    for (const s of this.states.values()) {
      if (s.status === 'completed' || s.status === 'cancelled' || s.status === 'error') continue;
      const exchangeId = this.exchangeOf(s.plan);
      abzufragen.set(`${exchangeId}|${s.plan.symbol}`, {
        exchangeId, symbol: s.plan.symbol, plan: s.plan,
      });
    }

    const priceMap = new Map<string, number>();
    await Promise.allSettled([...abzufragen.entries()].map(async ([key, { symbol, plan }]) => {
      const broker = await this.brokerFor(plan);
      const price = await broker.getPrice(symbol);
      if (price != null) priceMap.set(key, price);
    }));

    // Pro Plan abarbeiten
    for (const state of this.states.values()) {
      if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'error') continue;
      const price = priceMap.get(`${this.exchangeOf(state.plan)}|${state.plan.symbol}`);
      if (price == null) continue;

      try {
        state.lastPrice = price;
        await this.processPlan(state, price);
      } catch (err) {
        state.errorCount++;
        state.status = state.errorCount >= this.maxErrors ? 'error' : state.status;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ planId: state.plan.id, err: msg }, 'Plan-Polling-Fehler');
        if (state.errorCount >= this.maxErrors) {
          this.emit('plan:error', state.plan.id, msg);
        }
      }
      this.persistMonitor(state);
    }
  }

  // ============================================================
  // Pro-Plan Verarbeitung
  // ============================================================

  private async processPlan(state: MonitorState, currentPrice: number): Promise<void> {
    const plan = state.plan;

    // 0. Cancelled → Order-Cleanup (innerhalb von 30s)
    if (plan.status === 'cancelled') {
      await this.cancelAllOrdersForPlan(state);
      state.status = 'cancelled';
      return;
    }

    // 0b. Completed → unregister
    if (plan.status === 'completed') {
      state.status = 'completed';
      return;
    }

    // 0c. Planned → Bot ignoriert (User editiert noch)
    if (plan.status === 'planned') {
      return;
    }

    // 1. Activation Conditions (Bitmask, in beliebiger Reihenfolge)
    const conditions = plan.activation_conditions ?? [];
    if (conditions.length > 0) {
      this.updateActivationStep(state, currentPrice, conditions);
      // Wenn nicht alle Bits gesetzt → noch nicht aktiv
      const allMask = (1 << conditions.length) - 1;
      if (state.activationStep !== allMask) {
        return;
      }
    }

    // 2. Wenn waiting_activation → jetzt executing (v1.1: monitoring deprecated)
    if (state.status === 'waiting_activation') {
      state.status = 'monitoring';  // intern bleibt monitoring fuer Backwards-Compat
      this.emit('plan:activated', plan.id);
      this.logger.info({ planId: plan.id }, 'Plan aktiviert (executing)');
    }

    // 3. Entry-Orders pruefen (Trigger evaluieren falls vorhanden)
    await this.processEntries(state, currentPrice);

    // 3b. Sind platzierte Einstiegs-Limits inzwischen gefuellt worden?
    //
    // Ohne diese Abfrage erfuehre der Bot nie davon: Eine Limit-Order
    // liegt an der Boerse, und niemand sieht nach. Die offene Position
    // waere dann reine Annahme — und genau daran haengen Take-Profits
    // und Stop.
    await this.pruefeEinstiegsFills(state);

    // 4. TPs pruefen — nur wenn tatsaechlich eine Position offen ist.
    //
    // Frueher stand hier `remainingSize > 0`, und remainingSize begann
    // bei der GEPLANTEN Groesse. Ein Take-Profit feuerte deshalb, sobald
    // sein Preis erreicht war, auch ohne einen einzigen gefuellten
    // Einstieg: Der Bot "nahm Gewinn mit" aus einer Position, die es nie
    // gab. Im Uebungsbetrieb entstand daraus eine Gegenposition, im
    // Echthandel ein falscher Protokolleintrag.
    if (this.offenePosition(state) > 0) {
      await this.processTakeProfits(state, currentPrice);
    }

    // 4b. Nachlauf: Liess sich eine Einstiegs-Order beim Take-Profit
    // nicht zuruecknehmen — etwa weil die Boerse gerade nicht erreichbar
    // war —, wird es hier erneut versucht. Ohne diesen Nachlauf bliebe
    // ein Kauf-Limit liegen und koennte Stunden spaeter in eine Position
    // hinein zuschlagen, die bereits abgebaut wird.
    if (this.istEinstiegsphaseBeendet(state) && !state.einstiegeStorniert) {
      await this.storniereOffeneEinstiege(state);
    }

    // 5. Trailing-Stop nachziehen — nur bei offener Position.
    if (state.trailingActive && this.offenePosition(state) > 0) {
      this.updateTrailingStop(state, currentPrice);
    }

    // 6. SL-Hit pruefen — ebenfalls nur bei offener Position.
    //
    // Ein Stop ohne Position haette dieselbe Wirkung wie ein Take-Profit
    // ohne Position: eine Order in der Gegenrichtung, die eroeffnet
    // statt zu schliessen.
    if (state.slCurrent != null && this.offenePosition(state) > 0) {
      this.processStopLoss(state, currentPrice);
    }

    // 7. Plan-Completion
    //
    // Abgeschlossen ist ein Plan, wenn er einmal im Markt war und jetzt
    // nichts mehr offen ist. Beide Bedingungen sind noetig:
    //
    //   - "nichts mehr offen" allein genuegt nicht. Ein frisch
    //     angelegter Plan hat noch keine Position; er waere damit vom
    //     ersten Durchlauf an abgeschlossen und wuerde nie handeln.
    //   - "alle Take-Profits erreicht" waere zu streng. Nach dem
    //     Zuruecknehmen der Einstiege ist die Position regelmaessig zu,
    //     waehrend spaetere Ziele nie erreicht wurden — sie koennten
    //     auch nichts mehr schliessen.
    if (state.remainingSize <= 0 && state.status === 'monitoring' &&
        this.hatJeEingestiegen(plan.id)) {
      const alleTpsErreicht = state.tpState.every(t => t.triggered);
      state.status = 'completed';
      this.emit('plan:completed', plan.id);
      this.logger.info({
        planId: plan.id,
        alleTpsErreicht,
        offeneTps: state.tpState.filter(t => !t.triggered).length,
      }, alleTpsErreicht
        ? 'Plan abgeschlossen'
        : 'Plan abgeschlossen — Position vollstaendig geschlossen, spaetere Take-Profits entfallen');
    }
  }

  // ============================================================
  // Activation Step (Bitmask, jede Condition = 1 Bit)
  // ============================================================

  private updateActivationStep(state: MonitorState, currentPrice: number, conditions: ActivationCondition[]): void {
    let updated = false;
    const plan = state.plan;
    const direction = plan.direction;

    // Niedrigsten Entry-Preis ermitteln (fuer Direction-Logic, TC-Spec)
    const entries = plan.entry_orders ?? [];
    const lowestEntryPrice = entries.length > 0
      ? Math.min(...entries.map(e => e.price))
      : 0;
    const tolerance = 0.0025; // 0.25% laut TC-Doku

    for (let i = 0; i < conditions.length; i++) {
      const bit = 1 << i;
      if ((state.activationStep & bit) !== 0) continue;

      const c = conditions[i]!;
      let met = false;

      if (c.price !== undefined) {
        const activationPrice = c.price;
        // Direction-Logic laut Doku Section 2.5:
        // Wenn activation >= lowest_entry → Preis MUSS FALLEN zur Entry
        //   - Long:  price <= activation_price * (1 + tolerance)
        //   - Short: price >= activation_price * (1 - tolerance)
        // Wenn activation < lowest_entry → Preis MUSS STEIGEN zur Entry
        //   - Long:  price >= activation_price * (1 - tolerance)
        //   - Short: price <= activation_price * (1 + tolerance)
        if (lowestEntryPrice === 0) {
          // Fallback: einfaches Cross
          met = this.crossedPrice(state, currentPrice, activationPrice) ||
                Math.abs(currentPrice - activationPrice) <= activationPrice * tolerance;
        } else if (activationPrice >= lowestEntryPrice) {
          // Preis muss fallen
          met = direction === 'long'
            ? currentPrice <= activationPrice * (1 + tolerance)
            : currentPrice >= activationPrice * (1 - tolerance);
        } else {
          // Preis muss steigen
          met = direction === 'long'
            ? currentPrice >= activationPrice * (1 - tolerance)
            : currentPrice <= activationPrice * (1 + tolerance);
        }
      } else if (c.type === 'price_above') {
        met = c.value != null && currentPrice >= c.value;
      } else if (c.type === 'price_below') {
        met = c.value != null && currentPrice <= c.value;
      } else if (c.type === 'immediate') {
        met = true;
      }

      if (met) {
        state.activationStep |= bit;
        updated = true;
        this.emit('plan:activation_step', state.plan.id, i + 1, conditions.length);
        this.logger.info({
          planId: state.plan.id, step: i + 1, total: conditions.length,
          price: currentPrice, target: c.price,
        }, 'Activation-Schritt erreicht');
      }
    }
    if (updated) this.persistMonitor(state);
  }

  private crossedPrice(state: MonitorState, currentPrice: number, target: number): boolean {
    if (state.lastPrice == null) return false;
    return (state.lastPrice <= target && currentPrice >= target) ||
           (state.lastPrice >= target && currentPrice <= target);
  }

  // ============================================================
  // Cancelled-Plan: Alle offenen Orders auf der Boerse cancellen
  // ============================================================
  private async cancelAllOrdersForPlan(state: MonitorState): Promise<void> {
    const plan = state.plan;
    const orders = this.store.getPlanOrders(plan.id);
    const openStatuses = new Set(['new', 'placed', 'partially_filled']);
    const openOrders = orders.filter(o => openStatuses.has(o.status as string));

    if (openOrders.length === 0) {
      // Schon nichts mehr offen, kein Audit-Spam
      return;
    }

    this.logger.info({ planId: plan.id, count: openOrders.length }, 'Plan cancelled — schliesse offene Orders');

    for (const order of openOrders) {
      const brokerOrderId = order.broker_order_id as string | null;
      if (!brokerOrderId) continue;
      try {
        const broker = await this.brokerFor(plan);
        await broker.cancelOrder(plan.symbol, brokerOrderId);
        this.store.updatePlanOrder(order.id as string, { status: 'cancelled' });

        this.store.insertExecutionReport({
          plan_id: plan.id,
          entry_order_id: order.entry_order_id as string | null,
          symbol: plan.symbol,
          side: order.side as string,
          order_type: order.order_type as string,
          status: 'cancelled',
          broker: broker.name,
          broker_order_id: brokerOrderId,
          bot_firmware: BOT_FIRMWARE,
          device_id: BOT_DEVICE_ID,
          metadata: {
            role: order.role as string,
            reason: 'plan_cancelled',
          },
          executed_at: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.warn({ err, orderId: order.id }, 'Order-Cancel fehlgeschlagen');
      }
    }
  }

  /**
   * Haelt die Fuellung einer sofort ausgefuehrten Order fest.
   *
   * `insertPlanOrder` schreibt nur, was bei der Aufgabe bekannt war —
   * `filled_quantity` und `avg_fill_price` bleiben dabei leer. Fuer
   * Einstiege wurde das immer nachgetragen, fuer Take-Profit und Stop
   * nicht. Daran haengt mehr als eine Anzeige: `offenePosition()` zieht
   * genau diese Spalte ab.
   */
  private merkeFuellung(orderId: string, result: OrderResult): void {
    if (result.filledQuantity <= 0) return;
    this.store.updatePlanOrder(orderId, {
      status: result.status,
      filled_quantity: result.filledQuantity,
      avg_fill_price: result.avgFillPrice,
    });
  }

  /**
   * Schliesst die offene Position eines Plans zu Markt.
   *
   * Gibt die geschlossene Menge zurueck und wirft, wenn die Order nicht
   * durchgeht — der Aufrufer muss das erfahren, statt den Plan fuer
   * erledigt zu halten.
   */
  private async schliessePositionZuMarkt(
    state: MonitorState, menge: number, grund: string,
  ): Promise<number> {
    const plan = state.plan;
    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';
    const orderId = randomUUID();
    const clientOrderId = `tc-plan-${plan.id.slice(0, 8)}-ende`;
    const broker = await this.brokerFor(plan);

    const result = await broker.placeOrder({
      symbol: plan.symbol,
      side: exitSide,
      type: 'market',
      quantity: menge,
      clientOrderId,
      reduceOnly: true,
    });

    // Als Stop verbucht, nicht als Take-Profit: Ein Abbruch von Hand ist
    // kein erreichtes Ziel. Im Verlauf soll er auch nicht so aussehen.
    this.store.insertPlanOrder({
      id: orderId,
      trade_plan_id: plan.id,
      side: exitSide,
      order_type: 'market',
      role: 'stop_loss',
      symbol: plan.symbol,
      price: state.lastPrice,
      quantity: menge,
      status: result.status,
      broker: broker.name,
      broker_order_id: result.orderId,
      client_order_id: clientOrderId,
    });
    this.merkeFuellung(orderId, result);

    this.store.insertExecutionReport({
      plan_id: plan.id,
      entry_order_id: null,
      symbol: plan.symbol,
      side: exitSide,
      order_type: 'market',
      status: 'filled',
      fill_price: result.avgFillPrice || state.lastPrice,
      fill_quantity: result.filledQuantity || menge,
      broker: broker.name,
      broker_order_id: result.orderId,
      bot_firmware: BOT_FIRMWARE,
      device_id: BOT_DEVICE_ID,
      metadata: { role: 'stop_loss', reason: grund, von_hand: true },
      executed_at: new Date().toISOString(),
    });

    this.logger.info({
      planId: plan.id, menge, preis: result.avgFillPrice, grund,
    }, 'Position zu Markt geschlossen');

    return result.filledQuantity || menge;
  }

  /**
   * Nimmt alle noch offenen Orders eines Plans zurueck — Einstiege wie
   * Ausstiege. Gibt zurueck, wieviele tatsaechlich storniert wurden.
   *
   * Eine misslungene Stornierung wird NICHT als storniert vermerkt: Die
   * Order liegt dann weiter an der Boerse, und das muss aus der
   * Datenbank hervorgehen.
   */
  private async storniereAlleOrders(planId: string, state?: MonitorState): Promise<number> {
    const planRaw = state?.plan ?? this.store.getBotTradePlan(planId);
    if (!planRaw) return 0;
    const plan = state?.plan ?? this.deserializePlan(planRaw as Record<string, unknown>);

    const offeneStatus = new Set(['new', 'placed', 'partially_filled']);
    const offene = this.store.getPlanOrders(planId)
      .filter(o => offeneStatus.has(o.status as string));
    if (offene.length === 0) return 0;

    let storniert = 0;
    for (const order of offene) {
      const brokerOrderId = order.broker_order_id as string | null;

      // Vermerkt, aber nie abgeschickt — nur lokal schliessen.
      if (!brokerOrderId) {
        this.store.updatePlanOrder(order.id as string, { status: 'cancelled' });
        storniert++;
        continue;
      }

      try {
        const broker = await this.brokerFor(plan);
        await broker.cancelOrder(plan.symbol, brokerOrderId);
        this.store.updatePlanOrder(order.id as string, { status: 'cancelled' });
        storniert++;

        this.store.insertExecutionReport({
          plan_id: planId,
          entry_order_id: order.entry_order_id as string | null,
          symbol: plan.symbol,
          side: order.side as string,
          order_type: order.order_type as string,
          status: 'cancelled',
          broker: broker.name,
          broker_order_id: brokerOrderId,
          bot_firmware: BOT_FIRMWARE,
          device_id: BOT_DEVICE_ID,
          metadata: { role: order.role as string, reason: 'plan_beendet' },
          executed_at: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.warn({
          err, orderId: order.id, planId,
        }, 'Order liess sich beim Beenden nicht zuruecknehmen — sie liegt weiter an der Boerse');
      }
    }

    return storniert;
  }

  // ============================================================
  // Entry-Orders mit Trigger-Auswertung
  // ============================================================

  private async processEntries(state: MonitorState, currentPrice: number): Promise<void> {
    const plan = state.plan;
    const entries = plan.entry_orders ?? [];

    // Ist schon Gewinn mitgenommen worden, wird nicht mehr nachgekauft.
    // Siehe istEinstiegsphaseBeendet() — die Regel steht dort begruendet.
    if (this.istEinstiegsphaseBeendet(state)) {
      return;
    }

    // Wartet der Plan auf die Freigabe durch ein externes Signal, bleiben
    // alle Einstiege gesperrt, bis sie vorliegt. Das geschieht vor der
    // Preispruefung: Ein Plan, der nicht handeln darf, soll gar nicht erst
    // nachsehen, ob sein Einstieg getroffen waere.
    if (plan.signal_trigger && !state.signalFreigabe) {
      if (!this.holeSignalFreigabe(state)) {
        this.auditReject(plan, null, 'signal_trigger_ausstehend', 'entry');
        return;
      }
    }

    for (const entry of entries) {
      if (!entry.id) continue;
      if (state.triggeredEntries.has(entry.id)) continue;

      // Preis-Hit pruefen
      const priceHit = this.checkEntryPriceHit(plan.direction, currentPrice, entry.price);
      if (!priceHit) continue;

      // Trigger pruefen falls vorhanden
      if (entry.trigger) {
        const triggerOk = await this.evaluateTrigger(plan.symbol, currentPrice, entry.trigger);
        if (!triggerOk) {
          // Audit-Report: Bot konnte Order wegen Trigger nicht platzieren
          this.auditReject(plan, entry, 'trigger_not_met', 'entry');
          continue;
        }
      }

      // Order ausfuehren
      await this.executeEntryOrder(state, entry, currentPrice);
    }
  }

  // ============================================================
  // Tatsaechlich offene Position
  // ============================================================

  /**
   * Wieviel ist wirklich im Markt?
   *
   * Summe der gefuellten Einstiege minus dessen, was Take-Profits und
   * Stop schon geschlossen haben. Quelle sind die Order-Daten, nicht
   * eine Annahme aus dem Plan.
   *
   * Der Unterschied ist nicht akademisch: `remainingSize` begann frueher
   * bei der GEPLANTEN Groesse. Solange nur Limit-Einstiege anlagen und
   * keiner gefuellt war, galt die Position trotzdem als offen — und ein
   * Take-Profit, dessen Preis erreicht wurde, feuerte in eine Position
   * hinein, die es nie gegeben hatte.
   */
  private offenePosition(state: MonitorState): number {
    const orders = this.store.getPlanOrders(state.plan.id);

    let eingestiegen = 0;
    let geschlossen = 0;

    for (const o of orders) {
      const gefuellt = Number(o.filled_quantity ?? 0);
      if (gefuellt <= 0) continue;

      if (o.role === 'entry') eingestiegen += gefuellt;
      else if (o.role === 'take_profit' || o.role === 'stop_loss' || o.role === 'trailing_stop') {
        geschlossen += gefuellt;
      }
    }

    const offen = eingestiegen - geschlossen;
    // Rechenrauschen abschneiden, wie bei den Mengen ueblich.
    return offen > 1e-9 ? Number(offen.toFixed(10)) : 0;
  }

  /**
   * War dieser Plan ueberhaupt jemals im Markt?
   *
   * Unterscheidet den Plan, der noch auf seinen Einstieg wartet, von
   * dem, der ihn hatte und wieder geschlossen hat. Beide haben eine
   * offene Position von 0 — aber nur der zweite ist fertig.
   */
  private hatJeEingestiegen(planId: string): boolean {
    return this.store.getPlanOrders(planId).some(o =>
      o.role === 'entry' && Number(o.filled_quantity ?? 0) > 0,
    );
  }

  /**
   * Sieht nach, ob platzierte Einstiegs-Limits gefuellt wurden.
   *
   * Eine Limit-Order liegt an der Boerse; ob sie zum Zuge kam, erfaehrt
   * der Bot nur, wenn er fragt. Bisher fragte niemand: Die Order wurde
   * abgeschickt, als "erledigt" vermerkt und vergessen. Die offene
   * Position war damit reine Annahme.
   */
  private async pruefeEinstiegsFills(state: MonitorState): Promise<void> {
    const plan = state.plan;
    const offeneStatus = new Set(['new', 'placed', 'partially_filled']);

    const offeneEinstiege = this.store.getPlanOrders(plan.id).filter(o =>
      o.role === 'entry' && offeneStatus.has(o.status as string) && o.broker_order_id,
    );
    if (offeneEinstiege.length === 0) return;

    let broker: BrokerAdapter;
    try {
      broker = await this.brokerFor(plan);
    } catch {
      return;   // Ohne Zugang laesst sich nichts nachsehen.
    }

    for (const o of offeneEinstiege) {
      try {
        const stand = await broker.getOrder(plan.symbol, o.broker_order_id as string);
        if (!stand) continue;

        const vorher = Number(o.filled_quantity ?? 0);
        if (stand.filledQuantity <= vorher && stand.status === (o.status as string)) continue;

        this.store.updatePlanOrder(o.id as string, {
          status: stand.status,
          filled_quantity: stand.filledQuantity,
          avg_fill_price: stand.avgFillPrice,
        });

        if (stand.status === 'filled' && vorher <= 0) {
          this.store.insertExecutionReport({
            plan_id: plan.id,
            entry_order_id: o.entry_order_id as string | null,
            symbol: plan.symbol,
            side: o.side as string,
            order_type: o.order_type as string,
            status: 'filled',
            fill_price: stand.avgFillPrice,
            fill_quantity: stand.filledQuantity,
            broker: broker.name,
            broker_order_id: stand.orderId,
            bot_firmware: BOT_FIRMWARE,
            device_id: BOT_DEVICE_ID,
            metadata: { role: 'entry', nachtraeglich_erkannt: true },
            executed_at: new Date().toISOString(),
          });

          this.emit(
            'plan:entry_filled', plan.id, String(o.entry_order_id ?? ''),
            stand.avgFillPrice, stand.filledQuantity,
          );
          this.logger.info({
            planId: plan.id, orderId: o.id,
            preis: stand.avgFillPrice, menge: stand.filledQuantity,
          }, 'Einstieg gefuellt');
        }
      } catch (err) {
        this.logger.warn(
          { err, planId: plan.id, orderId: o.id },
          'Stand einer Einstiegs-Order nicht abrufbar',
        );
      }
    }

    // Den Zustand nachziehen, damit die Anzeige stimmt.
    state.remainingSize = this.offenePosition(state);
  }

  // ============================================================
  // Kein Nachkauf nach dem ersten Take-Profit
  // ============================================================

  /**
   * Ist die Einstiegsphase vorbei?
   *
   * Sobald der erste Take-Profit gegriffen hat, wird nicht mehr
   * nachgekauft — weder werden neue Einstiegs-Orders abgeschickt noch
   * bleiben bereits platzierte an der Boerse liegen.
   *
   * Der Grund ist nicht Vorsicht, sondern Rechenbarkeit: Ein Nachkauf
   * nach einer Teilrealisierung verschiebt den durchschnittlichen
   * Einstieg nach oben (Long) und entwertet damit den Stop-Loss, der
   * fuer den urspruenglichen Einstieg bemessen war. Aus einem Trade mit
   * bekanntem Risiko wuerde einer mit unbekanntem — und im ungluecklichen
   * Fall eine Position, die nach mitgenommenem Gewinn groesser ist als
   * vorher.
   *
   * Abgeleitet aus dem TP-Zustand statt aus einem eigenen Merker: Der
   * TP-Zustand wird in `bot_trade_plan_monitors.tp_state` gespeichert und
   * ueberlebt damit einen Neustart. Ein zusaetzliches Flag koennte
   * davon abweichen.
   */
  private istEinstiegsphaseBeendet(state: MonitorState): boolean {
    return state.tpState.some(t => t.triggered);
  }

  /**
   * Nimmt alle Einstiegs-Orders zurueck, die noch nicht gefuellt sind.
   *
   * Wird nach dem ersten Take-Profit aufgerufen. Was hier nicht
   * storniert wird, liegt weiter als Kauf-Limit an der Boerse und kann
   * Stunden spaeter noch zuschlagen — in eine Position hinein, die
   * gerade abgebaut wird.
   *
   * Die noch gar nicht abgeschickten Einstiege brauchen kein Zutun:
   * `processEntries` kommt nach dem ersten TP nicht mehr bis zu ihnen.
   */
  private async storniereOffeneEinstiege(state: MonitorState): Promise<void> {
    const plan = state.plan;
    const offeneStatus = new Set(['new', 'placed', 'partially_filled']);

    const offeneEinstiege = this.store.getPlanOrders(plan.id).filter(o =>
      o.role === 'entry' && offeneStatus.has(o.status as string),
    );

    // Menge, die durch das Stornieren entfaellt: die noch nicht
    // abgeschickten Einstiege und der ungefuellte Teil der platzierten.
    let entfallen = 0;
    let alleZurueckgenommen = true;

    for (const order of offeneEinstiege) {
      const menge = Number(order.quantity ?? 0);
      const gefuellt = Number(order.filled_quantity ?? 0);
      const offenerTeil = Math.max(0, menge - gefuellt);

      const brokerOrderId = order.broker_order_id as string | null;
      if (!brokerOrderId) {
        // Vermerkt, aber nie abgeschickt — nur lokal schliessen.
        this.store.updatePlanOrder(order.id as string, { status: 'cancelled' });
        entfallen += offenerTeil;
        continue;
      }

      try {
        const broker = await this.brokerFor(plan);
        await broker.cancelOrder(plan.symbol, brokerOrderId);
        this.store.updatePlanOrder(order.id as string, { status: 'cancelled' });
        entfallen += offenerTeil;

        this.store.insertExecutionReport({
          plan_id: plan.id,
          entry_order_id: order.entry_order_id as string | null,
          symbol: plan.symbol,
          side: order.side as string,
          order_type: order.order_type as string,
          status: 'cancelled',
          broker: broker.name,
          broker_order_id: brokerOrderId,
          bot_firmware: BOT_FIRMWARE,
          device_id: BOT_DEVICE_ID,
          metadata: { role: 'entry', reason: 'kein_nachkauf_nach_tp' },
          executed_at: new Date().toISOString(),
        });
      } catch (err) {
        // Eine misslungene Stornierung ist ernst: Die Order liegt dann
        // weiter an der Boerse. Sie wird nicht stillschweigend als
        // storniert vermerkt, damit der naechste Durchlauf es erneut
        // versucht — und sie taucht im Protokoll auf.
        alleZurueckgenommen = false;
        this.logger.error(
          { err, planId: plan.id, orderId: order.id, brokerOrderId },
          'Einstiegs-Order liess sich nach dem Take-Profit nicht zuruecknehmen — ' +
          'sie liegt moeglicherweise weiter an der Boerse, der naechste Durchlauf versucht es erneut',
        );
      }
    }

    state.einstiegeStorniert = alleZurueckgenommen;

    // Was storniert wurde, kann nicht mehr in die Position fliessen.
    if (entfallen > 0) {
      state.remainingSize = Math.max(0, state.remainingSize - entfallen);
    }

    // Auch die nie abgeschickten Einstiege zaehlen nicht mehr mit.
    const nieAbgeschickt = (plan.entry_orders ?? [])
      .filter(e => e.id && !state.triggeredEntries.has(e.id))
      .reduce((summe, e) => summe + e.size, 0);
    if (nieAbgeschickt > 0) {
      state.remainingSize = Math.max(0, state.remainingSize - nieAbgeschickt);
    }

    // Alle Einstiege gelten ab jetzt als erledigt. Damit greift die
    // Sperre auch dann, wenn ein Plan-Update spaeter neue Einstiege
    // nachreicht.
    for (const e of plan.entry_orders ?? []) {
      if (e.id) state.triggeredEntries.add(e.id);
    }
    plan.executed_orders = Array.from(state.triggeredEntries);
    this.store.updateBotTradePlanStatus(plan.id, plan.status, JSON.stringify(plan.executed_orders));

    if (offeneEinstiege.length > 0 || nieAbgeschickt > 0) {
      this.logger.info({
        planId: plan.id,
        storniert: offeneEinstiege.length,
        nieAbgeschickt: nieAbgeschickt > 0 ? nieAbgeschickt : undefined,
        entfalleneMenge: entfallen + nieAbgeschickt,
        verbleibendePosition: state.remainingSize,
      }, 'Take-Profit erreicht — Einstiegsphase beendet, kein Nachkauf mehr');
    }
  }

  // ============================================================
  // Freigabe durch ein externes Signal (Weg A)
  // ============================================================

  /**
   * Sucht im Eingangsbuch ein Signal, das diesen Plan freigibt, und
   * verbraucht es.
   *
   * Verbraucht heisst: Ein Signal gibt genau einen Plan frei. Haette ein
   * Signal beliebig viele Plaene geoeffnet, oeffnete ein einziger Alarm
   * alles, was gerade wartet — und aus einem Einstieg wuerden fuenf.
   * Wer das will, schickt fuenf Signale.
   *
   * Das Verbrauchen geschieht in der Datenbank mit der Bedingung
   * `consumed = 0` im UPDATE selbst: Zwei Plaene, die im selben Takt
   * nachsehen, koennen sich nicht beide auf dasselbe Signal berufen.
   */
  private holeSignalFreigabe(state: MonitorState): boolean {
    const plan = state.plan;
    const bedingung = plan.signal_trigger;
    if (!bedingung) return true;

    const hoechstalterMs = (bedingung.max_age_sec ?? 300) * 1000;

    const kandidaten = this.store.getOffeneTriggerSignale({
      strategy: bedingung.strategy,
      // Ohne eigene Angabe gilt das Symbol des Plans — ein Signal zu
      // ETHUSDT soll einen BTCUSDT-Plan nicht freigeben.
      symbol: bedingung.symbol ?? plan.symbol,
      tag: bedingung.tag,
      nichtAelterAlsMs: hoechstalterMs,
    });

    for (const kandidat of kandidaten) {
      if (!this.signalPasstZumPlan(kandidat, plan, bedingung)) continue;

      if (!this.store.verbraucheTrigger(kandidat.id as string)) {
        // Ein anderer Plan war schneller.
        continue;
      }

      state.signalFreigabe = true;
      this.logger.info({
        planId: plan.id,
        signalId: kandidat.signal_id,
        strategie: kandidat.strategy,
        alterSek: Math.round((Date.now() - Number(kandidat.received_ms ?? 0)) / 1000),
      }, 'Plan durch externes Signal freigegeben');
      return true;
    }

    return false;
  }

  /**
   * Passt das Signal inhaltlich zum Plan?
   *
   * Die groben Filter (Strategie, Symbol, Marke, Alter) hat die Abfrage
   * schon angelegt. Hier bleibt die Richtung — und die ist der Grund,
   * aus dem diese Pruefung ueberhaupt getrennt steht: Ein Short-Signal
   * darf keinen Long oeffnen, auch wenn sonst alles zusammenpasst.
   */
  private signalPasstZumPlan(
    signalZeile: Record<string, unknown>,
    plan: TradePlan,
    bedingung: SignalTrigger,
  ): boolean {
    if (bedingung.match_direction === false) return true;

    const richtung = signalZeile.direction as string | null;
    if (!richtung) {
      // Ein reines Freigabe-Signal traegt oft keine Richtung. Dann liegt
      // sie im Plan, und es gibt nichts zu vergleichen.
      return true;
    }
    return richtung === plan.direction;
  }

  private checkEntryPriceHit(direction: string, currentPrice: number, entryPrice: number): boolean {
    // Long: Limit-Buy fillt wenn currentPrice <= entryPrice
    // Short: Limit-Sell fillt wenn currentPrice >= entryPrice
    const tolerance = entryPrice * 0.0001; // 0.01%
    return direction === 'long'
      ? currentPrice <= entryPrice + tolerance
      : currentPrice >= entryPrice - tolerance;
  }

  private async evaluateTrigger(symbol: string, currentPrice: number, trigger: TriggerBlock): Promise<boolean> {
    try {
      const candles = await this.klines.getCandles(symbol, trigger.interval, this.klineLimit);
      if (candles.length < 30) return false;
      const ctx: EvaluationContext = { symbol, candles, currentPrice };
      const result = this.evaluator.evaluate(trigger, ctx);
      return result.passed;
    } catch (err) {
      this.logger.warn({ err, symbol }, 'Trigger-Eval fehlgeschlagen');
      return false;
    }
  }

  private async executeEntryOrder(state: MonitorState, entry: EntryOrder, currentPrice: number): Promise<void> {
    const plan = state.plan;
    const side = plan.direction === 'long' ? 'buy' : 'sell';
    const orderId = randomUUID();
    const entryIndex = (plan.entry_orders ?? []).findIndex(e => e.id === entry.id);
    const clientOrderId = `tc-plan-${plan.id.slice(0, 8)}-entry-${entryIndex >= 0 ? entryIndex : 0}`;

    // ExecutionMode: erste Order Market, Rest Limit (oder alle Limit)
    const executionMode = (plan as { execution_mode?: string }).execution_mode ?? 'all_limit';
    const isFirstEntry = state.triggeredEntries.size === 0;
    const orderType = (executionMode === 'first_market_rest_limit' && isFirstEntry) ? 'market' : 'limit';

    // Vor der ersten Order: Darf und kann dieser Plan auf seiner Boerse
    // ueberhaupt laufen? Ein abgelehnter Plan wird protokolliert, damit der
    // Nutzer den Grund sieht statt nur ausbleibender Orders.
    const boersePruefung = this.pruefeBoerse(plan);
    if (!boersePruefung.ok) {
      this.auditReject(plan, entry, boersePruefung.grund, 'entry');
      this.logger.warn({ planId: plan.id, grund: boersePruefung.grund }, 'Plan auf dieser Boerse nicht ausfuehrbar');
      return;
    }

    try {
      const broker = await this.brokerFor(plan);

      // Leverage setzen (Futures)
      if (plan.market_type === 'futures') {
        await broker.setLeverage(plan.symbol, plan.leverage).catch(err => {
          this.logger.warn({ err }, 'setLeverage fehlgeschlagen — fahre fort');
        });
      }

      const result = await broker.placeOrder({
        symbol: plan.symbol,
        side,
        type: orderType,
        quantity: entry.size,
        price: orderType === 'limit' ? entry.price : undefined,
        clientOrderId,
        reduceOnly: false,
      });

      // In DB persistieren
      this.store.insertPlanOrder({
        id: orderId,
        trade_plan_id: plan.id,
        entry_order_id: entry.id ?? null,
        side,
        order_type: orderType,
        role: 'entry',
        symbol: plan.symbol,
        price: entry.price,
        quantity: entry.size,
        status: result.status,
        broker: broker.name,
        broker_order_id: result.orderId,
        client_order_id: clientOrderId,
      });

      // Falls direkt gefuellt
      if (result.status === 'filled') {
        state.triggeredEntries.add(entry.id!);
        plan.executed_orders = Array.from(state.triggeredEntries);
        this.store.updatePlanOrder(orderId, {
          filled_quantity: result.filledQuantity,
          avg_fill_price: result.avgFillPrice,
        });

        this.store.insertExecutionReport({
          plan_id: plan.id,
          entry_order_id: entry.id!,
          symbol: plan.symbol,
          side,
          order_type: orderType,
          status: 'filled',
          fill_price: result.avgFillPrice,
          fill_quantity: result.filledQuantity,
          broker: broker.name,
          broker_order_id: result.orderId,
          bot_firmware: BOT_FIRMWARE,
          device_id: BOT_DEVICE_ID,
          // Der Index macht den Verlauf lesbar: "E1+E2" statt zweier UUIDs.
          metadata: { role: 'entry', entry_index: entryIndex, entry_preis: entry.price },
          executed_at: new Date().toISOString(),
        });

        this.emit('plan:entry_filled', plan.id, entry.id!, result.avgFillPrice, result.filledQuantity);
        this.logger.info({
          planId: plan.id, entryId: entry.id, price: result.avgFillPrice, size: result.filledQuantity,
        }, 'Entry gefuellt');
      } else {
        // Limit-Order platziert, wartet auf Fill — UUID trotzdem markieren um Doppel-Place zu vermeiden
        state.triggeredEntries.add(entry.id!);
        plan.executed_orders = Array.from(state.triggeredEntries);

        this.store.insertExecutionReport({
          plan_id: plan.id,
          entry_order_id: entry.id!,
          symbol: plan.symbol,
          side,
          order_type: orderType,
          status: 'placed',
          fill_price: null,
          fill_quantity: null,
          broker: broker.name,
          broker_order_id: result.orderId,
          bot_firmware: BOT_FIRMWARE,
          device_id: BOT_DEVICE_ID,
          metadata: { role: 'entry', entry_index: entryIndex, limit_price: entry.price },
          executed_at: new Date().toISOString(),
        });

        this.logger.info({
          planId: plan.id, entryId: entry.id, status: result.status,
        }, 'Entry platziert (wartet auf Fill)');
      }

      // executed_orders persistieren
      this.store.updateBotTradePlanStatus(plan.id, plan.status, JSON.stringify(plan.executed_orders));
      void currentPrice;
    } catch (err) {
      state.errorCount++;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, planId: plan.id, entryId: entry.id }, 'Entry-Placement fehlgeschlagen');
      // Audit-Report: Order-Placement fehlgeschlagen
      this.auditReject(plan, entry, `placement_failed: ${msg.slice(0, 100)}`, 'entry');
    }
  }

  // ============================================================
  // Take Profits mit per-TP SL-Adjust + Trailing-Activation
  // ============================================================

  private async processTakeProfits(state: MonitorState, currentPrice: number): Promise<void> {
    const plan = state.plan;
    const tps = plan.take_profits ?? [];
    if (tps.length === 0) return;

    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i]!;
      const tpState = state.tpState[i];
      if (!tpState || tpState.triggered) continue;

      // Preis-Hit pruefen
      const hit = plan.direction === 'long'
        ? currentPrice >= tp.price
        : currentPrice <= tp.price;
      if (!hit) continue;

      await this.executeTpHit(state, tp, i, currentPrice);
    }
  }

  private async executeTpHit(state: MonitorState, tp: TakeProfit, index: number, currentPrice: number): Promise<void> {
    const plan = state.plan;
    const tpState = state.tpState[index]!;
    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';

    // Ist dies der erste Take-Profit dieses Plans? Dann endet gleich die
    // Einstiegsphase. Vor dem Setzen von tpState.triggered gemerkt, denn
    // danach liesse es sich nicht mehr unterscheiden.
    const istErsterTp = !this.istEinstiegsphaseBeendet(state);

    // TP-Groesse berechnen
    const tpPercentage = getTpPercentage(tp);
    // Der Anteil bezieht sich auf die geplante Gesamtgroesse, geschlossen
    // werden kann aber nur, was tatsaechlich offen ist. Wurden erst zwei
    // von vier Einstiegen gefuellt, darf ein 40-%-Ziel nicht 40 % der
    // vollen Planung verkaufen — sonst dreht die Order die Position.
    const offen = this.offenePosition(state);
    const tpSize = Math.min(offen, plan.total_size * (tpPercentage / 100));
    if (tpSize <= 0) {
      this.logger.debug({
        planId: plan.id, tpIndex: index, offen,
      }, 'Take-Profit uebersprungen — keine Position zum Schliessen');
      return;
    }

    try {
      const orderId = randomUUID();
      const clientOrderId = `tc-plan-${plan.id.slice(0, 8)}-tp-${index}`;
      const broker = await this.brokerFor(plan);
      const result = await broker.placeOrder({
        symbol: plan.symbol,
        side: exitSide,
        type: 'market',
        quantity: tpSize,
        clientOrderId,
        reduceOnly: true,
      });

      this.store.insertPlanOrder({
        id: orderId,
        trade_plan_id: plan.id,
        side: exitSide,
        order_type: 'market',
        role: 'take_profit',
        symbol: plan.symbol,
        price: tp.price,
        quantity: tpSize,
        status: result.status,
        broker: broker.name,
        broker_order_id: result.orderId,
        client_order_id: clientOrderId,
      });

      // Die Fuellung festhalten — wie bei den Einstiegen auch.
      //
      // Ohne diesen Schritt bliebe filled_quantity auf 0, und
      // `offenePosition()` zieht genau diese Spalte ab: Eine mitgenommene
      // Teilrealisierung waere aus den Orders nicht ablesbar. Nach einem
      // Neustart laedt der Monitor die offene Position aus den Orders —
      // der Plan erschiene mit voller Position, obwohl sie laengst
      // teilweise geschlossen ist.
      this.merkeFuellung(orderId, result);

      // State aktualisieren
      tpState.triggered = true;
      tpState.filledAt = new Date().toISOString();
      tpState.filledPrice = result.avgFillPrice || currentPrice;
      tpState.filledSize = tpSize;
      state.remainingSize -= tpSize;

      // Sofort festhalten, nicht erst am Ende des Durchlaufs.
      //
      // An diesem Merker haengt die Regel "kein Nachkauf nach dem ersten
      // Take-Profit": Sie leitet sich allein aus dem gespeicherten
      // TP-Zustand ab. Stuerzte der Bot zwischen dem Fuellen und dem
      // Speichern ab, wuesste er nach dem Hochfahren nichts von der
      // Teilrealisierung — und kaufte in die abgebaute Position nach.
      this.persistMonitor(state);

      this.store.insertExecutionReport({
        plan_id: plan.id,
        entry_order_id: null,                  // TP/SL haben keine entry-UUID
        symbol: plan.symbol,
        side: exitSide,
        order_type: 'market',
        status: 'filled',
        fill_price: result.avgFillPrice ?? currentPrice,
        fill_quantity: tpSize,
        broker: broker.name,
        broker_order_id: result.orderId,
        bot_firmware: BOT_FIRMWARE,
        device_id: BOT_DEVICE_ID,
        metadata: { role: 'take_profit', tp_index: index, tp_price: tp.price },
        executed_at: new Date().toISOString(),
      });

      this.emit('plan:tp_hit', plan.id, index, currentPrice);
      this.logger.info({
        planId: plan.id, tpIndex: index, price: currentPrice, size: tpSize,
      }, 'TP gehit');

      // Per-TP SL-Adjustment
      if (tp.sl_adjust && tp.sl_new_price != null) {
        const vorher = state.slCurrent;
        state.slCurrent = tp.sl_new_price;
        state.slType = 'fixed';

        // Auch ins Ausfuehrungsprotokoll, nicht nur ins Logbuch.
        //
        // Das Nachziehen des Stops ist ein Ereignis des Trades und
        // gehoert in seinen Verlauf — "E1+E2 → TP1 → neuer SL" laesst
        // sich sonst nicht rekonstruieren. An der Boerse hinterlaesst
        // es keine Spur: Der Bot haelt den Stop selbst und schickt erst
        // beim Ausloesen eine Order.
        this.protokolliereEreignis(plan, 'sl_adjusted', {
          tp_index: index,
          sl_vorher: vorher,
          sl_neu: tp.sl_new_price,
        });

        this.logger.info({
          planId: plan.id, tpIndex: index, vorher, newSl: tp.sl_new_price,
        }, 'SL nach TP angepasst');
      }

      // Per-TP Trailing-Activation
      if (tp.activate_trailing && tp.trailing_pct != null && tp.trailing_pct > 0) {
        state.trailingActive = true;
        state.slType = 'trailing';
        state.trailingBestPrice = currentPrice;
        plan.trailing_stop_pct = tp.trailing_pct;

        this.protokolliereEreignis(plan, 'trailing_activated', {
          tp_index: index,
          trailing_pct: tp.trailing_pct,
          ab_preis: currentPrice,
        });

        this.emit('plan:trailing_activated', plan.id, currentPrice);
        this.logger.info({
          planId: plan.id, tpIndex: index, pct: tp.trailing_pct,
        }, 'Trailing-Stop aktiviert');
      }

      // Zuletzt, weil es ueber das Netz geht: Nach dem ersten
      // Take-Profit werden die offenen Kauf-Limits zurueckgenommen. Die
      // Anpassungen oben sind reine Zustandsaenderungen und damit schon
      // wirksam, sollte das Zuruecknehmen haengen.
      if (istErsterTp) {
        try {
          await this.storniereOffeneEinstiege(state);
        } catch (err) {
          // Darf den TP-Pfad nicht abbrechen. Beim naechsten Durchlauf
          // greift der Nachlauf in processPlan erneut.
          this.logger.error(
            { err, planId: plan.id },
            'Zuruecknehmen der Einstiegs-Orders nach dem Take-Profit fehlgeschlagen',
          );
        }
      }
    } catch (err) {
      state.errorCount++;
      this.logger.error({ err, planId: plan.id, tpIndex: index }, 'TP-Order fehlgeschlagen');
    }
  }

  // ============================================================
  // Trailing-Stop
  // ============================================================

  private updateTrailingStop(state: MonitorState, currentPrice: number): void {
    const plan = state.plan;
    const pct = plan.trailing_stop_pct;
    if (pct == null || pct <= 0) return;

    const isLong = plan.direction === 'long';
    const best = state.trailingBestPrice;

    // Ersten besten Preis setzen
    if (best == null) {
      state.trailingBestPrice = currentPrice;
      state.slCurrent = isLong
        ? currentPrice * (1 - pct / 100)
        : currentPrice * (1 + pct / 100);
      return;
    }

    // Bei Verbesserung Best-Price + SL nachziehen
    const improved = isLong ? currentPrice > best : currentPrice < best;
    if (improved) {
      state.trailingBestPrice = currentPrice;
      const newSl = isLong
        ? currentPrice * (1 - pct / 100)
        : currentPrice * (1 + pct / 100);
      // SL nur in Profit-Richtung verschieben
      if (state.slCurrent == null ||
          (isLong && newSl > state.slCurrent) ||
          (!isLong && newSl < state.slCurrent)) {
        state.slCurrent = newSl;
      }
    }
  }

  // ============================================================
  // Stop-Loss-Hit
  // ============================================================

  private processStopLoss(state: MonitorState, currentPrice: number): void {
    if (state.slCurrent == null) return;
    const plan = state.plan;
    const hit = plan.direction === 'long'
      ? currentPrice <= state.slCurrent
      : currentPrice >= state.slCurrent;
    if (!hit) return;

    void this.executeStopLossHit(state, currentPrice);
  }

  private async executeStopLossHit(state: MonitorState, currentPrice: number): Promise<void> {
    const plan = state.plan;
    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';
    // Auch der Stop schliesst nur, was offen ist.
    const closeSize = this.offenePosition(state);
    if (closeSize <= 0) {
      this.logger.debug({ planId: plan.id }, 'Stop uebersprungen — keine Position zum Schliessen');
      return;
    }

    try {
      const orderId = randomUUID();
      const clientOrderId = `tc-plan-${plan.id.slice(0, 8)}-sl-0`;
      const broker = await this.brokerFor(plan);
      const result = await broker.placeOrder({
        symbol: plan.symbol,
        side: exitSide,
        type: 'market',
        quantity: closeSize,
        clientOrderId,
        reduceOnly: true,
      });

      this.store.insertPlanOrder({
        id: orderId,
        trade_plan_id: plan.id,
        side: exitSide,
        order_type: 'market',
        role: state.trailingActive ? 'trailing_stop' : 'stop_loss',
        symbol: plan.symbol,
        price: state.slCurrent,
        quantity: closeSize,
        status: result.status,
        broker: broker.name,
        broker_order_id: result.orderId,
        client_order_id: clientOrderId,
      });

      // Siehe `merkeFuellung`: ohne diesen Schritt bliebe die Position
      // in den Orders offen, obwohl der Stop sie geschlossen hat.
      this.merkeFuellung(orderId, result);

      this.store.insertExecutionReport({
        plan_id: plan.id,
        entry_order_id: null,
        symbol: plan.symbol,
        side: exitSide,
        order_type: 'market',
        status: 'filled',
        fill_price: result.avgFillPrice ?? currentPrice,
        fill_quantity: closeSize,
        broker: broker.name,
        broker_order_id: result.orderId,
        bot_firmware: BOT_FIRMWARE,
        device_id: BOT_DEVICE_ID,
        metadata: { role: 'stop_loss', sl_price: state.slCurrent, trailing: state.trailingActive },
        executed_at: new Date().toISOString(),
      });

      state.remainingSize = 0;
      state.status = 'completed';
      this.emit('plan:sl_hit', plan.id, currentPrice);
      this.logger.info({
        planId: plan.id, price: currentPrice, slPrice: state.slCurrent,
      }, 'SL ausgeloest — Plan abgeschlossen');
    } catch (err) {
      state.errorCount++;
      this.logger.error({ err, planId: plan.id }, 'SL-Order fehlgeschlagen');
    }
  }

  // ============================================================
  // Persistenz
  // ============================================================

  private persistMonitor(state: MonitorState): void {
    this.store.upsertMonitor({
      trade_plan_id: state.plan.id,
      status: state.status,
      activation_step: state.activationStep,
      tp_state: JSON.stringify(state.tpState),
      sl_current: state.slCurrent,
      sl_type_current: state.slType,
      trailing_active: state.trailingActive,
      trailing_best_price: state.trailingBestPrice,
      trailing_size_pct: state.trailingSizePct,
      remaining_size: state.remainingSize,
      last_price: state.lastPrice,
      error_count: state.errorCount,
    });
  }

  private loadActiveMonitors(): void {
    const monitors = this.store.getAllMonitors();
    for (const m of monitors) {
      const planRaw = this.store.getBotTradePlan(m.trade_plan_id as string);
      if (!planRaw) continue;
      const plan = this.deserializePlan(planRaw);
      const bereitsPlatziert = this.resolveTriggeredEntries(plan);
      const state: MonitorState = {
        plan,
        status: (m.status as MonitorState['status']) ?? 'monitoring',
        activationStep: (m.activation_step as number) ?? 0,
        tpState: JSON.parse((m.tp_state as string) ?? '[]') as TpStateEntry[],
        slCurrent: m.sl_current as number | null,
        slType: ((m.sl_type_current as string) ?? 'fixed') as 'fixed' | 'trailing',
        trailingActive: !!m.trailing_active,
        trailingBestPrice: m.trailing_best_price as number | null,
        trailingSizePct: m.trailing_size_pct as number | null,
        // Wird gleich aus den Orders berichtigt; der gespeicherte Wert
        // dient nur als Ausgangspunkt.
        remainingSize: (m.remaining_size as number) ?? 0,
        lastPrice: m.last_price as number | null,
        errorCount: (m.error_count as number) ?? 0,
        triggeredEntries: bereitsPlatziert,
        signalFreigabe: bereitsPlatziert.size > 0,
        einstiegeStorniert: false,
      };
      this.states.set(plan.id, state);
      state.remainingSize = this.offenePosition(state);
    }
    this.logger.info({ count: this.states.size }, 'Aktive Monitor-Zustaende geladen');
  }

  // ============================================================
  // Boersen-Zuordnung
  // ============================================================

  /**
   * Liefert den Zugang zu der Boerse, auf der dieser Plan laufen soll.
   *
   * Jeder Plan traegt seine Boerse mit sich. Frueher lief alles ueber die
   * eine in der Konfiguration hinterlegte — ein Plan fuer Kraken wurde
   * dann stillschweigend auf Phemex gehandelt.
   */
  private async brokerFor(plan: TradePlan): Promise<BrokerAdapter> {
    const exchangeId = this.exchangeOf(plan);
    return this.brokers.get(exchangeId, plan.market_type);
  }

  private exchangeOf(plan: TradePlan): string {
    // Im Uebungsbetrieb geht nichts an eine Boerse — gleich welche der
    // Plan nennt. Die Angabe hier bleibt deshalb auch im Protokoll
    // 'paper'; die vorgesehene Boerse steht weiter im Plan.
    if (this.nurUebungsbetrieb) return 'paper';

    const genannt = plan.exchange?.trim().toLowerCase();
    // 'unknown' liefert die Journal-Schnittstelle, wenn dem Plan kein
    // Boersen-Konto zugeordnet ist.
    if (!genannt || genannt === 'unknown') return this.defaultExchange;
    return genannt;
  }

  /**
   * Prueft vor der ersten Order, ob dieser Plan auf seiner Boerse ueberhaupt
   * laufen darf und kann.
   *
   * Lieber hier ablehnen als bei der Order: Der Grund ist an dieser Stelle
   * noch benennbar, spaeter kommt nur eine Fehlermeldung der Boerse zurueck.
   */
  private pruefeBoerse(plan: TradePlan): { ok: true } | { ok: false; grund: string } {
    const exchangeId = this.exchangeOf(plan);
    if (exchangeId === 'paper') return { ok: true };

    if (this.nurMicaBoersen && !isMicaCompliant(exchangeId)) {
      return {
        ok: false,
        grund: `Fuer "${exchangeId}" ist keine EWR-Zulassung hinterlegt. ` +
               `Der Bot handelt nur auf zugelassenen Boersen (abschaltbar ueber NUR_MICA_BOERSEN=false).`,
      };
    }

    return checkMarketSupport(exchangeId, plan.market_type);
  }

  /**
   * Ermittelt, welche Einstiegs-Orders eines Plans bereits herausgegangen sind.
   *
   * Zwei Quellen, beide lokal: das gespeicherte Feld am Plan und die
   * tatsaechlich abgeschickten Orders. Die zweite Quelle faengt den Fall ab,
   * dass der Bot zwischen dem Absetzen einer Order und dem Speichern des
   * Plans ausfaellt — ohne sie wuerde derselbe Einstieg nach einem Neustart
   * ein zweites Mal platziert.
   */
  private resolveTriggeredEntries(plan: TradePlan): Set<string> {
    const ids = new Set<string>(plan.executed_orders ?? []);

    for (const order of this.store.getPlanOrders(plan.id)) {
      if (order.role !== 'entry') continue;
      if (order.status === 'cancelled' || order.status === 'rejected') continue;
      const entryOrderId = order.entry_order_id as string | null;
      if (entryOrderId) ids.add(entryOrderId);
    }

    return ids;
  }

  private deserializePlan(row: Record<string, unknown>): TradePlan {
    return {
      id: row.id as string,
      source: (row.source as 'tc' | 'local' | 'signal') ?? 'local',
      exchange: row.exchange as string,
      exchange_account_id: row.exchange_account_id as string | null,
      symbol: row.symbol as string,
      asset_symbol: row.asset_symbol as string,
      quote_currency: (row.quote_currency as string) ?? 'USDT',
      market_type: row.market_type as 'spot' | 'futures',
      direction: row.direction as 'long' | 'short',
      leverage: row.leverage as number,
      total_size: row.total_size as number,
      total_margin: row.total_margin as number | null,
      entry_strategy: row.entry_strategy as 'single' | 'equal' | 'ascending' | 'descending' | 'custom',
      entry_orders: JSON.parse((row.entry_orders as string) ?? '[]'),
      entry_zones: row.entry_zones ? JSON.parse(row.entry_zones as string) : null,
      take_profits: JSON.parse((row.take_profits as string) ?? '[]'),
      stop_loss_price: row.stop_loss_price as number | null,
      stop_loss_type: ((row.stop_loss_type as string) ?? 'fixed') as 'fixed' | 'trailing',
      trailing_stop_pct: row.trailing_stop_pct as number | null,
      trailing_stop_activation: row.trailing_stop_activation as number | null,
      trailing_stop_size_pct: row.trailing_stop_size_pct as number | null,
      activation_conditions: JSON.parse((row.activation_conditions as string) ?? '[]'),
      signal_trigger: this.leseSignalTrigger(row),
      executed_orders: JSON.parse((row.executed_orders as string) ?? '[]'),
      status: row.status as TradePlan['status'],
      bot_enabled: !!row.bot_enabled,
      notes: row.notes as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  /**
   * Liest die Signal-Bedingung eines Plans.
   *
   * Eine unlesbare Bedingung wird als "keine" gelesen — und das ist die
   * unsichere Richtung: Der Plan handelte dann ohne die Freigabe, auf die
   * er warten sollte. Darum wird in diesem Fall eine Bedingung
   * zurueckgegeben, die nie zutrifft, und der Fall protokolliert.
   */
  private leseSignalTrigger(row: Record<string, unknown>): SignalTrigger | null {
    const roh = row.signal_trigger as string | null | undefined;
    if (!roh) return null;
    try {
      return JSON.parse(roh) as SignalTrigger;
    } catch {
      this.logger.error(
        { planId: row.id },
        'Signal-Bedingung des Plans ist unlesbar — der Plan bleibt gesperrt',
      );
      return { tag: '__unlesbar__' };
    }
  }

  private hasAnyTrigger(plan: TradePlan): boolean {
    for (const e of plan.entry_orders ?? []) if (e.trigger) return true;
    for (const z of plan.entry_zones ?? []) if (z.trigger) return true;
    return false;
  }

  /**
   * Haelt fest, dass der Bot eine Aktion NICHT ausgefuehrt hat.
   *
   * Diese Eintraege sind die wertvollsten des Protokolls: Ein wegen eines
   * Indikator-Triggers unterbliebener Einstieg hinterlaesst an der Boerse
   * keine Spur, ist aber genau das, was man beim Nachvollziehen sucht.
   *
   * Gedrosselt auf einen Eintrag je Plan/Order/Grund und Stunde — sonst
   * schriebe der Drei-Sekunden-Takt die Datenbank voll.
   */
  /**
   * Haelt ein Ereignis fest, dem keine Order entspricht.
   *
   * Das Nachziehen eines Stops oder das Umschalten auf Trailing
   * geschieht im Bot, nicht an der Boerse — dort ist davon nichts zu
   * sehen. Ohne diesen Eintrag liesse sich der Verlauf eines Trades
   * ("Einstieg, dann TP1, dann neuer Stop") nicht nachzeichnen, und
   * damit auch die Guete des Signalgebers nicht beurteilen.
   */
  private protokolliereEreignis(
    plan: TradePlan, art: string, einzelheiten: Record<string, unknown>,
  ): void {
    try {
      this.store.insertExecutionReport({
        plan_id: plan.id,
        entry_order_id: null,
        symbol: plan.symbol,
        side: plan.direction === 'long' ? 'buy' : 'sell',
        order_type: 'none',
        status: 'event',
        broker: this.exchangeOf(plan),
        bot_firmware: BOT_FIRMWARE,
        device_id: BOT_DEVICE_ID,
        metadata: { role: art, ...einzelheiten },
        executed_at: new Date().toISOString(),
      });
    } catch (err) {
      // Ein fehlendes Protokoll darf den Handel nicht aufhalten.
      this.logger.warn({ err, planId: plan.id, art }, 'Ereignis liess sich nicht protokollieren');
    }
  }

  private rejectionAudit = new Map<string, number>();
  private auditReject(plan: TradePlan, entry: EntryOrder | null, reason: string, role: string = 'entry'): void {
    const key = `${plan.id}|${entry?.id ?? 'plan'}|${reason}`;
    const last = this.rejectionAudit.get(key);
    const now = Date.now();
    if (last && now - last < 3600_000) return; // 1h Throttle
    this.rejectionAudit.set(key, now);

    this.store.insertExecutionReport({
      plan_id: plan.id,
      entry_order_id: entry?.id ?? null,
      symbol: plan.symbol,
      side: plan.direction === 'long' ? 'buy' : 'sell',
      order_type: 'limit',
      status: 'rejected',
      // Hier steht die vorgesehene Boerse, nicht der Name eines Zugangs:
      // Bei einer abgelehnten Aktion wurde keiner aufgebaut.
      broker: this.exchangeOf(plan),
      bot_firmware: BOT_FIRMWARE,
      device_id: BOT_DEVICE_ID,
      metadata: { role, reason },
      executed_at: new Date().toISOString(),
    });
  }
}
