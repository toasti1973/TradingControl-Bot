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

/**
 * Wieviel der Kurs ueber dem letzten erreichten Ziel stehen muss,
 * bevor der Stop dorthin gehoben wird (siehe `sichereErreichteZiele`).
 *
 * In dem Augenblick, in dem das letzte Ziel fuellt, steht der Kurs
 * genau auf dessen Preis — ein Stop dort loeste sofort aus. 0,05 %
 * ist knapp bemessen: gerade genug, damit aus dem Sichern kein
 * Verkauf zu Markt wird, aber wenig genug, dass die Grenze auch dann
 * greift, wenn der Kurs nur knapp weiterlief.
 */
const MINDESTABSTAND_ZIEL_PCT = 0.05;

interface MonitorState {
  plan: TradePlan;
  status: 'waiting_activation' | 'monitoring' | 'completed' | 'cancelled' | 'error';
  activationStep: number;                 // Bitmask
  tpState: TpStateEntry[];
  slCurrent: number | null;
  slType: 'fixed' | 'trailing';

  /**
   * Die an der Boerse hinterlegte Stop-Order.
   *
   * Preis und Menge werden mitgefuehrt, um zu erkennen, wann sie
   * erneuert werden muss: Ein Trailing-Stop wandert, und eine Order
   * zum alten Preis schuetzte die Position auf dem falschen Niveau.
   */
  slOrderId?: string;
  slOrderMenge?: number;
  slOrderPreis?: number;
  trailingActive: boolean;
  trailingBestPrice: number | null;
  trailingSizePct: number | null;
  remainingSize: number;
  lastPrice: number | null;

  /**
   * Wann `lastPrice` zuletzt wirklich von der Boerse kam.
   *
   * Ohne ihn ist der Kurs nicht lesbar: Antwortet `getPrice` nicht
   * mehr, wird der Durchlauf uebersprungen und `lastPrice` bleibt auf
   * dem alten Wert stehen — ein Kurs von vor einer Stunde sieht
   * genauso aus wie einer von eben. Die Detailansicht rechnet daraus
   * das nicht realisierte Ergebnis.
   *
   * `null` heisst "Alter unbekannt", nicht "kein Verzug": Nach einem
   * Neustart kommt `lastPrice` aus der Datenbank, und wann er dort
   * hineingeschrieben wurde, wissen wir nicht. Einen Zeitstempel zu
   * erfinden hiesse, fehlendes Wissen als Frische auszugeben.
   */
  lastPriceAt: number | null;
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

  /**
   * Die im Voraus platzierte Limit-Order zu diesem Ziel.
   *
   * Der Bot wartete frueher darauf, den Zielpreis in einer
   * Kursabfrage zu SEHEN, und schickte dann eine Market-Order. Bei
   * einem Abstand von zwei Sekunden zwischen den Abfragen entgeht ihm
   * dabei jeder Docht: Am 25.10. lief HYPEUSDT in der Minute 13:17 auf
   * 77,034 und schloss bei 76,957 — Ziel 1 lag bei 76,9907 und wurde
   * nie ausgeloest.
   *
   * Eine Limit-Order liegt im Orderbuch der Boerse. Sie wird gefuellt,
   * sobald der Kurs sie beruehrt — gleich ob der Bot gerade hinsieht,
   * neu startet oder steht. Und sie fuellt zum ZIELPREIS, nicht zu dem,
   * was zwei Sekunden spaeter noch uebrig ist.
   */
  orderId?: string;
  /** Menge, mit der die Order liegt — zum Erkennen von Abweichungen. */
  orderMenge?: number;
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
      lastPriceAt: null,
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

    // Ohne Zustand im Arbeitsspeicher wird aus der Datenbank
    // aufgeraeumt. Das kommt vor: ein Plan, der nie angemeldet wurde,
    // oder einer nach einem Neustart ohne geladenen Monitor.
    //
    // Auch dann muss eine offene Position geschlossen werden. Frueher
    // wurden hier nur die Orders zurueckgenommen und `cancelled`
    // gemeldet — die Position blieb stehen, waehrend die Antwort
    // Erfolg meldete und der Plan aus der Aufsicht fiel. Genau das
    // traf den BNBUSDT-Plan vom 25.10.: Er galt wegen eines falsch
    // verbuchten Take-Profits als abgeschlossen, und 7,68 BNB standen
    // unbemerkt weiter im Markt.
    if (!state) {
      const planRoh = this.store.getBotTradePlan(planId);
      const offenOhneAufsicht = this.offenePositionVon(planId);
      let geschlossenOhneAufsicht = 0;

      if (offenOhneAufsicht > 0 && planRoh) {
        const plan = this.deserializePlan(planRoh as Record<string, unknown>);
        // Zuerst schliessen, dann aufraeumen — wie im Normalfall auch.
        // Wirft es, bleibt der Plan stehen und sagt es.
        geschlossenOhneAufsicht = await this.schliessePositionZuMarkt(
          plan, null, offenOhneAufsicht, grund,
        );
      }

      const stornierte = await this.storniereAlleOrders(planId);
      this.states.delete(planId);
      this.store.deleteMonitor(planId);

      const status: 'cancelled' | 'completed' =
        this.hatJeEingestiegen(planId) ? 'completed' : 'cancelled';

      this.logger.info({
        planId, stornierte, grund, geschlossen: geschlossenOhneAufsicht, status,
      }, 'Plan beendet (ohne laufende Ueberwachung)');

      return {
        geschlosseneMenge: geschlossenOhneAufsicht,
        stornierteOrders: stornierte,
        status,
      };
    }

    const offen = this.offenePosition(state);
    let geschlossen = 0;

