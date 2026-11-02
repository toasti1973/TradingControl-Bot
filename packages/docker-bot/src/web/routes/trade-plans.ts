// ============================================================
// Bot Trade-Plans API (UI + lokale Pläne + TC-Sync-Status)
// ============================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { EntryStrategyCalculator } from '@tradingcontrol/core';
import type { EntryZone } from '@tradingcontrol/core';
import type { SqliteStore } from '../../store/sqlite-store.js';
import type { TradePlanMonitor } from '../../services/trade-plan-monitor.js';
import type { TcPlanSyncService } from '../../services/tc-plan-sync-service.js';
import { VerlaufService } from '../../services/verlauf-service.js';
import { ErgebnisService } from '../../services/ergebnis-service.js';
import { KerzenService, ERLAUBTE_INTERVALLE, type Intervall } from '../../services/kerzen-service.js';

export function createTradePlansRouter(
  store: SqliteStore,
  monitor: TradePlanMonitor,
  sync: TcPlanSyncService,
  kerzen: KerzenService,
): Router {
  const router = Router();
  const calc = new EntryStrategyCalculator();
  const verlaufService = new VerlaufService(store);
  const ergebnisService = new ErgebnisService(store);

  // ============================================================
  // GET — Liste aller Plaene (TC + lokal)
  // ============================================================
  router.get('/api/trade-plans', (req, res) => {
    const source = req.query.source as 'tc' | 'local' | undefined;
    const status = req.query.status as string | undefined;
    const symbol = req.query.symbol as string | undefined;
    const plans = store.getBotTradePlans({ source, status, symbol });
    res.json({ plans, count: plans.length });
  });

  // ============================================================
  // POST — Neuen lokalen Plan erstellen
  // ============================================================
  router.post('/api/trade-plans', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const id = (body.id as string) ?? randomUUID();

      // Zone-Validierung (falls vorhanden)
      const zones = body.entry_zones as EntryZone[] | null | undefined;
      if (zones && zones.length > 0) {
        const v = calc.validateZones(zones);
        if (!v.valid) return void res.status(400).json({ error: v.reason });
      }

      // Entry-Orders aus Zonen berechnen falls nicht explizit gegeben
      let entryOrders = body.entry_orders as unknown[] | null | undefined ?? [];
      if (zones && zones.length > 0 && (!entryOrders || (entryOrders as unknown[]).length === 0)) {
        entryOrders = calc.calculateAllOrders(zones, body.total_size as number);
      }

      // UUIDs sicherstellen
      const ensured = calc.ensureIds(entryOrders as Parameters<typeof calc.ensureIds>[0], zones ?? undefined);

      store.upsertBotTradePlan({
        id,
        source: 'local',
        symbol: body.symbol as string,
        asset_symbol: body.asset_symbol as string,
        quote_currency: (body.quote_currency as string) ?? 'USDT',
        market_type: (body.market_type as string) ?? 'futures',
        direction: body.direction as string,
        leverage: (body.leverage as number) ?? 1,
        total_size: body.total_size as number,
        total_margin: body.total_margin as number | null,
        entry_strategy: (body.entry_strategy as string) ?? 'single',
        entry_orders: JSON.stringify(ensured.orders),
        entry_zones: ensured.zones ? JSON.stringify(ensured.zones) : null,
        take_profits: JSON.stringify(body.take_profits ?? []),
        stop_loss_price: body.stop_loss_price as number | null,
        stop_loss_type: (body.stop_loss_type as string) ?? 'fixed',
        trailing_stop_pct: body.trailing_stop_pct as number | null,
        trailing_stop_activation: body.trailing_stop_activation as number | null,
        trailing_stop_size_pct: body.trailing_stop_size_pct as number | null,
        activation_conditions: JSON.stringify(body.activation_conditions ?? []),
        executed_orders: '[]',
        execution_mode: (body.execution_mode as string) ?? 'all_limit',
        status: 'planned',
        bot_enabled: body.bot_enabled !== false,
        notes: body.notes as string | null,
      });

      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Fehler beim Anlegen' });
    }
  });

  // ============================================================
  // PATCH /:id/status — Status aendern (Plan starten/cancellen)
  // ============================================================
  router.patch('/api/trade-plans/:id/status', async (req, res) => {
    const id = req.params.id!;
    const newStatus = (req.body as { status?: string }).status;
    const plan = store.getBotTradePlan(id);
    if (!plan) return void res.status(404).json({ error: 'Plan nicht gefunden' });

    if (!['planned', 'active', 'monitoring', 'executing', 'completed', 'cancelled'].includes(newStatus ?? '')) {
      return void res.status(400).json({ error: 'Ungueltiger Status' });
    }

    // Ein Abbruch ueber diesen Weg wird wie ein Beenden behandelt.
    //
    // Frueher stand hier `monitor.unregisterPlan(id)`, und das war ein
    // Fehler mit Folgen: Die Methode nimmt den Plan sofort aus der
    // Ueberwachung. Das Aufraeumen der Orders geschieht aber im
    // Poll-Durchlauf (processPlan, Schritt 0) — der diesen Plan dann nie
    // wieder sieht. Offene Kauf-Limits blieben an der Boerse liegen und
    // eine offene Position ohne jede Ueberwachung zurueck.
    if (newStatus === 'cancelled' || newStatus === 'completed') {
      try {
        const ergebnis = await monitor.beendePlan(id, 'benutzer_abbruch');
        store.updateBotTradePlanStatus(id, ergebnis.status);
        return void res.json({ success: true, ...ergebnis });
      } catch (err) {
        // Der Status bleibt unveraendert: Ein Plan, dessen Position sich
        // nicht schliessen liess, darf nicht als beendet dastehen.
        return void res.status(500).json({
          error: err instanceof Error ? err.message : 'Beenden fehlgeschlagen',
          hinweis: 'Der Plan bleibt unter Aufsicht. Position und Orders wurden nicht angetastet.',
        });
      }
    }

    store.updateBotTradePlanStatus(id, newStatus!);

    if (newStatus === 'active' || newStatus === 'monitoring') {
      // Frisch aus der Datenbank lesen, nicht die oben geholte Zeile
      // nehmen: Die stammt von VOR dem Statuswechsel und traegt noch
      // 'planned'. Der Monitor laesst Plaene in diesem Status
      // unangetastet — ein so angemeldeter Plan wurde nie ausgefuehrt.
      const aktuell = store.getBotTradePlan(id);
      if (!aktuell) return void res.status(404).json({ error: 'Plan nicht gefunden' });
      monitor.registerPlan(deserializePlan(aktuell));
    }

    res.json({ success: true });
  });

  // ============================================================
  // POST /:id/beenden — Plan beenden: aufraeumen, dann abmelden
  // ============================================================
  //
  // Der Weg fuer "Plan stoppen" aus der Oberflaeche. Was dabei geschieht,
  // haengt vom Stand des Plans ab und wird zurueckgemeldet:
  //
  //   - offene Position  → zu Markt geschlossen, Status 'completed'
  //   - nur offene Orders → zurueckgenommen, Status 'cancelled'
  //
  // Scheitert das Schliessen der Position, bleibt der Plan unter
  // Aufsicht und die Antwort sagt es. Ein Plan, der als beendet gilt,
  // aber noch im Markt steht, waere das schlechtere Ergebnis.
  router.post('/api/trade-plans/:id/beenden', async (req, res) => {
    const id = req.params.id!;
    const plan = store.getBotTradePlan(id);
    if (!plan) return void res.status(404).json({ error: 'Plan nicht gefunden' });

    if (plan.status === 'completed' || plan.status === 'cancelled') {
      return void res.status(400).json({ error: 'Der Plan ist bereits beendet' });
    }

    try {
      const ergebnis = await monitor.beendePlan(id, 'benutzer_beendet');
      store.updateBotTradePlanStatus(id, ergebnis.status);

      res.json({
        success: true,
        status: ergebnis.status,
        geschlosseneMenge: ergebnis.geschlosseneMenge,
        stornierteOrders: ergebnis.stornierteOrders,
        ergebnis: ergebnisService.fuerPlan(
          id,
          // Normalisiert wie in dashboard.ts, plans.ts und trades.ts —
          // ein ungeprueftes `as` liesse einen abweichenden Wert
          // durch, und das Vorzeichen haengt daran.
          plan.direction === 'short' ? 'short' : 'long',
          Number(plan.leverage) || 1,
          monitor.getState(id)?.lastPrice ?? null,
        ),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Beenden fehlgeschlagen',
        hinweis: 'Der Plan bleibt unter Aufsicht. Position und Orders wurden nicht angetastet.',
      });
    }
  });

  // ============================================================
  // DELETE — Plan loeschen
  // ============================================================
  router.delete('/api/trade-plans/:id', (req, res) => {
    const id = req.params.id!;
    const plan = store.getBotTradePlan(id);
    if (!plan) return void res.status(404).json({ error: 'Plan nicht gefunden' });
    if (plan.source === 'tc') return void res.status(400).json({ error: 'TC-Plaene koennen nicht lokal geloescht werden' });

    monitor.unregisterPlan(id);
    store.deleteBotTradePlan(id);
    res.json({ success: true });
  });

  // ============================================================
  // POST /sync — Manueller Sync mit TC
  // ============================================================
  router.post('/api/trade-plans/sync', async (_req, res) => {
    try {
      const result = await sync.syncPlans();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Sync fehlgeschlagen' });
    }
  });

  // ============================================================
  // GET /catalog — Indicator-Catalog
  // ============================================================
  router.get('/api/trade-plans/catalog', async (_req, res) => {
    let catalog = sync.getCatalog();
    if (!catalog) catalog = await sync.syncCatalog();
    res.json({ catalog });
  });

  // ============================================================
  // GET /monitors/status — Status aller aktiven Monitor
  // ============================================================
  router.get('/api/trade-plans/monitors/status', (_req, res) => {
    const states = monitor.getAllStates().map(s => ({
      planId: s.plan.id,
      symbol: s.plan.symbol,
      status: s.status,
      activationStep: s.activationStep,
      activationTotal: (s.plan.activation_conditions ?? []).length,
      slCurrent: s.slCurrent,
      slType: s.slType,
      trailingActive: s.trailingActive,
      trailingBestPrice: s.trailingBestPrice,
      remainingSize: s.remainingSize,
      lastPrice: s.lastPrice,
      lastPriceAt: s.lastPriceAt,
      tpsTriggered: s.tpState.filter(t => t.triggered).length,
      tpsTotal: s.tpState.length,
      errorCount: s.errorCount,
    }));
    res.json({ monitors: states, count: states.length });
  });

  // ============================================================
  // GET /:id/kerzen — Kursverlauf fuer die Chart-Ansicht
  // ============================================================
  //
  // MUSS vor der :id-Route stehen, sonst schluckt die den Pfad.
  router.get('/api/trade-plans/:id/kerzen', async (req, res) => {
    const plan = store.getBotTradePlan(req.params.id!);
    if (!plan) return void res.status(404).json({ error: 'Plan nicht gefunden' });

    const roh = String(req.query.intervall ?? '15m');
    const intervall = (ERLAUBTE_INTERVALLE as readonly string[]).includes(roh)
      ? roh as Intervall
      : '15m';
    const anzahl = Math.min(parseInt(String(req.query.anzahl ?? '200'), 10) || 200, 1000);

    const ergebnis = await kerzen.hole(
      String(plan.exchange ?? 'paper'), String(plan.symbol), intervall, anzahl,
      String(plan.market_type) === 'spot' ? 'spot' : 'futures',
    );

    res.json({
      symbol: plan.symbol,
      intervall,
      ...ergebnis,
      // Die Marken fuer den Chart: Wo lagen Einstiege, Ziele und Stop?
      //
      // Der Monitor kommt mit: Sein Stop ist der GELTENDE, und der
      // wandert — nach einem Take-Profit nachgezogen oder als
      // Trailing mitlaufend.
      marken: planMarken(plan, monitor.getState(req.params.id!)),
      // Und wo tatsaechlich gehandelt wurde — mit Zeitpunkt.
      fuellungen: planFuellungen(store, String(plan.id)),
      // Wann das Signal eintraf und wie der Markt da stand.
      signalzeit: signalLage(plan),
    });
  });

  // GET — Einzelner Plan inkl. Monitor-State (MUSS am Ende stehen wegen :id)
  router.get('/api/trade-plans/:id', (req, res) => {
    const plan = store.getBotTradePlan(req.params.id!);
    if (!plan) return void res.status(404).json({ error: 'Plan nicht gefunden' });

    const monitorState = monitor.getState(req.params.id!);
    const orders = store.getPlanOrders(req.params.id!);

    // Der Verlauf kommt aus dem Protokoll, nicht aus dem Monitor: Nach
    // dem Abschluss eines Plans gibt es keinen Monitor-Zustand mehr —
    // und gerade dann will man wissen, wie der Trade ausging.
    const verlauf = verlaufService.fuerPlan(req.params.id!);

    // Das Ergebnis ebenso aus den Orders — aus demselben Grund. Der
    // Kurs fuer das nicht realisierte Ergebnis kommt vom Monitor;
    // fehlt er, bleibt nur das realisierte stehen.
    const ergebnis = ergebnisService.fuerPlan(
      req.params.id!,
      plan.direction === 'short' ? 'short' : 'long',
      Number(plan.leverage) || 1,
      monitorState?.lastPrice ?? null,
    );

    res.json({ plan, monitor: monitorState, orders, verlauf, ergebnis });
  });

  return router;
}

