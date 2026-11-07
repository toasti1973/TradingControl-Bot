// ============================================================
// TcPlanSyncService — holt Handelsplaene aus TradingControl ab
//   - Pull alle 30s via /api/v1/bot/plans
//   - Indicators-Catalog via /api/v1/bot/indicators-catalog (1x/Tag)
//
// Einbahnstrasse: Der Bot liest Plaene, er meldet nichts zurueck. Was an
// der Boerse tatsaechlich geschah, holt sich das Journal ueber seinen
// eigenen API-Import direkt bei der Boerse.
// ============================================================

import type { TcApiClient, TradePlan, IndicatorsCatalog } from '@tradingcontrol/core';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Logger } from './log-service.js';
import type { TradePlanMonitor } from './trade-plan-monitor.js';

export interface TcPlanSyncConfig {
  pullIntervalMs?: number;       // Default: 30s
  catalogTtlMs?: number;         // Default: 24h
}

export class TcPlanSyncService {
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private catalogCache: { catalog: IndicatorsCatalog; expires: number } | null = null;
  private running = false;

  private readonly pullMs: number;
  private readonly catalogTtl: number;

  constructor(
    private readonly client: TcApiClient,
    private readonly store: SqliteStore,
    private readonly monitor: TradePlanMonitor,
    private readonly logger: Logger,
    config: TcPlanSyncConfig = {},
  ) {
    this.pullMs = config.pullIntervalMs ?? 30_000;
    this.catalogTtl = config.catalogTtlMs ?? 24 * 3600_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Sofort initial pull
    void this.syncPlans();
    void this.syncCatalog();

    this.pullTimer = setInterval(() => void this.syncPlans(), this.pullMs);
    this.logger.info({ pullMs: this.pullMs }, 'TcPlanSyncService gestartet (nur lesend)');
  }

  stop(): void {
    this.running = false;
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = null;
  }

  // ============================================================
  // Plans pullen + in DB persistieren
  // ============================================================

  async syncPlans(): Promise<{ added: number; updated: number; removed: number }> {
    let plans: TradePlan[];
    try {
      plans = await this.client.getPlans();
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'TC-Plans Pull fehlgeschlagen');
      return { added: 0, updated: 0, removed: 0 };
    }

    let added = 0;
    let updated = 0;
    const tcPlanIds = new Set<string>();