    if (offen > 0) {
      // Wirft weiter, wenn es scheitert — siehe oben.
      geschlossen = await this.schliessePositionZuMarkt(
        state.plan, state.lastPrice, offen, grund,
      );
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
        state.lastPriceAt = Date.now();
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

    // 0. Cancelled → aufraeumen. ERST die Position, DANN die Orders.
    //
    // Die Reihenfolge ist dieselbe wie in `beendePlan()` und aus
    // demselben Grund zwingend (Regel 3c): Unter den offenen Orders
    // ist der Stop-Loss. Nimmt man ihn zuerst zurueck und scheitert
    // danach das Schliessen, steht die Position ohne Absicherung da.
    //
    // Hier stand frueher nur `cancelAllOrdersForPlan`. Am 01.11.2026
    // stornierte Synaptrix 42 Plaene auf einmal; deren Positionen
    // blieben samt und sonders stehen, waehrend ihre Stop-Orders
    // zurueckgenommen wurden. Die BNBUSDT-Position lief danach
    // ungesichert weiter und band im Uebungskonto 4.854 USDT.
    if (plan.status === 'cancelled') {
      const offen = this.offenePosition(state);
      if (offen > 0) {
        try {
          await this.schliessePositionZuMarkt(plan, currentPrice, offen, 'benutzer_abbruch');
        } catch (err) {
          // NICHT weiter aufraeumen: Scheitert das Schliessen, bleiben
          // die Orders — und mit ihnen der Stop — vorerst liegen. Der
          // naechste Durchlauf versucht es erneut.
          this.logger.error(
            { err, planId: plan.id, offen },
            'Stornierter Plan: Position liess sich nicht schliessen — Orders bleiben vorerst liegen',
          );
          return;
        }
      }

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
    // 3c. Absicherung an der Boerse hinterlegen.
    //
    // Sobald eine Position steht, liegen ALLE Ziele und der Stop im
    // Orderbuch. Was dort liegt, wirkt auch dann, wenn der Bot gerade
    // neu startet, keine Verbindung hat oder zwischen zwei
    // Kursabfragen hinsieht — die drei Faelle, in denen die alte
    // Kursbeobachtung versagte.
    if (this.offenePosition(state) > 0) {
      await this.synchronisiereSlOrder(state);
      await this.pruefeSlFill(state);
      await this.processTakeProfits(state, currentPrice);
    } else {
      // Nichts mehr offen: Was noch liegt, ist gegenstandslos.
      await this.nimmSlOrderZurueck(state, 'keine Position mehr offen');
      await this.nimmTpOrdersZurueck(state, 'keine Position mehr offen');
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

    // 5b. Untergrenzen des Stops — NACH dem Trailing.
    //
    // Hier und nicht nur beim Take-Profit, denn beides muss auch nach
    // einem Neustart gelten: Der wiederhergestellte Zustand bringt
    // `slCurrent` mit, aber `tpErreicht()` laeuft nie wieder. Und das
    // Trailing darf die Grenzen nicht unterlaufen — es rechnet nur
    // Prozente vom Hoechstkurs und weiss nichts von Einstand oder
    // erreichten Zielen.
    if (this.offenePosition(state) > 0) {
      this.sichereErreichteZiele(state, currentPrice);
    }

    // 6. SL-Hit pruefen — ebenfalls nur bei offener Position.
    //
    // Ein Stop ohne Position haette dieselbe Wirkung wie ein Take-Profit
    // ohne Position: eine Order in der Gegenrichtung, die eroeffnet
    // statt zu schliessen.
    if (state.slCurrent != null && this.offenePosition(state) > 0) {
      this.processStopLoss(state, currentPrice);
    }

    // 7. Den Merker nachziehen — einmal je Durchlauf, zentral.
    //
    // `remainingSize` ist eine Kopie der offenen Position fuer die
    // Anzeige. Sie wurde bisher nur an einzelnen Stellen nachgefuehrt,
    // und jede davon konnte frueh zurueckkehren: Wurde die Position
    // ausserhalb dieser Pfade geschlossen, blieb der Merker stehen und
    // das Dashboard behauptete eine Position, die es nicht mehr gab.
    state.remainingSize = this.offenePosition(state);

    // 8. Plan-Completion
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
    // Gefragt wird die Quelle, nicht der Merker.
    //
    // `state.remainingSize` ist eine Kopie fuer die Anzeige; die
    // Wahrheit steht in den Orders. Hier haengt der Abschluss eines
    // Plans daran — ein Merker, der aus irgendeinem Grund zu niedrig
    // steht, meldete eine offene Position als erledigt ab.
    if (this.offenePosition(state) <= 0 && state.status === 'monitoring' &&
        this.hatJeEingestiegen(plan.id)) {
      const alleTpsErreicht = state.tpState.every(t => t.triggered);
      state.status = 'completed';
      this.planAbschliessen(plan);
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

    // Gehoert die Antwort ueberhaupt zu dieser Order?
    //
    // Die verlaesslichste Schranke, und die einzige, die auch den
    // leisen Fall faengt: Am 25.10. trug ein HYPEUSDT-Plan eine
    // Fuellung ueber 2,05 Stueck zu 2.321,93 — das waren ETHUSDT-
    // Zahlen. Weil 2,05 KLEINER ist als die bestellten 26,9, haette
    // keine Mengenpruefung sie bemerkt. Das Symbol verraet es sofort.
    const eigenes = this.store.getPlanOrder(orderId);
    const erwartet = String(eigenes?.symbol ?? '');
    if (erwartet && result.symbol && !gleichesSymbol(erwartet, result.symbol)) {
      this.logger.error({
        orderId, erwartet, geantwortet: result.symbol,
        menge: result.filledQuantity, preis: result.avgFillPrice,
      }, 'Boerse antwortet mit einem anderen Symbol — Meldung verworfen');
      return;
    }

    // Mehr gefuellt als bestellt? Das kann nicht sein.
    //
    // Am 25.10. kam genau das vor: Der Uebungsbroker beantwortete die
    // Frage nach einer BNBUSDT-Order mit einer HYPEUSDT-Order, weil
    // die Kennungen sich nach einem Neustart wiederholten. Eine
    // Bestellung ueber 1,67 BNB galt als mit 122,14 Stueck zu 76,45
    // gefuellt — und der Bot verbuchte 80.768 USDT Verlust auf einem
    // Konto mit 10.000.
    //
    // Die Ursache ist behoben (eindeutige Kennungen, Symbolpruefung).
    // Diese Schranke bleibt: Eine Fuellung ueber der Bestellmenge ist
    // unter keinen Umstaenden richtig, und sie stillschweigend zu
    // uebernehmen richtet mehr Schaden an als sie abzulehnen.
    const bestellt = Number(eigenes?.quantity ?? 0);
    if (bestellt > 0 && result.filledQuantity > bestellt * 1.000001) {
      this.logger.error({
        orderId, bestellt, gemeldet: result.filledQuantity,
        preis: result.avgFillPrice, brokerOrderId: result.orderId,
      }, 'Boerse meldet mehr Fuellung als bestellt — Meldung verworfen');
      return;
    }

    this.store.updatePlanOrder(orderId, {
      status: result.status,
      filled_quantity: result.filledQuantity,
      avg_fill_price: result.avgFillPrice,
      // Nur setzen, wenn der Zugang sie nennt — eine 0 zu schreiben,
      // wo nichts bekannt ist, behauptete Gebuehrenfreiheit.
      ...(result.fees != null ? { fees: result.fees } : {}),
      ...(result.feeCurrency ? { fee_currency: result.feeCurrency } : {}),
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
    plan: TradePlan, letzterKurs: number | null, menge: number, grund: string,
  ): Promise<number> {
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
      positionSide: plan.direction,
      leverage: plan.leverage,
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
      price: letzterKurs,
      quantity: menge,
      status: result.status,
      broker: broker.name,
      broker_order_id: result.orderId,
      client_order_id: clientOrderId,
    });

    // Abgewiesen heisst: nichts geschlossen. Die Zahl, die hier
    // zurueckgeht, bestimmt, was der Aufrufer dem Nutzer meldet — eine
    // geschlossene Menge zu melden, die im Markt geblieben ist, waere
    // die schlechteste aller Auskuenfte.
    if (result.status === 'rejected' || result.status === 'cancelled') {
      this.protokolliereEreignis(plan, 'schliessen_abgewiesen', {
        menge, grund, broker_status: result.status,
      });
      this.logger.error({
        planId: plan.id, menge, grund, status: result.status, broker: broker.name,
      }, 'Schliessen zu Markt wurde abgewiesen — Position bleibt offen');
      return 0;
    }

    this.merkeFuellung(orderId, result);

    this.store.insertExecutionReport({
      plan_id: plan.id,
      entry_order_id: null,
      symbol: plan.symbol,
      side: exitSide,
      order_type: 'market',
      status: 'filled',
      fill_price: result.avgFillPrice || letzterKurs,
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

    const executionMode = (plan as { execution_mode?: string }).execution_mode ?? 'all_limit';

    for (const entry of entries) {
      if (!entry.id) continue;
      if (state.triggeredEntries.has(entry.id)) continue;

      // Traegt dieser Einstieg eine Indikator-Bedingung, muss der Bot
      // sie pruefen — die Boerse kennt keinen RSI. Solche Einstiege
      // warten, bis die Bedingung erfuellt ist.
      if (entry.trigger) {
        const priceHit = this.checkEntryPriceHit(plan.direction, currentPrice, entry.price);
        if (!priceHit) continue;

        const triggerOk = await this.evaluateTrigger(plan.symbol, currentPrice, entry.trigger);
        if (!triggerOk) {
          this.auditReject(plan, entry, 'trigger_not_met', 'entry');
          continue;
        }

        await this.executeEntryOrder(state, entry, currentPrice);
        continue;
      }

      // Eine Market-Order braucht den Kurs — sie fuehrt sofort aus.
      // Das betrifft nur den ersten Einstieg bei
      // 'first_market_rest_limit'.
      const istErster = state.triggeredEntries.size === 0;
      if (executionMode === 'first_market_rest_limit' && istErster) {
        const priceHit = this.checkEntryPriceHit(plan.direction, currentPrice, entry.price);
        if (!priceHit) continue;
        await this.executeEntryOrder(state, entry, currentPrice);
        continue;
      }

      // Alle uebrigen sind Limit-Orders — und die gehoeren SOFORT ins
      // Orderbuch, nicht erst, wenn der Kurs sie beruehrt.
      //
      // Frueher wartete der Bot auch hier auf den Preis-Hit und legte
      // die Order erst dann. Das verschenkt genau das, wofuer ein
      // Limit da ist: Es liegt an der Boerse und wird gefuellt, sobald
      // der Kurs es erreicht — auch waehrend eines Neustarts, einer
      // Leitungsstoerung oder zwischen zwei Kursabfragen. Am 25.10.
      // standen deshalb zwei von vier Einstiegen Stunden spaeter noch
      // auf "nicht abgeschickt", obwohl der Kurs sie laengst
      // durchlaufen hatte.
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
    return this.offenePositionVon(state.plan.id);
  }

  /**
   * Dasselbe, aber allein aus der Plan-Kennung.
   *
   * Gebraucht fuer den Plan, der gerade NICHT ueberwacht wird: Beim
   * Beenden eines solchen Plans wurde bisher nur aufgeraeumt, was an
   * Orders herumlag — eine offene Position blieb stehen, und die
   * Antwort meldete trotzdem Erfolg. Die Orders wissen auch ohne
   * Monitor, was offen ist.
   */
  private offenePositionVon(planId: string): number {
    const orders = this.store.getPlanOrders(planId);

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
   * Der tatsaechliche durchschnittliche Einstiegspreis.
   *
   * Mengengewichtet ueber die gefuellten Einstiege — also der Preis, zu
   * dem diese Position wirklich zustande kam. NICHT der Durchschnitt
   * der geplanten Einstiege: Fuellt von vier Stufen nur die erste,
   * liegen die beiden Zahlen weit auseinander.
   *
   * Genau daran scheiterte der BNBUSDT-Plan am 26.10.2026. Das Signal
   * zog den Stop nach TP1 auf 737,61 — den Durchschnitt aller vier
   * geplanten Einstiege. Gefuellt war aber nur der erste zu 739,96.
   * Der vermeintliche Break-Even-Stop lag damit 2,35 unter dem echten
   * Einstand, und die verbliebenen 75 % der Position gingen mit
   * Verlust heraus: −6,21 USDT trotz mitgenommenem Take-Profit.
   *
   * `null`, solange kein Einstieg gefuellt ist.
   */
  private durchschnittsEinstieg(planId: string): number | null {
    const orders = this.store.getPlanOrders(planId);

    let menge = 0;
    let wert = 0;

    for (const o of orders) {
      if (o.role !== 'entry') continue;
      const gefuellt = Number(o.filled_quantity ?? 0);
      const preis = Number(o.avg_fill_price ?? 0);
      // Ohne Fuellpreis laesst sich nichts gewichten. Die Menge
      // trotzdem mitzuzaehlen verschoebe den Durchschnitt nach unten.
      if (gefuellt <= 0 || preis <= 0) continue;
      menge += gefuellt;
      wert += gefuellt * preis;
    }

    return menge > 0 ? wert / menge : null;
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

    // Die offene Position frisch aus den Orders holen — NICHT das
    // Stornierte abziehen.
    //
    // Hier stand lange `remainingSize - entfallen - nieAbgeschickt`.
    // Das war eine doppelte Buchung aus der Zeit, als `remainingSize`
    // bei der GEPLANTEN Groesse begann: Damals musste abgezogen
    // werden, was nie kommen wuerde. Heute traegt `remainingSize` die
    // tatsaechlich offene Menge, und ein zurueckgenommenes Kauf-Limit
    // hat sie nie beruehrt.
    //
    // Die Folge war die gefaehrlichste denkbare: Bei 0,1 gekauft,
    // 0,03 per Take-Profit geschlossen und 0,2 storniert, fiel
    // `remainingSize` auf 0 — der Plan galt als abgeschlossen,
    // waehrend 0,07 weiter im Markt standen. Abgemeldet, ohne
    // Aufsicht, und im Dashboard unter "beendet", wo weder die
    // gebundene Margin noch das schwebende Ergebnis mitzaehlen.
    const nieAbgeschickt = (plan.entry_orders ?? [])
      .filter(e => e.id && !state.triggeredEntries.has(e.id))
      .reduce((summe, e) => summe + e.size, 0);

    state.remainingSize = this.offenePosition(state);

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
        positionSide: plan.direction,
        leverage: plan.leverage,
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

    // Zuerst nachsehen, ob eine vorausgelegte Order gefuellt wurde.
    await this.pruefeTpFills(state);

    // Dann alle offenen Ziele legen beziehungsweise nachfuehren — die
    // Mengen haengen an der Position und wachsen mit jedem Einstieg.
    await this.synchronisiereTpOrders(state);

    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i]!;
      const tpState = state.tpState[i];
      if (!tpState || tpState.triggered) continue;

      // Liegt eine Limit-Order fuer dieses Ziel, erledigt sie die
      // Sache — und zwar besser, als eine Kursabfrage es koennte.
      if (tpState.orderId) continue;

      // Rueckfall fuer den Fall, dass sich keine Order platzieren
      // liess: wie bisher auf den Kurs sehen.
      const hit = plan.direction === 'long'
        ? currentPrice >= tp.price
        : currentPrice <= tp.price;
      if (!hit) continue;

      await this.executeTpHit(state, tp, i, currentPrice);
    }
  }

  /**
   * Legt ALLE noch offenen Take-Profits ins Orderbuch.
   *
   * Ihre Preise und Anteile stehen fest — es gibt keinen Grund, mit
   * dem Legen zu warten. Was im Orderbuch liegt, wird gefuellt, sobald
   * der Kurs es beruehrt; gleich ob der Bot gerade hinsieht, neu
   * startet oder steht.
   *
   * Veraenderlich ist allein die MENGE: Sie haengt an der tatsaechlich
   * eingestiegenen Position. Kommt ein Einstieg hinzu, wachsen alle
   * Ziele mit — dann wird zurueckgenommen und neu gelegt.
   */
  private async synchronisiereTpOrders(state: MonitorState): Promise<void> {
    const plan = state.plan;
    const tps = plan.take_profits ?? [];
    const offen = this.offenePosition(state);

    // Ueberzaehlige Ziel-Orders aufraeumen, bevor neue dazukommen.
    //
    // `tpState.orderId` wird zwar mitgespeichert, aber eine Order kann
    // auch aus anderen Gruenden doppelt vorliegen — etwa wenn das
    // Zuruecknehmen scheiterte und der Merker trotzdem weiterzog. Zwei
    // Orders auf dasselbe Ziel schlossen zusammen mehr, als offen ist.
    await this.raeumeUeberzaehligeTpOrders(state);

    // Ohne Position gibt es nichts zu schliessen.
    if (offen <= 0) {
      await this.nimmTpOrdersZurueck(state, 'keine Position mehr offen');
      return;
    }

    const mengen = this.tpMengen(state, offen);

    for (let index = 0; index < tps.length; index++) {
      const tp = tps[index];
      const tpState = state.tpState[index];
      if (!tp || !tpState || tpState.triggered) continue;

      const gewuenscht = mengen[index] ?? 0;

      if (gewuenscht <= 0) {
        // Fuer dieses Ziel bleibt nichts uebrig — eine liegende Order
        // waere zuviel.
        if (tpState.orderId) await this.nimmTpOrderZurueck(state, index, 'Menge auf 0 gefallen');
        continue;
      }

      // Liegt schon die richtige Order? Dann ist nichts zu tun.
      if (tpState.orderId && naheBei(tpState.orderMenge, gewuenscht)) continue;

      // Liegt eine mit falscher Menge, muss sie weichen. Schlaegt das
      // fehl, wird NICHT neu gelegt — sonst laegen zwei Orders, und
      // zusammen schlossen sie mehr als offen ist.
      if (tpState.orderId) {
        const weg = await this.nimmTpOrderZurueck(state, index, 'Menge hat sich geaendert');
        if (!weg) continue;
      }

      await this.legeTpOrder(state, tp, index, gewuenscht);
    }
  }

  /**
   * Wieviel soll jedes noch offene Ziel schliessen?
   *
   * Die Anteile beziehen sich auf die eingestiegene Menge, nicht auf
   * die geplante: Wurden erst zwei von vier Einstiegen gefuellt, nimmt
   * ein 25-%-Ziel ein Viertel DAVON — sonst wollte es ein Viertel
   * einer Position schliessen, die es nie gab.
   *
   * Die Summe wird auf die offene Menge gedeckelt. Was ueber sie
   * hinausginge, faellt beim letzten Ziel weg, nicht beim ersten: Das
   * naechste Ziel ist das wahrscheinlichste.
   */
  private tpMengen(state: MonitorState, offen: number): number[] {
    const plan = state.plan;
    const tps = plan.take_profits ?? [];

    // Bezugsgroesse ist, was wirklich gekauft wurde.
    const eingestiegen = this.store.getPlanOrders(plan.id)
      .filter(o => o.role === 'entry')
      .reduce((s, o) => s + (Number(o.filled_quantity) || 0), 0);
    const bezug = eingestiegen > 0 ? eingestiegen : plan.total_size;

    const mengen: number[] = [];
    let rest = offen;

    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i]!;
      const tpState = state.tpState[i];

      if (!tpState || tpState.triggered) { mengen.push(0); continue; }

      const gewuenscht = bezug * (getTpPercentage(tp) / 100);
      const menge = this.runde(Math.min(gewuenscht, rest));
      mengen.push(menge);
      rest = this.runde(rest - menge);
    }

    return mengen;
  }

  /** Legt eine einzelne Take-Profit-Order. */
  private async legeTpOrder(
    state: MonitorState, tp: TakeProfit, index: number, menge: number,
  ): Promise<void> {
    const plan = state.plan;
    const tpState = state.tpState[index];
    if (!tpState) return;

    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';
    const orderId = randomUUID();
    const clientOrderId = `tc-plan-${plan.id.slice(0, 8)}-tplimit-${index}`;

    try {
      const broker = await this.brokerFor(plan);
      const result = await broker.placeOrder({
        symbol: plan.symbol,
        side: exitSide,
        type: 'limit',
        price: tp.price,
        quantity: menge,
        clientOrderId,
        reduceOnly: true,
        positionSide: plan.direction,
        leverage: plan.leverage,
      });

      this.store.insertPlanOrder({
        id: orderId,
        trade_plan_id: plan.id,
        side: exitSide,
        order_type: 'limit',
        role: 'take_profit',
        symbol: plan.symbol,
        price: tp.price,
        quantity: menge,
        status: result.status,
        broker: broker.name,
        broker_order_id: result.orderId,
        client_order_id: clientOrderId,
      });

      if (result.status === 'rejected' || result.status === 'cancelled') {
        this.logger.warn({
          planId: plan.id, tpIndex: index, menge, status: result.status,
        }, 'Take-Profit-Limit wurde abgewiesen — es bleibt bei der Kursbeobachtung');
        return;
      }

      // Sofort gefuellt (der Kurs stand schon jenseits des Ziels):
      // dann ist der Take-Profit damit erreicht.
      if (result.filledQuantity > 0) {
        this.merkeFuellung(orderId, result);
        tpState.orderId = orderId;
        tpState.orderMenge = menge;
        await this.tpErreicht(
          state, tp, index, result.avgFillPrice || tp.price, result.filledQuantity, result.orderId,
        );
        return;
      }

      tpState.orderId = orderId;
      tpState.orderMenge = menge;
      this.persistMonitor(state);

      this.logger.info({
        planId: plan.id, tpIndex: index, preis: tp.price, menge,
      }, 'Take-Profit im Voraus ins Orderbuch gelegt');
    } catch (err) {
      state.errorCount++;
      this.logger.error({
        err, planId: plan.id, tpIndex: index,
      }, 'Take-Profit-Limit liess sich nicht legen — es bleibt bei der Kursbeobachtung');
    }
  }

  /**
   * Sieht nach, ob ein vorausplatziertes Take-Profit-Limit gefuellt
   * wurde.
   *
   * Dasselbe Vorgehen wie bei den Einstiegen: Die Order liegt an der
   * Boerse, und ob sie zum Zuge kam, erfaehrt der Bot nur, wenn er
   * fragt.
   */
  private async pruefeTpFills(state: MonitorState): Promise<void> {
    const plan = state.plan;
    const tps = plan.take_profits ?? [];

    for (let i = 0; i < state.tpState.length; i++) {
      const tpState = state.tpState[i];
      if (!tpState || tpState.triggered || !tpState.orderId) continue;

      const order = this.store.getPlanOrder(tpState.orderId);
      const brokerOrderId = order?.broker_order_id as string | null | undefined;
      if (!brokerOrderId) continue;

      let ergebnis;
      try {
        const broker = await this.brokerFor(plan);
        ergebnis = await broker.getOrder(plan.symbol, brokerOrderId);
      } catch {
        continue;   // Ohne Zugang laesst sich nichts nachsehen.
      }
      if (!ergebnis) continue;

      if (ergebnis.status === 'cancelled' || ergebnis.status === 'rejected') {
        // Von aussen zurueckgenommen: Der Merker muss weg, sonst wird
        // nie wieder eine Order fuer dieses Ziel gelegt.
        this.store.updatePlanOrder(tpState.orderId, { status: ergebnis.status });
        tpState.orderId = undefined;
        tpState.orderMenge = undefined;
        this.persistMonitor(state);
        continue;
      }

      if (ergebnis.filledQuantity <= 0) continue;

      this.merkeFuellung(tpState.orderId, ergebnis);

      const tp = tps[i];
      if (!tp) continue;
      await this.tpErreicht(
        state, tp, i, ergebnis.avgFillPrice || tp.price, ergebnis.filledQuantity,
      );
    }
  }

  /** Nimmt die Limit-Order eines Ziels zurueck. Gibt zurueck, ob es gelang. */
  private async nimmTpOrderZurueck(
    state: MonitorState, index: number, grund: string,
  ): Promise<boolean> {
    const tpState = state.tpState[index];
    if (!tpState?.orderId) return true;

    const order = this.store.getPlanOrder(tpState.orderId);
    const brokerOrderId = order?.broker_order_id as string | null | undefined;

    if (brokerOrderId) {
      try {
        const broker = await this.brokerFor(state.plan);
        await broker.cancelOrder(state.plan.symbol, brokerOrderId);
      } catch (err) {
        // Nicht als storniert vermerken, wenn es nicht gelang: Die
        // Order liegt dann weiter an der Boerse.
        this.logger.warn({
          err, planId: state.plan.id, tpIndex: index, grund,
        }, 'Take-Profit-Limit liess sich nicht zuruecknehmen');
        return false;
      }
    }

    this.store.updatePlanOrder(tpState.orderId, { status: 'cancelled' });
    tpState.orderId = undefined;
    tpState.orderMenge = undefined;
    this.persistMonitor(state);
    return true;
  }

  /**
   * Nimmt Ziel-Orders zurueck, die zu keinem gefuehrten Ziel gehoeren.
   *
   * Massgeblich ist `tpState`: Was dort als Order eines Ziels
   * vermerkt ist, bleibt. Alles andere, was an Ziel-Orders offen
   * herumliegt, ist uebrig — und wuerde die Position ein zweites Mal
   * schliessen.
   */
  private async raeumeUeberzaehligeTpOrders(state: MonitorState): Promise<void> {
    const gefuehrt = new Set(
      state.tpState.map(t => t?.orderId).filter((id): id is string => !!id),
    );
    const offeneStatus = new Set(['new', 'placed', 'partially_filled']);

    const uebrig = this.store.getPlanOrders(state.plan.id).filter(o =>
      o.role === 'take_profit' &&
      offeneStatus.has(String(o.status)) &&
      Number(o.filled_quantity ?? 0) <= 0 &&
      !gefuehrt.has(String(o.id)),
    );
    if (uebrig.length === 0) return;

    this.logger.warn({
      planId: state.plan.id, anzahl: uebrig.length,
    }, 'Ueberzaehlige Take-Profit-Orders gefunden — werden zurueckgenommen');

    for (const o of uebrig) {
      await this.nimmOrderZurueck(state.plan, String(o.id), 'ueberzaehlige Ziel-Order');
    }
  }

  /** Nimmt alle liegenden Take-Profit-Limits zurueck. */
  private async nimmTpOrdersZurueck(state: MonitorState, grund: string): Promise<void> {
    for (let i = 0; i < state.tpState.length; i++) {
      if (state.tpState[i]?.orderId) {
        await this.nimmTpOrderZurueck(state, i, grund);
      }
    }
  }

  /** Mengen auf zehn Nachkommastellen — wie ueberall im Monitor. */
  private runde(menge: number): number {
    return menge > 1e-9 ? Number(menge.toFixed(10)) : 0;
  }

  // ============================================================
  // Der Stop-Loss liegt an der Boerse
  //
  // Der Bot hielt ihn frueher selbst: Er beobachtete den Kurs und
  // schickte erst beim Ueberschreiten eine Market-Order. Das setzt
  // voraus, dass er laeuft, Verbindung hat und im richtigen Augenblick
  // hinsieht — drei Bedingungen, von denen jede ausfallen kann.
  //
  // Eine Stop-Order im Orderbuch braucht nichts davon. Sie wird
  // ausgeloest, auch wenn der Bot gerade neu startet oder die Leitung
  // steht. Wandert der Stop (nach einem Take-Profit oder als
  // Trailing), wird sie zurueckgenommen und neu gelegt — ein kurzer
  // Augenblick ohne Absicherung ist ungleich besser als gar keine.
  // ============================================================

  /**
   * Haelt die Stop-Order an der Boerse auf dem aktuellen Stand.
   *
   * Neu gelegt wird nur, wenn sich Preis oder Menge tatsaechlich
   * geaendert haben — ein Trailing-Stop wanderte sonst im Takt der
   * Kursabfrage und erzeugte im Minutentakt Dutzende Aufrufe.
   */
  private async synchronisiereSlOrder(state: MonitorState): Promise<void> {
    const plan = state.plan;
    const offen = this.offenePosition(state);

    // Den Merker notfalls aus den Orders wiederherstellen.
    //
    // `slOrderId` lebt im Arbeitsspeicher und wird nicht in der
    // Monitor-Zeile gespeichert. Nach einem Neustart waere er leer —
    // die Order laege aber weiter an der Boerse, und hier wuerde eine
    // ZWEITE gelegt. Genau das geschah beim Ausrollen am 25.10.: zwei
    // Stop-Orders ueber je 124,19 bei 124,19 offener Position.
    //
    // Die Orders wissen es besser als jeder Merker.
    if (!state.slOrderId) this.findeLiegendeSlOrder(state);

    if (offen <= 0 || state.slCurrent == null) {
      await this.nimmSlOrderZurueck(state, 'keine Position oder kein Stop');
      return;
    }

    const preis = state.slCurrent;

    // Steht die richtige Order schon? Dann ist nichts zu tun.
    if (state.slOrderId && naheBei(state.slOrderMenge, offen) &&
        naheBei(state.slOrderPreis, preis)) {
      return;
    }

    // Die alte muss zuerst weg — zwei Stop-Orders schlossen zusammen
    // mehr, als offen ist.
    if (state.slOrderId) {
      const weg = await this.nimmSlOrderZurueck(state, 'Stop hat sich bewegt');
      if (!weg) return;
    }

    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';
    const orderId = randomUUID();
    const clientOrderId = `tc-plan-${plan.id.slice(0, 8)}-slstop`;

    try {
      const broker = await this.brokerFor(plan);
      const result = await broker.placeOrder({
        symbol: plan.symbol,
        side: exitSide,
        type: 'stop',
        stopPrice: preis,
        quantity: offen,
        clientOrderId,
        reduceOnly: true,
        positionSide: plan.direction,
        leverage: plan.leverage,
      });

      this.store.insertPlanOrder({
        id: orderId,
        trade_plan_id: plan.id,
        side: exitSide,
        order_type: 'stop',
        role: state.trailingActive ? 'trailing_stop' : 'stop_loss',
        symbol: plan.symbol,
        price: preis,
        stop_price: preis,
        quantity: offen,
        status: result.status,
        broker: broker.name,
        broker_order_id: result.orderId,
        client_order_id: clientOrderId,
      });

      if (result.status === 'rejected' || result.status === 'cancelled') {
        // Jetzt ist der Plan ungeschuetzt — das muss auffallen. Die
        // Kursbeobachtung greift weiter, sie ist aber der schwaechere
        // Schutz.
        state.errorCount++;
        this.protokolliereEreignis(plan, 'sl_order_abgewiesen', {
          sl_preis: preis, menge: offen, broker_status: result.status,
        });
        this.logger.error({
          planId: plan.id, slPreis: preis, menge: offen, status: result.status,
        }, 'Stop-Order wurde abgewiesen — Absicherung haengt wieder an der Kursbeobachtung');
        return;
      }

      // Sofort ausgeloest: Der Kurs stand schon jenseits des Stops.
      if (result.filledQuantity > 0) {
        this.merkeFuellung(orderId, result);
        await this.slErreicht(state, result.avgFillPrice || preis, result.filledQuantity);
        return;
      }

      state.slOrderId = orderId;
      state.slOrderMenge = offen;
      state.slOrderPreis = preis;
      this.persistMonitor(state);

      this.logger.info({
        planId: plan.id, slPreis: preis, menge: offen,
        trailing: state.trailingActive,
      }, 'Stop-Order an der Boerse hinterlegt');
    } catch (err) {
      state.errorCount++;
      this.logger.error({
        err, planId: plan.id, slPreis: preis,
      }, 'Stop-Order liess sich nicht legen — Absicherung haengt an der Kursbeobachtung');
    }
  }

  /**
   * Sieht nach, ob die hinterlegte Stop-Order ausgeloest wurde.
   */
  private async pruefeSlFill(state: MonitorState): Promise<void> {
    if (!state.slOrderId) return;

    const order = this.store.getPlanOrder(state.slOrderId);
    const brokerOrderId = order?.broker_order_id as string | null | undefined;
    if (!brokerOrderId) return;

    let ergebnis;
    try {
      const broker = await this.brokerFor(state.plan);
      ergebnis = await broker.getOrder(state.plan.symbol, brokerOrderId);
    } catch {
      return;
    }
    if (!ergebnis) return;

    if (ergebnis.status === 'cancelled' || ergebnis.status === 'rejected') {
      this.store.updatePlanOrder(state.slOrderId, { status: ergebnis.status });
      state.slOrderId = undefined;
      state.slOrderMenge = undefined;
      state.slOrderPreis = undefined;
      this.persistMonitor(state);
      return;
    }

    if (ergebnis.filledQuantity <= 0) return;

    this.merkeFuellung(state.slOrderId, ergebnis);
    await this.slErreicht(
      state, ergebnis.avgFillPrice || state.slCurrent || 0, ergebnis.filledQuantity,
    );
  }

  /** Was geschieht, wenn der Stop gegriffen hat. */
  private async slErreicht(
    state: MonitorState, fuellPreis: number, menge: number,
  ): Promise<void> {
    const plan = state.plan;

    state.slOrderId = undefined;
    state.slOrderMenge = undefined;
    state.slOrderPreis = undefined;
    state.remainingSize = this.offenePosition(state);

    // Die Ziele sind damit gegenstandslos — und muessen weg, sonst
    // liegen sie weiter im Orderbuch und koennten eine spaetere
    // Position anknabbern.
    await this.nimmTpOrdersZurueck(state, 'Stop hat gegriffen');

    if (state.remainingSize <= 0) {
      state.status = 'completed';
      this.planAbschliessen(plan);
    }
    this.persistMonitor(state);

    this.store.insertExecutionReport({
      plan_id: plan.id,
      entry_order_id: null,
      symbol: plan.symbol,
      side: plan.direction === 'long' ? 'sell' : 'buy',
      order_type: 'stop',
      status: 'filled',
      fill_price: fuellPreis,
      fill_quantity: menge,
      broker: this.exchangeOf(plan),
      bot_firmware: BOT_FIRMWARE,
      device_id: BOT_DEVICE_ID,
      metadata: {
        role: state.trailingActive ? 'trailing_stop' : 'stop_loss',
        sl_price: state.slCurrent,
      },
      executed_at: new Date().toISOString(),
    });

    this.emit('plan:sl_hit', plan.id, fuellPreis);
    this.logger.info({
      planId: plan.id, preis: fuellPreis, menge, slPreis: state.slCurrent,
    }, 'Stop-Order ausgeloest');
  }

  /**
   * Sucht eine noch liegende Stop-Order dieses Plans in der Datenbank.
   *
   * Findet sie mehrere, bleibt die juengste stehen und die aelteren
   * werden beim naechsten Durchlauf zurueckgenommen — zwei Stops
   * schlossen zusammen mehr, als offen ist.
   */
  private findeLiegendeSlOrder(state: MonitorState): void {
    const offeneStatus = new Set(['new', 'placed', 'partially_filled']);

    const liegende = this.store.getPlanOrders(state.plan.id).filter(o =>
      (o.role === 'stop_loss' || o.role === 'trailing_stop') &&
      offeneStatus.has(String(o.status)) &&
      Number(o.filled_quantity ?? 0) <= 0,
    );
    if (liegende.length === 0) return;

    // getPlanOrders liefert nach placed_at aufsteigend — die letzte
    // ist die juengste.
    const juengste = liegende[liegende.length - 1]!;
    state.slOrderId = String(juengste.id);
    state.slOrderMenge = Number(juengste.quantity) || undefined;
    state.slOrderPreis = Number(juengste.stop_price ?? juengste.price) || undefined;

    if (liegende.length > 1) {
      this.logger.warn({
        planId: state.plan.id, anzahl: liegende.length,
      }, 'Mehrere Stop-Orders gefunden — die aelteren werden zurueckgenommen');

      // Die ueberzaehligen sofort weg: Jede von ihnen koennte die
      // Position ein zweites Mal schliessen.
      for (const alt of liegende.slice(0, -1)) {
        void this.nimmOrderZurueck(state.plan, String(alt.id), 'ueberzaehlige Stop-Order');
      }
    }
  }

  /**
   * Nimmt eine einzelne Order anhand ihrer Kennung zurueck.
   *
   * Scheitert es, bleibt der Status unveraendert — die Order liegt
   * dann weiter an der Boerse, und das muss aus der Datenbank
   * hervorgehen.
   */
  private async nimmOrderZurueck(
    plan: TradePlan, orderId: string, grund: string,
  ): Promise<boolean> {
    const order = this.store.getPlanOrder(orderId);
    const brokerOrderId = order?.broker_order_id as string | null | undefined;

    if (brokerOrderId) {
      try {
        const broker = await this.brokerFor(plan);
        await broker.cancelOrder(plan.symbol, brokerOrderId);
      } catch (err) {
        this.logger.warn({ err, planId: plan.id, orderId, grund },
          'Order liess sich nicht zuruecknehmen');
        return false;
      }
    }

    this.store.updatePlanOrder(orderId, { status: 'cancelled' });
    return true;
  }

  /** Nimmt die hinterlegte Stop-Order zurueck. Gibt zurueck, ob es gelang. */
  private async nimmSlOrderZurueck(state: MonitorState, grund: string): Promise<boolean> {
    if (!state.slOrderId) return true;

    const order = this.store.getPlanOrder(state.slOrderId);
    const brokerOrderId = order?.broker_order_id as string | null | undefined;

    if (brokerOrderId) {
      try {
        const broker = await this.brokerFor(state.plan);
        await broker.cancelOrder(state.plan.symbol, brokerOrderId);
      } catch (err) {
        this.logger.warn({
          err, planId: state.plan.id, grund,
        }, 'Stop-Order liess sich nicht zuruecknehmen — die alte bleibt liegen');
        return false;
      }
    }

    this.store.updatePlanOrder(state.slOrderId, { status: 'cancelled' });
    state.slOrderId = undefined;
    state.slOrderMenge = undefined;
    state.slOrderPreis = undefined;
    this.persistMonitor(state);
    return true;
  }

  /**
   * Rueckfall: Take-Profit per Market-Order, wenn kein Limit liegt.
   *
   * Der Regelfall ist das vorausgelegte Limit (siehe
   * `synchronisiereTpOrders`). Hierher kommt der Bot nur, wenn sich
   * keines legen liess — dann bleibt ihm die Kursbeobachtung.
   */
  private async executeTpHit(state: MonitorState, tp: TakeProfit, index: number, currentPrice: number): Promise<void> {
    const plan = state.plan;
    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';

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
        positionSide: plan.direction,
        leverage: plan.leverage,
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

      // Eine abgewiesene Order hat NICHTS geschlossen.
      //
      // Sie trotzdem als erledigt zu verbuchen war der gefaehrlichste
      // Fehler, den dieser Monitor hatte: Der Stop wurde nachgezogen,
      // die Einstiegsphase beendet und der Plan fuer abgeschlossen
      // erklaert — waehrend die Position unveraendert im Markt stand
      // und von da an niemand mehr auf sie sah. Der Take-Profit bleibt
      // deshalb offen und wird beim naechsten Durchlauf erneut
      // versucht.
      if (result.status === 'rejected' || result.status === 'cancelled') {
        state.errorCount++;
        this.protokolliereEreignis(plan, 'tp_rejected', {
          tp_index: index,
          tp_preis: tp.price,
          menge: tpSize,
          kurs: currentPrice,
          broker_status: result.status,
        });
        this.logger.error({
          planId: plan.id, tpIndex: index, menge: tpSize,
          status: result.status, broker: broker.name,
        }, 'Take-Profit wurde abgewiesen — Position bleibt offen, wird erneut versucht');
        return;
      }

      // Die Fuellung festhalten — wie bei den Einstiegen auch.
      //
      // Ohne diesen Schritt bliebe filled_quantity auf 0, und
      // `offenePosition()` zieht genau diese Spalte ab: Eine mitgenommene
      // Teilrealisierung waere aus den Orders nicht ablesbar. Nach einem
      // Neustart laedt der Monitor die offene Position aus den Orders —
      // der Plan erschiene mit voller Position, obwohl sie laengst
      // teilweise geschlossen ist.
      this.merkeFuellung(orderId, result);

      await this.tpErreicht(
        state, tp, index, result.avgFillPrice || currentPrice, tpSize, result.orderId,
      );
    } catch (err) {
      state.errorCount++;
      this.logger.error({ err, planId: plan.id, tpIndex: index }, 'TP-Order fehlgeschlagen');
    }
  }

  /**
   * Was geschieht, wenn ein Take-Profit erreicht ist.
   *
   * Gemeinsam fuer beide Wege: die im Voraus gelegte Limit-Order, die
   * gefuellt wurde, und die Market-Order aus der Kursbeobachtung. Was
   * danach folgt — Stop nachziehen, Trailing anschalten, Einstiege
   * zuruecknehmen — ist in beiden Faellen dasselbe und darf sich
   * nicht auseinanderentwickeln.
   */
  private async tpErreicht(
    state: MonitorState,
    tp: TakeProfit,
    index: number,
    fuellPreis: number,
    menge: number,
    brokerOrderId?: string,
  ): Promise<void> {
    const plan = state.plan;
    const tpState = state.tpState[index];
    if (!tpState || tpState.triggered) return;

    const exitSide: 'buy' | 'sell' = plan.direction === 'long' ? 'sell' : 'buy';

    // Vor dem Setzen von `triggered` gemerkt — danach liesse sich
    // nicht mehr unterscheiden, ob dies der erste war.
    const istErsterTp = !this.istEinstiegsphaseBeendet(state);

    tpState.triggered = true;
    tpState.filledAt = new Date().toISOString();
    tpState.filledPrice = fuellPreis;
    tpState.filledSize = menge;
    tpState.orderId = undefined;
    tpState.orderMenge = undefined;
    state.remainingSize = this.offenePosition(state);

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
      order_type: 'limit',
      status: 'filled',
      fill_price: fuellPreis,
      fill_quantity: menge,
      broker: this.exchangeOf(plan),
      broker_order_id: brokerOrderId ?? null,
      bot_firmware: BOT_FIRMWARE,
      device_id: BOT_DEVICE_ID,
      metadata: { role: 'take_profit', tp_index: index, tp_price: tp.price },
      executed_at: new Date().toISOString(),
    });

    this.emit('plan:tp_hit', plan.id, index, fuellPreis);
    this.logger.info({
      planId: plan.id, tpIndex: index, price: fuellPreis, size: menge,
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

    // Break-Even-Schranke — nach dem Signal, vor dem Trailing.
    //
    // Die Reihenfolge ist Absicht: Das Signal setzt seinen Stop zuerst,
    // die Schranke hebt ihn nur an, falls er den Einstand verfehlt. Ein
    // Signal, das besser liegt, bleibt unberuehrt.
    this.zieheStopAufEinstand(state, index);

    // Per-TP Trailing-Activation
    if (tp.activate_trailing && tp.trailing_pct != null && tp.trailing_pct > 0) {
      state.trailingActive = true;
      state.slType = 'trailing';
      state.trailingBestPrice = fuellPreis;
      plan.trailing_stop_pct = tp.trailing_pct;

      this.protokolliereEreignis(plan, 'trailing_activated', {
        tp_index: index,
        trailing_pct: tp.trailing_pct,
        ab_preis: fuellPreis,
      });

      this.emit('plan:trailing_activated', plan.id, fuellPreis);
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
  }

  // ============================================================
  // Stop von aussen setzen
  // ============================================================

  /**
   * Setzt den Stop-Loss eines ueberwachten Plans neu.
   *
   * Der Weg fuer TC-Synaptrix: Es kennt ueber den Rueckkanal den
   * tatsaechlichen Einstand und kann daraus einen genaueren Stop
   * rechnen, als der Bot ihn aus dem Signal ableiten konnte.
   *
   * ## Die Einbahn
   *
   * Angenommen wird nur, was das Risiko verkleinert — beim Long ein
   * hoeherer Stop, beim Short ein niedrigerer. Ein Update, das den
   * Stop weiter wegruecken wuerde, wird abgelehnt und begruendet.
   *
   * Ohne diese Schranke liesse sich ein laufender Trade aus der Ferne
   * riskanter machen, als er eroeffnet wurde. Beim Eroeffnen hat der
   * Nutzer eine Groesse und einen Abstand zum Stop hingenommen; beides
   * nachtraeglich zu vergroessern ist etwas anderes als das, dem er
   * zugestimmt hat.
   *
   * Die neue Order wird nicht hier gelegt: `synchronisiereSlOrder()`
   * sieht beim naechsten Durchlauf, dass `slCurrent` wanderte, nimmt
   * die alte zurueck und legt die neue. Das haelt die Order-Behandlung
   * an einer Stelle — und mit ihr die Regel, dass nach einem
   * gescheiterten Zuruecknehmen NICHT neu gelegt wird.
   */
  async setzeStopLoss(
    planId: string,
    neuerStop: number,
    herkunft: { quelle: string; signalId?: string },
  ): Promise<{ geaendert: boolean; grund: string; vorher: number | null }> {
    const state = this.states.get(planId);
    if (!state) {
      return { geaendert: false, grund: 'Plan wird nicht ueberwacht', vorher: null };
    }
    if (!Number.isFinite(neuerStop) || neuerStop <= 0) {
      return { geaendert: false, grund: `Unbrauchbarer Stop-Preis: ${neuerStop}`, vorher: state.slCurrent ?? null };
    }

    const plan = state.plan;
    const istLong = plan.direction !== 'short';
    const bisher = state.slCurrent ?? null;

    if (bisher != null) {
      if (naheBei(bisher, neuerStop)) {
        return { geaendert: false, grund: 'Stop liegt bereits dort', vorher: bisher };
      }
      const verschlechtert = istLong ? neuerStop < bisher : neuerStop > bisher;
      if (verschlechtert) {
        this.logger.warn({
          planId, bisher, neuerStop, quelle: herkunft.quelle,
        }, 'Stop-Update abgelehnt — es haette das Risiko vergroessert');
        return {
          geaendert: false,
          grund: `Haette das Risiko vergroessert (${bisher} → ${neuerStop})`,
          vorher: bisher,
        };
      }
    }

    state.slCurrent = neuerStop;
    // Ein von aussen gesetzter Stop ist fest. Stuende er weiter auf
    // 'trailing', zoege ihn der naechste Kursschlag wieder nach der
    // Prozentregel — das Update waere nach Sekunden vergessen.
    state.slType = 'fixed';
    this.persistMonitor(state);

    this.protokolliereEreignis(plan, 'sl_extern_gesetzt', {
      sl_vorher: bisher,
      sl_neu: neuerStop,
      quelle: herkunft.quelle,
      signal_id: herkunft.signalId ?? null,
    });

    this.logger.info({
      planId, bisher, neuerStop, quelle: herkunft.quelle,
    }, 'Stop von aussen gesetzt');

    return { geaendert: true, grund: 'gesetzt', vorher: bisher };
  }

  // ============================================================
  // Break-Even nach dem ersten Take-Profit
  // ============================================================

  /**
   * Hebt den Stop auf den tatsaechlichen Einstand, sobald ein
   * Take-Profit gegriffen hat.
   *
   * ## Warum ueberhaupt
   *
   * Ein Signal rechnet seinen Break-Even-Stop auf die GEPLANTE Staffel.
   * Fuellt die nur zum Teil — und das ist der Regelfall, denn nach dem
   * ersten Take-Profit werden die restlichen Einstiege zurueckgenommen
   * (Regel 3b) — liegt der vorgegebene Stop unter dem echten Einstand.
   * Dann kann ein Trade trotz mitgenommenem Gewinn im Minus enden.
   *
   * ## Nur nach oben
   *
   * Die Schranke verschiebt den Stop ausschliesslich in die sichere
   * Richtung: beim Long nach oben, beim Short nach unten. Liegt der
   * Stop des Signals bereits besser, bleibt er. Damit vergroessert
   * diese Methode niemals das Risiko eines Trades — sie verkleinert es
   * nur. Das ist dieselbe Einbahn, die auch fuer die Grenzen des
   * Risikoprofils gilt (Regel 3a).
   *
   * ## Genau der Einstand, kein Aufschlag
   *
   * Die Gebuehren bleiben aussen vor: Der bereits realisierte
   * Take-Profit deckt sie. Beim BNBUSDT-Plan standen 5,32 USDT aus TP1
   * gegen 1,91 USDT Gebuehren. Ein Aufschlag wuerde den Stop enger an
   * den Kurs ruecken und ihn oefter ausloesen, ohne dass dem ein
   * nennenswerter Schutz gegenuebersteht.
   *
   * ## Verhaeltnis zu TC-Synaptrix
   *
   * Dies ist der Sofortschutz, nicht die letzte Instanz. Der Bot zieht
   * den Stop in dem Augenblick, in dem der Take-Profit greift; der
   * Rueckkanal meldet den Einstand an Synaptrix, und ein spaeteres
   * `update`-Signal darf ihn ueberschreiben. Ohne diesen Sofortschritt
   * laege zwischen Fill und Korrektur die Laufzeit der Warteschlange —
   * rund 20 bis 40 Sekunden, in denen der alte Stop an der Boerse
   * haengt.
   */
  private zieheStopAufEinstand(state: MonitorState, tpIndex: number): void {
    const einstand = this.durchschnittsEinstieg(state.plan.id);
    if (einstand == null || einstand <= 0) return;

    this.hebeStopAuf(state, einstand, {
      ereignis: 'sl_break_even',
      meldung: 'Stop auf den Einstand gezogen — der Plan kann ab jetzt nicht mehr ins Minus laufen',
      felder: { tp_index: tpIndex, grund: 'Stop auf den tatsaechlichen Einstand gezogen' },
    });
  }

  /**
   * Sichert, was bereits erreicht wurde.
   *
   * **Sind alle Take-Profits durch, darf der Stop nicht mehr unter den
   * letzten von ihnen fallen.**
   *
   * ## Warum ausgerechnet dann
   *
   * Die Signale ziehen den Stop stufenweise nach: TP2 setzt ihn auf
   * TP1, TP3 auf TP2, TP4 auf TP3. Das laesst dem Trade bewusst Luft
   * — eine Stufe Abstand, damit ein Ruecksetzer ihn nicht sofort
   * beendet.
   *
   * Nach dem LETZTEN Ziel kommt diese Stufe aber nicht mehr. Es gibt
   * kein TP5, das den Stop auf TP4 zoege; ab hier traegt allein das
   * Trailing — und wenn dessen Prozentsatz weiter ist als der Abstand
   * zwischen den letzten beiden Zielen, bleibt bereits erreichter
   * Gewinn unbesichert liegen.
   *
   * HYPEUSDT am 27.10.2026, alle vier Ziele erreicht:
   *
   * | | |
   * |---|---|
   * | TP4 gefuellt zu | 80,1464 |
   * | Stop danach (= TP3) | 79,6404 |
   * | Hoechstkurs seither | 80,497 |
   * | Trailing 1,5 % davon | 79,2895 — noch unter dem Stop |
   *
   * Das Trailing haette erst ab einem Kurs von 80,853 ueberhaupt
   * gegriffen. Bis dahin hingen 1,11 USDT bereits erreichter Gewinn
   * in der Luft.
   *
   * ## Nur nach dem letzten Ziel
   *
   * Nach jedem Ziel waere es falsch: Dann stuende der Stop staendig
   * eine Stufe zu eng, und die Luft, die das Signal dem Trade laesst,
   * waere weg. Erst wenn keine Stufe mehr folgt, wird aus dem Abstand
   * eine Luecke.
   *
   * ## Und nur mit Abstand zum Kurs
   *
   * Im Augenblick, in dem das letzte Ziel fuellt, steht der Kurs
   * genau auf dessen Preis. Ein Stop, der dort hingelegt wird, ist
   * kein Stop — er ist ein Verkauf zu Markt, nur umstaendlicher. Im
   * Test loeste er zweimal in derselben Sekunde aus und schloss mehr,
   * als offen war.
   *
   * Deshalb wartet die Grenze, bis der Kurs `MINDESTABSTAND_ZIEL_PCT`
   * darueber steht. Das ist wenig — gerade genug, damit aus dem
   * Sichern kein sofortiges Schliessen wird.
   */
  private sichereErreichteZiele(state: MonitorState, kurs: number): void {
    const tps = state.plan.take_profits ?? [];
    if (tps.length === 0) return;

    // Alle erreicht? Sonst zieht die naechste Stufe noch selbst nach.
    const alleErreicht = tps.every((_, i) => state.tpState[i]?.triggered === true);
    if (!alleErreicht) return;

    const istLong = state.plan.direction !== 'short';

    // Das beste erreichte Ziel — nicht einfach das letzte der Liste:
    // Die Reihenfolge ist nicht garantiert, und ein unsortierter Plan
    // ergaebe sonst einen zu niedrigen Stop. Der tatsaechliche
    // Fuellpreis geht vor dem geplanten, denn er ist das, was wirklich
    // erloest wurde.
    let bestes: number | null = null;
    for (let i = 0; i < tps.length; i++) {
      const preis = state.tpState[i]?.filledPrice ?? tps[i]?.price;
      if (preis == null || !Number.isFinite(preis) || preis <= 0) continue;
      if (bestes == null || (istLong ? preis > bestes : preis < bestes)) bestes = preis;
    }
    if (bestes == null) return;

    // Steht der Kurs noch zu dicht am Ziel, wird gewartet. Siehe oben:
    // Ein Stop auf Hoehe des Kurses ist ein Verkauf zu Markt.
    if (Number.isFinite(kurs) && kurs > 0) {
      const noetig = istLong
        ? bestes * (1 + MINDESTABSTAND_ZIEL_PCT / 100)
        : bestes * (1 - MINDESTABSTAND_ZIEL_PCT / 100);
      const weitGenug = istLong ? kurs >= noetig : kurs <= noetig;
      if (!weitGenug) return;
    }

    this.hebeStopAuf(state, bestes, {
      ereignis: 'sl_ziel_gesichert',
      meldung: 'Stop auf das letzte erreichte Ziel gehoben — alle Take-Profits sind durch',
      felder: { grund: 'Alle Ziele erreicht; der Stop darf nicht unter das letzte fallen' },
    });
  }

  /**
   * Hebt den Stop an — aber nur, wenn das das Risiko verkleinert.
   *
   * Die gemeinsame Mechanik hinter allen Untergrenzen: Einstand nach
   * dem ersten Take-Profit, letztes Ziel nach dem letzten. Beide
   * duerfen ausschliesslich in die sichere Richtung wirken — beim Long
   * nach oben, beim Short nach unten.
   *
   * Liegt der Stop bereits dort oder besser, geschieht nichts. Das ist
   * wichtiger, als es aussieht: Diese Pruefung laeuft bei jedem
   * Durchlauf, und ohne sie flaege die Stop-Order im Takt der
   * Kursabfrage hin und her.
   */
  private hebeStopAuf(
    state: MonitorState,
    ziel: number,
    wie: { ereignis: string; meldung: string; felder: Record<string, unknown> },
  ): void {
    if (!Number.isFinite(ziel) || ziel <= 0) return;

    const istLong = state.plan.direction !== 'short';
    const bisher = state.slCurrent;

    if (bisher != null) {
      // Schon dort? `naheBei` faengt das Rechenrauschen ab.
      if (naheBei(bisher, ziel)) return;
      // Schon besser? Dann bleibt, was da ist.
      if (istLong ? bisher > ziel : bisher < ziel) return;
    }

    state.slCurrent = ziel;

    // Den Typ nur umstellen, wenn kein Trailing laeuft. Sonst stuende
    // in der Anzeige "fixed", waehrend `updateTrailingStop` weiter
    // nachzieht — und der Nutzer saehe einen festen Stop, der wandert.
    if (!state.trailingActive) state.slType = 'fixed';

    this.persistMonitor(state);

    this.protokolliereEreignis(state.plan, wie.ereignis, {
      ...wie.felder,
      sl_vorher: bisher,
      sl_neu: ziel,
    });

    this.logger.warn({
      planId: state.plan.id, vorher: bisher, neu: ziel,
    }, wie.meldung);
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
      const ersterSl = isLong
        ? currentPrice * (1 - pct / 100)
        : currentPrice * (1 + pct / 100);

      // Auch hier nur in die sichere Richtung.
      //
      // Bisher wurde `slCurrent` bedingungslos gesetzt. Laeuft das
      // Trailing erst an, nachdem ein Take-Profit den Stop auf den
      // Einstand gezogen hat, ruecken die Prozente ihn wieder darunter
      // — der Schutz waere stillschweigend wieder weg. Dieselbe
      // Einbahn wie unten beim Nachziehen.
      if (state.slCurrent == null ||
          (isLong && ersterSl > state.slCurrent) ||
          (!isLong && ersterSl < state.slCurrent)) {
        state.slCurrent = ersterSl;
      }
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
        positionSide: plan.direction,
        leverage: plan.leverage,
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

      // Ein abgewiesener Stop hat nichts geschlossen.
      //
      // Er darf den Plan deshalb nicht abschliessen: Die Position steht
      // weiter im Markt, und zwar jenseits des Stops — der Fall, in dem
      // Aufsicht am noetigsten ist. Der Plan bleibt in Ueberwachung und
      // versucht es im naechsten Durchlauf erneut.
      if (result.status === 'rejected' || result.status === 'cancelled') {
        state.errorCount++;
        this.protokolliereEreignis(plan, 'sl_rejected', {
          sl_preis: state.slCurrent,
          menge: closeSize,
          kurs: currentPrice,
          trailing: state.trailingActive,
          broker_status: result.status,
        });
        this.logger.error({
          planId: plan.id, menge: closeSize, slPreis: state.slCurrent,
          kurs: currentPrice, status: result.status, broker: broker.name,
        }, 'Stop-Loss wurde abgewiesen — Position steht ungeschuetzt im Markt, wird erneut versucht');
        return;
      }

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
      this.planAbschliessen(plan);
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
        // Wann dieser Kurs gemessen wurde, steht nicht in der
        // Datenbank — und bleibt deshalb unbekannt, bis der naechste
        // Durchlauf einen frischen holt.
        lastPriceAt: null,
        errorCount: (m.error_count as number) ?? 0,
        triggeredEntries: bereitsPlatziert,
        signalFreigabe: bereitsPlatziert.size > 0,
        einstiegeStorniert: false,
      };
      this.states.set(plan.id, state);
      state.remainingSize = this.offenePosition(state);
    }
    this.logger.info({ count: this.states.size }, 'Aktive Monitor-Zustaende geladen');

    this.widersprucheAufloesen();
  }

  /**
   * Gleicht Plaene ab, die laut Monitor fertig sind, laut Plan aber
   * noch laufen.
   *
   * Der Monitor setzte beim Abschliessen lange nur seinen eigenen
   * Zustand; der Plan blieb auf 'active'. Die Uebersichten fragen den
   * Plan — solche Trades standen danach fuer immer unter den aktiven,
   * mit offener Position 0 und ohne dass noch etwas geschah.
   *
   * Laeuft beim Hochfahren und raeumt damit auch die auf, die vor der
   * Korrektur entstanden sind.
   */
  private widersprucheAufloesen(): void {
    let aufgeraeumt = 0;

    for (const w of this.store.getAbgeschlosseneMitAktivemPlan()) {
      const planRaw = this.store.getBotTradePlan(w.trade_plan_id);
      if (!planRaw) continue;

      // Nur, wenn wirklich nichts mehr offen ist. Sonst waere der Plan
      // zu Unrecht abgeschlossen, und die Position fiele aus der
      // Aufsicht — der schlimmere der beiden Fehler.
      const offen = this.offenePositionVon(w.trade_plan_id);
      if (offen > 0) {
        this.logger.warn({
          planId: w.trade_plan_id, offen, monitorStatus: w.monitor_status,
        }, 'Monitor meldet abgeschlossen, aber es steht noch etwas im Markt — bleibt unter Aufsicht');
        continue;
      }

      const neuerStatus = this.hatJeEingestiegen(w.trade_plan_id) ? 'completed' : 'cancelled';
      this.store.updateBotTradePlanStatus(w.trade_plan_id, neuerStatus);
      aufgeraeumt++;

      this.logger.warn({
        planId: w.trade_plan_id, symbol: planRaw.symbol,
        vorher: planRaw.status, nachher: neuerStatus,
      }, 'Plan war beendet, stand aber noch als aktiv — nachgezogen');
    }

    if (aufgeraeumt > 0) {
      this.logger.info({ aufgeraeumt }, 'Widersprueche zwischen Plan und Monitor aufgeloest');
    }
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
  /**
   * Schreibt den Abschluss eines Plans in die Datenbank.
   *
   * Der Monitor setzte bisher nur seinen eigenen Zustand auf
   * 'completed'; der Plan in `bot_trade_plans` blieb auf 'active'.
   * Beide Angaben liefen damit auseinander — und die Uebersichten
   * fragen den Plan, nicht den Monitor. Ein durch Stop-Loss beendeter
   * Trade stand deshalb weiter unter den aktiven, mit offener Position
   * 0 und ohne dass noch etwas geschah.
   */
  private planAbschliessen(plan: TradePlan): void {
    try {
      plan.status = 'completed';
      this.store.updateBotTradePlanStatus(plan.id, 'completed');
    } catch (err) {
      this.logger.error({ err, planId: plan.id }, 'Abschluss liess sich nicht speichern');
    }
  }

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

/**
 * Sind zwei Zahlen praktisch gleich?
 *
 * Mengen und Preise entstehen aus Multiplikationen und tragen
 * Gleitkomma-Staub: 0.1 * 3 ergibt 0.30000000000000004. Ohne Toleranz
 * gaelte jede Order bei jedem Durchlauf als veraendert — sie wuerde
 * zurueckgenommen und neu gelegt, im Takt der Kursabfrage.
 *
 * Die Toleranz ist relativ, damit sie fuer BTC (80.000) ebenso passt
 * wie fuer eine Muenze zu 0,004.
 */
function naheBei(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const groesser = Math.max(Math.abs(a), Math.abs(b));
  if (groesser === 0) return true;
  return Math.abs(a - b) / groesser < 1e-9;
}

/**
 * Meinen zwei Schreibweisen denselben Markt?
 *
 * BTCUSDT, BTC/USDT, BTC/USDT:USDT und btcusdt sind dasselbe. Die
 * Pruefung darf nicht an der Schreibweise scheitern — sonst verwuerfe
 * sie richtige Meldungen.
 */
function gleichesSymbol(a: string, b: string): boolean {
  const schlicht = (s: string) => s
    .toUpperCase()
    .replace(/\.P$/, '')
    .replace(/:.*$/, '')
    .replace(/[/\-_]/g, '');
  return schlicht(a) === schlicht(b);
}