// ============================================================
// Hilfsfunktion zum Deserialisieren (gleich wie Monitor)
// ============================================================
function deserializePlan(row: Record<string, unknown>) {
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
    signal_trigger: row.signal_trigger ? JSON.parse(row.signal_trigger as string) : null,
    executed_orders: JSON.parse((row.executed_orders as string) ?? '[]'),
    status: row.status as 'planned' | 'active' | 'monitoring' | 'executing' | 'completed' | 'cancelled' | 'error',
    bot_enabled: !!row.bot_enabled,
    notes: row.notes as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Wann das Signal eintraf — und wie der Markt da stand.
 *
 * Erst diese Marke beantwortet die Frage, die aus den Kerzen allein
 * nicht hervorgeht: War der Kurs VOR oder NACH dem Signal in den
 * Einstiegen?
 *
 * Am 26.10. lag ein BTCUSDT-Short 13 Minuten daneben. Der Chart zeigte
 * Kerzen weit ueber dem ersten Einstieg, und es sah aus, als haette
 * der Bot sie verschlafen — tatsaechlich kam das Signal erst, als der
 * Kurs schon wieder gefallen war. Ohne senkrechte Marke ist das nicht
 * zu sehen.
 */
export function signalLage(plan: Record<string, unknown>): {
  zeitpunkt: string;
  kurs: number | null;
  abstandPct: number | null;
  ausserhalb: boolean;
} | null {
  const roh = plan.signal_origin;
  if (!roh) return null;

  let herkunft: {
    received_at?: string; emitted_at?: string;
    marktlage?: { kurs?: number; abstandPct?: number; ausserhalb?: boolean };
  };
  try {
    herkunft = typeof roh === 'string' ? JSON.parse(roh) : roh as typeof herkunft;
  } catch {
    return null;
  }

  const zeitpunkt = herkunft.received_at ?? herkunft.emitted_at;
  if (!zeitpunkt) return null;

  const lage = herkunft.marktlage;
  return {
    zeitpunkt,
    kurs: lage?.kurs ?? null,
    abstandPct: lage?.abstandPct ?? null,
    ausserhalb: lage?.ausserhalb === true,
  };
}

/**
 * Die tatsaechlichen Fuellungen eines Plans — mit Zeitpunkt.
 *
 * Die Preismarken sagen, wo etwas GEPLANT war; diese Liste sagt, wo
 * und WANN wirklich gehandelt wurde. Erst zusammen ergibt der Chart
 * die ganze Geschichte: Ein Einstieg, der zwei Cent ueber seinem
 * Limit fuellte, ein Stop, der einen Docht tiefer griff.
 */
export function planFuellungen(store: SqliteStore, planId: string): Array<{
  art: string; preis: number; menge: number; zeitpunkt: string; beschriftung: string;
}> {
  const nummer: Record<string, number> = {};

  return store.getPlanOrders(planId)
    .filter(o => (Number(o.filled_quantity) || 0) > 0 && (Number(o.avg_fill_price) || 0) > 0)
    .map(o => {
      const rolle = String(o.role);
      nummer[rolle] = (nummer[rolle] ?? 0) + 1;

      const kurz = rolle === 'entry' ? 'E'
        : rolle === 'take_profit' ? 'TP'
        : rolle === 'trailing_stop' ? 'TS' : 'SL';

      // SQLite liefert UTC ohne Zonenangabe — ohne das angehaengte Z
      // laese der Browser die Zeit als Ortszeit, und die Marke saesse
      // im Chart um den Zonenversatz daneben.
      const roh = String(o.updated_at ?? o.placed_at ?? '');
      const zeitpunkt = roh.includes('T') ? roh : roh.replace(' ', 'T') + 'Z';

      return {
        art: rolle === 'entry' ? 'einstieg' : rolle === 'take_profit' ? 'tp' : 'sl',
        preis: Number(o.avg_fill_price),
        menge: Number(o.filled_quantity),
        zeitpunkt,
        beschriftung: kurz + nummer[rolle],
      };
    });
}

/**
 * Preismarken eines Plans fuer die Chart-Darstellung.
 *
 * Einstiege, Take-Profits und Stop-Loss als waagerechte Linien — erst
 * damit laesst sich im Chart ablesen, ob ein Docht den Stop beruehrt hat
 * oder knapp darueber drehte.
 */
export function planMarken(
  plan: Record<string, unknown>,
  /** Der Monitor-Zustand, soweit der Plan ueberwacht wird. */
  stand?: { slCurrent?: number | null; trailingActive?: boolean } | null,
): Array<{ art: string; preis: number; beschriftung: string }> {
  const marken: Array<{ art: string; preis: number; beschriftung: string }> = [];

  const liste = (feld: unknown): unknown[] => {
    if (Array.isArray(feld)) return feld;
    if (typeof feld !== 'string') return [];
    try {
      const g: unknown = JSON.parse(feld);
      return Array.isArray(g) ? g : [];
    } catch {
      return [];
    }
  };

  liste(plan.entry_orders).forEach((e, i) => {
    const preis = Number((e as { price?: unknown }).price);
    if (Number.isFinite(preis) && preis > 0) {
      marken.push({ art: 'einstieg', preis, beschriftung: `E${i + 1}` });
    }
  });

  liste(plan.take_profits).forEach((t, i) => {
    const preis = Number((t as { price?: unknown }).price);
    if (Number.isFinite(preis) && preis > 0) {
      marken.push({ art: 'tp', preis, beschriftung: `TP${i + 1}` });
    }
  });

  // Der Stop — und zwar der GELTENDE, nicht der geplante.
  //
  // Er wandert: nach einem Take-Profit nachgezogen, als Trailing
  // mitlaufend. Hier stand lange `plan.stop_loss_price`, der
  // urspruengliche Wert aus dem Signal. Am 26.10. zeigte die Kachel
  // 737,61 und der Chart 733,03 — zwei Zahlen fuer dieselbe Sache,
  // und die im Chart war die laengst ueberholte.
  const geplant = Number(plan.stop_loss_price);
  const geltend = Number(stand?.slCurrent);
  const aktuell = Number.isFinite(geltend) && geltend > 0 ? geltend : geplant;

  if (Number.isFinite(aktuell) && aktuell > 0) {
    marken.push({
      art: 'sl',
      preis: aktuell,
      beschriftung: stand?.trailingActive ? 'SL ↗' : 'SL',
    });
  }

  // Ist er gewandert, bleibt der urspruengliche als blasse Marke
  // stehen: Erst der Vergleich zeigt, wieviel Luft der Trade
  // gewonnen hat.
  if (Number.isFinite(geplant) && geplant > 0 &&
      Number.isFinite(aktuell) && Math.abs(aktuell - geplant) > 1e-9) {
    marken.push({ art: 'sl_alt', preis: geplant, beschriftung: 'SL ursprünglich' });
  }

  return marken;
}