    for (const plan of plans) {
      tcPlanIds.add(plan.id);
      const existing = this.store.getBotTradePlan(plan.id);
      if (existing) {
        updated++;
      } else {
        added++;
      }

      // Welche Entry-Orders bereits ausgefuehrt sind, weiss allein der Bot —
      // er meldet es nicht ans Journal, also kann das Journal es auch nicht
      // zurueckliefern. Der lokale Stand ist deshalb die Wahrheit und wird
      // hier bewahrt; wuerde man ihn mit dem (stets leeren) Server-Feld
      // ueberschreiben, platzierte der Bot dieselben Einstiege erneut.
      const executedOrders = this.mergeExecutedOrders(existing, plan);

      // In bot_trade_plans speichern
      this.store.upsertBotTradePlan({
        id: plan.id,
        source: 'tc',
        tc_user_id: plan.user_id,
        exchange: this.boerseFuerTcPlan(plan.exchange, plan.id),
        exchange_account_id: plan.exchange_account_id,
        symbol: plan.symbol,
        asset_symbol: plan.asset_symbol,
        quote_currency: plan.quote_currency,
        market_type: plan.market_type,
        direction: plan.direction,
        leverage: plan.leverage,
        total_size: plan.total_size,
        total_margin: plan.total_margin,
        entry_orders: JSON.stringify(plan.entry_orders ?? []),
        entry_zones: plan.entry_zones ? JSON.stringify(plan.entry_zones) : null,
        take_profits: JSON.stringify(plan.take_profits ?? []),
        stop_loss_price: plan.stop_loss_price,
        stop_loss_type: plan.stop_loss_type,
        trailing_stop_pct: plan.trailing_stop_pct,
        trailing_stop_activation: plan.trailing_stop_activation,
        trailing_stop_size_pct: plan.trailing_stop_size_pct ?? null,
        activation_conditions: JSON.stringify(plan.activation_conditions ?? []),
        executed_orders: JSON.stringify(executedOrders),
        // Das Journal kennt keinen Ausfuehrungsmodus pro Plan. Ein einmal
        // lokal gewaehlter Modus bleibt deshalb erhalten.
        execution_mode: (existing?.execution_mode as string) ?? 'all_limit',
        status: plan.status,
        bot_enabled: plan.bot_enabled,
        // Felder, die /api/v1/bot/plans nicht mitliefert: den vorhandenen
        // Stand behalten statt ihn mit undefined zu ueberschreiben.
        entry_strategy: plan.entry_strategy ?? (existing?.entry_strategy as string) ?? 'single',
        notes: plan.notes ?? (existing?.notes as string | null) ?? null,
      });

      // Der Plan, mit dem der Monitor arbeitet, traegt den lokalen
      // Ausfuehrungsstand — nicht den (leeren) des Journals.
      const planForMonitor: TradePlan = { ...plan, source: 'tc', executed_orders: executedOrders };

      // Im Monitor anmelden (nur wenn aktiv und noch nicht angemeldet)
      const shouldMonitor = plan.bot_enabled &&
        ['planned', 'active', 'monitoring', 'executing'].includes(plan.status);
      const monitorState = this.monitor.getState(plan.id);
      const isMonitored = !!monitorState;

      if (shouldMonitor && !isMonitored) {
        this.monitor.registerPlan(planForMonitor);
      } else if (!shouldMonitor && isMonitored) {
        this.monitor.unregisterPlan(plan.id);
      } else if (shouldMonitor && isMonitored && monitorState && existing) {
        // Plan-Diff: updated_at verglichen mit gespeichertem Stand
        const oldUpdatedAt = existing.updated_at as string;
        if (oldUpdatedAt !== plan.updated_at) {
          await this.monitor.updatePlan(planForMonitor);
          this.logger.info({ planId: plan.id, oldUpdate: oldUpdatedAt, newUpdate: plan.updated_at }, 'Plan-Update erkannt');
        }
      }
    }

    // Plaene, die das Journal nicht mehr fuehrt.
    //
    // Vorsicht ist hier geboten: "Nicht mehr in der Antwort" heisst nicht
    // zwingend "geloescht". Die Schnittstelle liefert nur die Status
    // 'active' und 'planned' — ein Plan, der auf 'executing' wechselt,
    // verschwindet daraus, obwohl er gerade laeuft. Wer ihn dann abmeldet,
    // storniert Orders mitten in einer offenen Position.
    //
    // Deshalb: Plaene mit offener Position oder offenen Orders bleiben
    // unter Aufsicht. Erst wenn nichts mehr offen ist, wird abgemeldet.
    let removed = 0;
    const localTcPlans = this.store.getBotTradePlans({ source: 'tc' });
    for (const local of localTcPlans) {
      const id = local.id as string;
      if (tcPlanIds.has(id)) continue;

      // Schon erledigt? Dann nichts weiter tun.
      //
      // Ein stornierter Plan bleibt in der Datenbank stehen — geloescht
      // wird hier nichts. Ohne diese Zeile fiele er bei jedem Abgleich
      // erneut durch das Aufraeumen: dieselbe Meldung alle 30 Sekunden
      // und ein `beendePlan` auf einen Plan, an dem nichts mehr ist.
      const status = String(local.status ?? '');
      if (status === 'cancelled' || status === 'completed' || status === 'error') continue;

      // **Position oder nur liegende Orders? Das ist ein Unterschied.**
      //
      // Bei einer offenen Position bleibt die Aufsicht — dort haengt
      // ein Stop dran, und das Verschwinden aus der Antwort ist
      // mehrdeutig (siehe oben: 'executing' verschwindet ebenfalls).
      //
      // Liegen dagegen nur Kauf-Limits und ist nichts gefuellt, gibt
      // es nichts zu schuetzen. Hier blieb der Plan frueher auf
      // ewig haengen: Die Aufsicht verhinderte das Abmelden, aber
      // niemand nahm die Orders zurueck — und solange sie lagen,
      // galt er als "noch offen". Ein Kreis ohne Ausgang.
      if (this.hatOffenePosition(id)) {
        this.logger.info(
          { planId: id },
          'Plan nicht mehr in der Journal-Antwort, aber mit offener Position — Aufsicht bleibt bestehen',
        );
        continue;
      }

      // Nichts gefuellt: Die liegenden Orders koennen weg. Danach ist
      // der Plan wirklich erledigt.
      //
      // `beendePlan` statt `unregisterPlan`: Es nimmt die Orders an
      // der Boerse zurueck. Ein blosses Abmelden liesse sie liegen,
      // und ein Kauf-Limit, das Stunden spaeter fuellt, eroeffnete
      // eine Position, die kein Plan mehr beaufsichtigt.
      if (typeof this.monitor.beendePlan === 'function') {
        void this.monitor.beendePlan(id, 'benutzer_abbruch')
          .then(e => {
            this.logger.info(
              { planId: id, stornierte: e.stornierteOrders },
              'Plan aus dem Journal verschwunden und ohne Position — Orders zurueckgenommen',
            );
          })
          .catch(err => {
            // Kein Abbruch: Beim naechsten Abgleich wird es erneut
            // versucht. Der Plan bleibt solange stehen und sichtbar.
            this.logger.warn(
              { err, planId: id },
              'Orders des verschwundenen Plans liessen sich nicht zuruecknehmen',
            );
          });
      } else {
        // Aelterer Aufbau ohne `beendePlan` — dann wenigstens abmelden.
        this.monitor.unregisterPlan(id);
      }

      this.store.updateBotTradePlanStatus(id, 'cancelled');
      removed++;
    }

    this.logger.info({ added, updated, removed, total: plans.length }, 'TC-Plans synchronisiert');
    return { added, updated, removed };
  }

  // ============================================================
  // Indicators-Catalog cachen
  // ============================================================

  async syncCatalog(): Promise<IndicatorsCatalog | null> {
    if (this.catalogCache && Date.now() < this.catalogCache.expires) {
      return this.catalogCache.catalog;
    }
    try {
      const catalog = await this.client.getIndicatorsCatalog();
      this.catalogCache = { catalog, expires: Date.now() + this.catalogTtl };
      this.logger.info({
        intervals: catalog.intervals.length,
        indicators: catalog.indicators.length,
      }, 'Indicators-Catalog geladen');
      return catalog;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Indicators-Catalog Pull fehlgeschlagen');
      return null;
    }
  }

  getCatalog(): IndicatorsCatalog | null {
    return this.catalogCache?.catalog ?? null;
  }

  /**
   * Ist zu diesem Plan noch etwas offen — eine Position oder eine Order?
   *
   * Entscheidet darueber, ob ein aus der Journal-Antwort verschwundener
   * Plan abgemeldet werden darf. Im Zweifel lautet die Antwort ja: Eine
   * Aufsicht zu viel kostet nichts, eine zu wenig laesst eine offene
   * Position unbeaufsichtigt.
   */
  /**
   * Steht fuer diesen Plan wirklich etwas im Markt?
   *
   * Gerechnet aus den Orders: gefuellte Einstiege minus dessen, was
   * Ziele und Stop schon geschlossen haben. **Liegende Orders zaehlen
   * nicht** — sie sind Absicht, keine Position.
   *
   * Der Unterschied entscheidet, ob ein aus dem Journal verschwundener
   * Plan unter Aufsicht bleibt. Frueher galt auch ein unberuehrtes
   * Kauf-Limit als "offen"; damit blieb der Plan ewig stehen, denn
   * das Zuruecknehmen der Orders geschah nur beim Abmelden, und
   * abgemeldet wurde er nie.
   */
  private hatOffenePosition(planId: string): boolean {
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

    // Rechenrauschen abschneiden, wie ueberall bei Mengen.
    return eingestiegen - geschlossen > 1e-9;
  }


  // ============================================================
  // Ausfuehrungsstand zusammenfuehren
  // ============================================================

  /**
   * Vereinigt den lokal bekannten Ausfuehrungsstand mit dem des Journals.
   *
   * Vereinigung, nicht Ersetzung: Das Journal erfaehrt vom Bot nichts, sein
   * Feld ist im Regelbetrieb leer. Wuerde es den lokalen Stand ersetzen,
   * gaelte jeder bereits platzierte Einstieg wieder als offen — der Bot
   * kaufte beim naechsten Durchlauf ein zweites Mal.
   *
   * Zusaetzlich fliessen die tatsaechlich abgeschickten Einstiegs-Orders aus
   * der lokalen Order-Tabelle ein. Damit ueberlebt der Stand auch den Fall,
   * dass der Bot zwischen Order und Persistierung des Plans abstuerzt.
   */
  /**
   * Welche Boerse gilt fuer einen Plan aus dem Journal?
   *
   * Der Plan bringt seine eigene mit — das Journal weiss, auf welchem
   * Boersen-Konto er gedacht war. **Sie gilt, aber nur wenn sie im
   * Bot auch eingerichtet und aktiv ist.**
   *
   * Warum die Einschraenkung: Das Journal fuehrt Boersen, die der Bot
   * gar nicht bedient. Ein Plan auf einem dort hinterlegten Konto
   * wuerde sonst auf eine Boerse zeigen, zu der es hier keinen Zugang
   * gibt — und bei jedem Durchlauf mit einem Fehler abbrechen, statt
   * sichtbar zu ruhen.
   *
   * Faellt die Boerse weg, greift der Uebungsbroker. Das ist die
   * stille, aber ungefaehrliche Richtung: Der Plan laeuft, man sieht
   * ihn, und er bewegt kein Geld. Vermerkt wird es trotzdem — eine
   * Umleitung, die niemand bemerkt, waere eine schlechte.
   */
  private boerseFuerTcPlan(genannt: string | null | undefined, planId: string): string {
    const name = String(genannt ?? '').trim().toLowerCase();

    // 'unknown' liefert die Schnittstelle, wenn dem Plan im Journal
    // kein Boersen-Konto zugeordnet ist.
    if (!name || name === 'unknown') return 'paper';
    if (name === 'paper') return 'paper';

    // Ohne Auskunft bleibt es beim Uebungsbetrieb — dieselbe Einbahn
    // wie ueberall: Wer nicht antworten kann, antwortet sicher.
    let eingerichtet: Record<string, unknown> | undefined;
    try {
      if (typeof this.store.boersenEinstellungen !== 'function') return 'paper';
      eingerichtet = this.store.boersenEinstellungen()
        .find(e => String(e.exchange) === name);
    } catch {
      return 'paper';
    }

    if (!eingerichtet) {
      this.logger.info(
        { planId, boerse: name },
        'TC-Plan nennt eine Boerse, die im Bot nicht eingerichtet ist — er laeuft im Uebungsbetrieb',
      );
      return 'paper';
    }

    if (eingerichtet.aktiv === 0) {
      this.logger.info(
        { planId, boerse: name },
        'TC-Plan nennt eine abgeschaltete Boerse — er laeuft im Uebungsbetrieb',
      );
      return 'paper';
    }

    // Ob dort geuebt oder echt gehandelt wird, entscheidet weiterhin
    // `boerseUebt()` beim Aufbau des Zugangs. Hier geht es nur darum,
    // WELCHE Boerse gemeint ist.
    return name;
  }

  private mergeExecutedOrders(
    existing: Record<string, unknown> | undefined,
    plan: TradePlan,
  ): string[] {
    const merged = new Set<string>();

    for (const id of plan.executed_orders ?? []) merged.add(id);

    if (existing?.executed_orders) {
      try {
        const local = JSON.parse(existing.executed_orders as string) as string[];
        for (const id of local) merged.add(id);
      } catch {
        this.logger.warn({ planId: plan.id }, 'Lokaler Ausfuehrungsstand unlesbar — wird aus den Orders rekonstruiert');
      }
    }

    // Rueckfallebene: jede Einstiegs-Order, die den Bot verlassen hat, zaehlt
    // als ausgefuehrt. Storniert wurde sie nur, wenn der Plan storniert wurde.
    for (const order of this.store.getPlanOrders(plan.id)) {
      if (order.role !== 'entry') continue;
      if (order.status === 'cancelled' || order.status === 'rejected') continue;
      const entryOrderId = order.entry_order_id as string | null;
      if (entryOrderId) merged.add(entryOrderId);
    }

    return Array.from(merged);
  }
}
