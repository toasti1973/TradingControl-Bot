// ============================================================
// Dashboard — die erste Seite, auf die geschaut wird
//
// Was hier fehlt, gilt als nicht vorhanden. Die Seite muss deshalb
// ALLE Bestaende zeigen, die der Bot fuehrt (siehe CLAUDE.md, Regel 3:
// die Bestaende sind getrennt, ihre Anzeige ist es nicht).
//
// Genau das war hier lange nicht der Fall: bot_trade_plans fehlte,
// weshalb "Aktive Plaene 0" dastand, waehrend der TradePlanMonitor zwei
// Signal-Plaene fuehrte. Die Planuebersicht (plans.ts) war schon
// korrigiert, das Dashboard blieb zurueck — und wer zuerst aufs
// Dashboard sieht, haelt den Bot fuer untaetig.
// ============================================================

import { Router } from 'express';

import { BotService } from '../../services/bot-service.js';
import { SqliteStore } from '../../store/sqlite-store.js';
import { SettingsService } from '../../services/settings-service.js';
import type { TradePlanMonitor } from '../../services/trade-plan-monitor.js';
import { ErgebnisService, type Ergebnis } from '../../services/ergebnis-service.js';
import { TcApiClient } from '@tradingcontrol/core';

/**
 * Welche Status gelten als "aktiv"?
 *
 * Bewusst weit gefasst: 'planned' gehoert dazu, weil ein Plan, der auf
 * seine Aktivierungsbedingung wartet, sehr wohl ueberwacht wird. Ihn zu
 * verbergen hiesse, die Zuschauen-Phase eines neuen Signalgebers blind
 * zu verbringen.
 */
export const AKTIVE_STATUS = new Set(['planned', 'active', 'monitoring', 'executing']);

/**
 * Status, die einen Plan als erledigt ausweisen.
 *
 * Sie gehoeren in eine eigene Liste, nicht unter die aktiven: Ein
 * abgeschlossener Trade zwischen laufenden laesst den Blick nach dem
 * suchen, was gerade Aufsicht braucht. 'error' zaehlt dazu — der Plan
 * handelt nicht mehr, auch wenn er nicht planmaessig endete.
 */
export const BEENDETE_STATUS = new Set(['completed', 'cancelled', 'error']);

/** Wieviele beendete Plaene das Dashboard hoechstens zurueckblickt. */
const BEENDETE_HOECHSTENS = 25;

export function createDashboardRouter(
  botService: BotService,
  store: SqliteStore,
  settingsService: SettingsService,
  monitor: TradePlanMonitor,
): Router {
  const router = Router();
  const ergebnisService = new ErgebnisService(store);

  router.get('/api/dashboard', (_req, res) => {
    const stats = botService.getStats();
    const engine = botService.getEngine();

    const plans: Record<string, unknown>[] = [];
    // Beendete Plaene stehen fuer sich. In die KPI gehen sie nicht ein:
    // Sie binden nichts mehr und haben nichts Offenes.
    const beendet: Record<string, unknown>[] = [];
    // Gegen Doppelzaehlung: Taucht dieselbe Plan-ID in zwei Bestaenden
    // auf, zaehlte ihre Margin sonst zweimal in die KPI.
    const gesehen = new Set<string>();

    const aufnehmen = (plan: Record<string, unknown>): void => {
      const id = String(plan.id);
      if (gesehen.has(id)) return;
      gesehen.add(id);
      plans.push(plan);
    };

    // Engine-Pläne (TC)
    if (engine) {
      for (const p of engine.getActivePlans()) {
        aufnehmen({ id: p.id, symbol: p.symbol, direction: p.direction, status: p.status, source: 'tc' });
      }
    }

    // Lokale aktive Pläne
    const localPlans = store.getLocalPlans();
    for (const lp of localPlans) {
      if (lp.status === 'planned' || lp.status === 'active') {
        const kennzahlen = einstiegsKennzahlen(lp.entry_orders, lp.leverage, lp.direction);

        aufnehmen({
          id: lp.id, symbol: lp.symbol, direction: lp.direction, status: lp.status, source: 'local',
          total_size: kennzahlen.totalSize, avg_entry: kennzahlen.avgEntry,
          margin: kennzahlen.margin, liq_price: kennzahlen.liqPrice,
          stop_loss_price: lp.stop_loss_price,
          created_at: lp.created_at,
        });
      }
    }

    // Vollplaene aus bot_trade_plans — der Pfad des TradePlanMonitor:
    // aus dem Journal gespiegelt, hier angelegt oder aus einem externen
    // Handelssignal entstanden.
    for (const bp of store.getBotTradePlans({})) {
      const status = String(bp.status);
      const istAktiv = AKTIVE_STATUS.has(status);
      const istBeendet = BEENDETE_STATUS.has(status);
      // Ein unbekannter Status gehoert in keine der beiden Listen —
      // lieber nichts behaupten als ihn falsch einsortieren.
      if (!istAktiv && !istBeendet) continue;

      const hebel = Number(bp.leverage) || 1;
      const kennzahlen = einstiegsKennzahlen(bp.entry_orders, hebel, String(bp.direction));

      // total_size und total_margin stehen am Plan und sind massgeblich;
      // bei einem Signal-Plan ist total_margin bereits auf das eigene
      // Kapital umgerechnet (Regel 3a). Nur wenn sie fehlen, wird aus
      // den Einstiegen gerechnet.
      const totalSize = Number(bp.total_size) || kennzahlen.totalSize;
      const margin = bp.total_margin != null ? Number(bp.total_margin) : kennzahlen.margin;

      // Was der Plan bisher eingebracht hat — gerechnet aus den
      // tatsaechlich abgeschickten Orders.
      const ergebnis = ergebnisService.fuerPlan(
        String(bp.id),
        bp.direction === 'short' ? 'short' : 'long',
        hebel,
        monitor.getState(String(bp.id))?.lastPrice ?? null,
      );

      const datensatz = {
        id: bp.id, symbol: bp.symbol, direction: bp.direction, status: bp.status,
        source: bp.source,
        exchange: bp.exchange,
        leverage: hebel,
        total_size: totalSize,
        // Wieviele Teil-Einstiege vorgesehen sind. Zusammen mit
        // ergebnis.einstiegeGefuellt ergibt das die Angabe "2 von 4
        // Einstiegen ausgefuehrt" — ohne sie bliebe in der Uebersicht
        // offen, ob der Trade halb oder ganz im Markt steht.
        entries_geplant: kennzahlen.anzahl,
        avg_entry: ergebnis.einstiegsPreis ?? kennzahlen.avgEntry,
        margin,
        liq_price: kennzahlen.liqPrice,
        stop_loss_price: bp.stop_loss_price,
        bot_enabled: !!bp.bot_enabled,
        created_at: bp.created_at,
        updated_at: bp.updated_at,
        ergebnis,
      };

      if (istAktiv) {
        aufnehmen(datensatz);
      } else {
        beendet.push(datensatz);
      }
    }

    // Die zuletzt beendeten zuerst — was gerade ausging, interessiert
    // mehr als das von vorgestern.
    beendet.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));

    // Was die beendeten Plaene eingebracht haben — gezaehlt VOR dem
    // Kuerzen der Liste. Sonst haengte die Kennzahl daran, wieviele
    // Zeilen die Oberflaeche gerade zeigt.
    //
    // Dass sie ueberhaupt gezaehlt werden, ist der Punkt: Bisher fielen
    // abgeschlossene Plaene aus den aktiven heraus und nahmen ihren
    // realisierten Gewinn mit. Ein Trade, der mit Take-Profit schloss,
    // verschwand damit aus der Bilanz — genau der Trade, an dem sich
    // die Guete des Signalgebers zeigt.
    const realisiertBeendet = beendet.reduce((s, p) => s + (ergebnisVon(p)?.realisiert ?? 0), 0);
    const beendetGesamt = beendet.length;
    beendet.length = Math.min(beendet.length, BEENDETE_HOECHSTENS);

    // Welche Plaene der Monitor tatsaechlich fuehrt.
    //
    // Ohne diese Angabe sieht ein aktiver, aber unbeaufsichtigter Plan
    // in der Oberflaeche genauso aus wie ein beaufsichtigter, bei dem
    // nur noch kein Take-Profit griff. Der gefaehrlichere der beiden
    // Faelle darf nicht der unsichtbare sein.
    const ueberwacht = new Set(monitor.getAllStates().map(s => s.plan.id));
    for (const p of plans) {
      p.ueberwacht = ueberwacht.has(String(p.id));
    }
    for (const p of beendet) {
      p.ueberwacht = ueberwacht.has(String(p.id));
    }

    // KPIs
    const trades = store.getTrades(1000, 0);
    // Realisiert: die Trades der TradingEngine plus das, was die
    // Vollplaene eingebracht haben — die laufenden wie die beendeten.
    // Beide Pfade fuehren eigene Buecher (CLAUDE.md, Regel 3), fuer die
    // Kennzahl zaehlt die Summe.
    const realizedPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0)
      + plans.reduce((s, p) => s + (ergebnisVon(p)?.realisiert ?? 0), 0)
      + realisiertBeendet;
    const unrealizedPnl = plans.reduce((s, p) => s + (ergebnisVon(p)?.unrealisiert ?? 0), 0);

    // Die geplante Margin aller gezeigten Plaene — nicht die an der
    // Boerse tatsaechlich gebundene. Was davon schon gebunden ist, sagt
    // das Uebungskonto bzw. die Boerse.
    // Gebunden ist der Einsatz der OFFENEN Position, nicht die Margin
    // des ganzen Plans. Bei einem gestaffelten Einstieg, von dem erst
    // ein Teil gefuellt wurde, liegt dazwischen ein Vielfaches — und
    // ein Dashboard, das die geplante Margin als eingesetzt ausweist,
    // behauptet gebundenes Kapital, das noch frei ist.
    const totalMargin = plans.reduce((s, p) => {
      const e = ergebnisVon(p);

      // `einsatzOffen` statt `einsatz`.
      //
      // `einsatz` summiert alle Einstiege, auch die laengst wieder
      // geschlossenen — fuer die Rendite ist das richtig, fuer die
      // Frage "wieviel ist gerade gebunden" nicht. Nach einem
      // Take-Profit wiese es Kapital als gebunden aus, das wieder frei
      // ist.
      //
      // Die Formel stand hier bis zum 26.10. von Hand; sie liegt jetzt
      // im ErgebnisService, damit Dashboard und Detailansicht nicht
      // zwei Fassungen derselben Zahl fuehren.
      if (e && e.einsatzOffen != null) return s + e.einsatzOffen;
      // Ein Plan ohne offene Position bindet nichts.
      if (e) return s;

      // Engine- und local_plans fuehren keine Ergebnisrechnung.
      return s + (Number(p.margin) || 0);
    }, 0);
    // Die Rendite bezieht sich auf das KAPITAL, nicht auf die gerade
    // gebundene Margin.
    //
    // Hier stand `realizedPnl / totalMargin`, und die beiden passten
    // nicht zusammen: Im Zaehler das Ergebnis ALLER Plaene, auch der
    // laengst beendeten; im Nenner nur, was in diesem Augenblick
    // gebunden ist. Steht nichts mehr offen, wurde die Rendite zu 0,
    // obwohl Gewinne vorlagen; blieb ein Prozent gebunden, sprang sie
    // ins Tausendfache — am 26.10. standen dort −3.141 %.
    //
    // "Wieviel Prozent hat das Konto gewonnen oder verloren" ist die
    // Frage, die sich wirklich stellt.
    const kapitalBasis = verwendetesKapital(store);
    const kpi = {
      margin: Math.round(totalMargin * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      roi: kapitalBasis > 0
        ? Math.round((realizedPnl / kapitalBasis) * 10000) / 100
        : 0,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      /** Worauf sich die Rendite bezieht — damit die Zahl lesbar bleibt. */
      roiBasis: Math.round(kapitalBasis * 100) / 100,
    };

    // Die Risiko-Kennzahlen aus den tatsaechlichen Abschluessen.
    //
    // Der RiskGuard der TradingEngine kennt nur, was ueber IHREN Pfad
    // lief (CLAUDE.md, Regel 3). Die Signal-Plaene laufen ueber den
    // TradePlanMonitor und wurden ihm nie gemeldet — die Anzeige stand
    // deshalb auf 0,0 %, waehrend 92,80 USDT verloren waren. Eine
    // Risikoanzeige, die den gerade laufenden Handel nicht sieht, ist
    // schlimmer als keine: Sie beruhigt.
    const gerechnet = risikoKennzahlen(store, ergebnisService, kapitalBasis);
    const riskStats = engine?.getRiskGuard().getStats() ?? null;

    // Volatility stats for watched symbols
    const volService = engine?.getVolatilityService();
    const volatility: Record<string, unknown> = {};
    if (volService) {
      const symbols = new Set(plans.map(p => String(p.symbol)));
      for (const sym of symbols) {
        volatility[sym] = volService.getStats(sym);
      }
    }

    res.json({
      status: stats.status,
      broker: stats.broker,
      uptime: stats.uptime,
      activePlans: plans.length,
      totalTrades: stats.totalTrades,
      lastError: stats.lastError,
      plans,
      // Erledigte Plaene stehen fuer sich, mit ihrer Gesamtzahl: Die
      // Liste ist gekuerzt, die Zahl darunter ist es nicht.
      beendet,
      beendetGesamt,
      kpi,
      // Die Zahlen aus der eigenen Rechnung, Sperre und Cooldowns vom
      // RiskGuard: Er allein haelt den Handel an, und was er dabei
      // sieht, bleibt seine Sache.
      //
      // Die hoehere der beiden Verlustzahlen gewinnt — die Anzeige
      // soll das groessere Risiko nennen, nicht das kleinere.
      risk: {
        dailyLossPct: hoechstes(gerechnet.tagesverlustPct, riskStats?.dailyLossPct).toFixed(1),
        weeklyLossPct: hoechstes(gerechnet.wochenverlustPct, riskStats?.weeklyLossPct).toFixed(1),
        drawdownPct: hoechstes(gerechnet.drawdownPct, riskStats?.drawdownPct).toFixed(1),
        halted: riskStats?.halted ?? false,
        haltReason: riskStats?.haltReason ?? '',
        cooldowns: riskStats?.cooldowns ?? {},
        // Fuer den Hinweistext: worauf sich die Prozente beziehen.
        kapital: Math.round(gerechnet.kapital * 100) / 100,
        realisiertHeute: Math.round(gerechnet.realisiertHeute * 100) / 100,
        realisiertWoche: Math.round(gerechnet.realisiertWoche * 100) / 100,
      },
      volatility,
    });
  });

  // Ping / Connection Status
  router.get('/api/ping', async (_req, res) => {
    const results: Record<string, unknown> = {};

    // TC API Ping
    try {
      const config = await settingsService.getEffectiveConfig();
      if (config.tcApiUrl && config.tcApiKey) {
        const client = new TcApiClient({ baseUrl: config.tcApiUrl, apiKey: config.tcApiKey, timeout: 5000, maxRetries: 0 });
        const start = Date.now();
        const hb = await client.heartbeat();
        results.tc = { connected: true, pingMs: Date.now() - start, status: hb?.status ?? 'ok' };
      } else {
        results.tc = { connected: false, error: 'Nicht konfiguriert' };
      }
    } catch (err) {
      results.tc = { connected: false, error: err instanceof Error ? err.message : 'Verbindung fehlgeschlagen' };
    }

    // Broker Ping — getPrice auf BTCUSDT als Health-Check
    const broker = botService.getBroker();
    const brokerName = botService.getStats().broker;
    if (broker) {
      try {
        const start = Date.now();
        const price = await broker.getPrice('BTCUSDT');
        results.broker = { connected: price !== null, pingMs: Date.now() - start, broker: brokerName };
      } catch {
        results.broker = { connected: false, broker: brokerName };
      }
    } else {
      results.broker = { connected: false, broker: brokerName, error: 'Bot nicht gestartet' };
    }

    res.json(results);
  });

  router.post('/api/bot/start', async (_req, res) => {
    try {
      await botService.start();
      store.setBotState('bot:running', 'true');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/api/bot/stop', async (_req, res) => {
    try {
      await botService.stop();
      store.setBotState('bot:running', 'false');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  return router;
}

/**
 * Groesse, Durchschnittseinstieg, Margin und ein grober Liquidationspreis
 * aus den geplanten Einstiegen.
 *
 * Eine Schaetzung, und zwar mit Absicht: Welche Teil-Einstiege
 * tatsaechlich gefuellt wurden, steht hier nicht zur Verfuegung.
 * Gerechnet wird auf den Durchschnitt der geplanten Einstiege.
 *
 * Ein unlesbares JSON-Feld darf das Dashboard nicht zu Fall bringen —
 * dann lieber Nullwerte als eine leere Seite.
 */
function einstiegsKennzahlen(
  rohEntries: unknown,
  leverage: number | null | undefined,
  direction: string,
): {
  totalSize: number; avgEntry: number; margin: number | null;
  liqPrice: number | null; anzahl: number;
} {
  const entries = sicherListe(rohEntries) as { price?: number; size?: number }[];

  const totalSize = entries.reduce((s, e) => s + (Number(e.size) || 0), 0);
  const avgEntry = totalSize > 0
    ? entries.reduce((s, e) => s + (Number(e.price) || 0) * (Number(e.size) || 0), 0) / totalSize
    : 0;

  const hebel = Number(leverage) || 1;
  const margin = avgEntry > 0 ? (totalSize * avgEntry) / hebel : null;

  // Grobe Schaetzung: Einstieg +/- (Margin / Groesse).
  const liqPrice = margin != null && totalSize > 0
    ? (direction === 'long' ? avgEntry - (margin / totalSize) : avgEntry + (margin / totalSize))
    : null;

  return { totalSize, avgEntry, margin, liqPrice, anzahl: entries.length };
}

/**
 * Die groessere von zwei Prozentzahlen, als Prozentpunkte.
 *
 * Die eigene Rechnung sieht alle Plaene, der RiskGuard nur die der
 * Engine — aber er allein kennt Verluste, die nicht ueber Plaene
 * liefen. Die hoehere Zahl ist deshalb die vorsichtigere Auskunft.
 */
export function hoechstes(eigeneProzent: number, guardAnteil: number | undefined): number {
  const vomGuard = (guardAnteil ?? 0) * 100;
  return Math.max(eigeneProzent, vomGuard);
}

/**
 * Das Kapital, auf das sich die Prozentangaben beziehen.
 *
 * Im Uebungsbetrieb der Kontostand; sonst das, was als Startkapital
 * hinterlegt ist. Ohne eine solche Bezugsgroesse laesst sich kein
 * Verlust in Prozent ausdruecken.
 */
export function verwendetesKapital(store: SqliteStore): number {
  const konto = store.getPaperAccount('USDT');
  if (konto) {
    const start = Number(konto.startkapital) || 0;
    const realisiert = Number(konto.realisiert) || 0;
    const gebuehren = Number(konto.gebuehren) || 0;
    const equity = start + realisiert - gebuehren;
    return equity > 0 ? equity : start;
  }
  return 0;
}

/**
 * Tages- und Wochenverlust sowie Drawdown — aus den Abschluessen.
 *
 * Gerechnet wird aus den tatsaechlich gefuellten Ausstiegs-Orders:
 * Jede von ihnen hat einen Zeitstempel, und nur sie realisieren etwas.
 * Die Gebuehren gehen voll ein — gezahlt ist gezahlt.
 *
 * Der Drawdown ist der Abstand vom Hoechststand, den das Kapital im
 * Verlauf erreicht hatte. Er wird aus derselben Folge gebildet: Wer
 * nur den aktuellen Stand mit dem Startkapital vergleicht, uebersieht
 * den Ruecksetzer nach einer Gewinnserie.
 */
export function risikoKennzahlen(
  store: SqliteStore,
  ergebnisService: ErgebnisService,
  kapital: number,
): {
  tagesverlustPct: number; wochenverlustPct: number; drawdownPct: number;
  kapital: number; realisiertHeute: number; realisiertWoche: number;
} {
  const leer = {
    tagesverlustPct: 0, wochenverlustPct: 0, drawdownPct: 0,
    kapital, realisiertHeute: 0, realisiertWoche: 0,
  };
  if (kapital <= 0) return leer;

  const jetzt = Date.now();
  const einTag = jetzt - 86_400_000;
  const eineWoche = jetzt - 7 * 86_400_000;

  // Je Plan den Durchschnittseinstieg — gegen ihn wird jeder Ausstieg
  // gerechnet.
  const abschluesse: Array<{ zeit: number; betrag: number }> = [];

  for (const bp of store.getBotTradePlans({})) {
    const planId = String(bp.id);
    const orders = store.getPlanOrders(planId);
    if (orders.length === 0) continue;

    const e = ergebnisService.fuerPlan(
      planId, bp.direction === 'short' ? 'short' : 'long', Number(bp.leverage) || 1, null,
    );
    if (e.einstiegsPreis == null) continue;

    const vorzeichen = bp.direction === 'short' ? -1 : 1;

    for (const o of orders) {
      const menge = Number(o.filled_quantity) || 0;
      const preis = Number(o.avg_fill_price) || 0;
      const gebuehr = Number(o.fees) || 0;
      const zeit = Date.parse(zeitstempel(o));
      if (!Number.isFinite(zeit)) continue;

      let betrag = -gebuehr;
      if (menge > 0 && preis > 0 && AUSSTIEGS_ROLLEN.has(String(o.role))) {
        betrag += vorzeichen * (preis - e.einstiegsPreis) * menge;
      }
      if (betrag !== 0) abschluesse.push({ zeit, betrag });
    }
  }

  // Die Trades der TradingEngine kommen dazu — derselbe Kontostand.
  for (const t of store.getTrades(1000, 0)) {
    const zeit = Date.parse(String(t.timestamp ?? ''));
    const betrag = Number(t.pnl) || 0;
    if (Number.isFinite(zeit) && betrag !== 0) abschluesse.push({ zeit, betrag });
  }

  abschluesse.sort((a, b) => a.zeit - b.zeit);

  const realisiertHeute = abschluesse
    .filter(a => a.zeit >= einTag).reduce((s, a) => s + a.betrag, 0);
  const realisiertWoche = abschluesse
    .filter(a => a.zeit >= eineWoche).reduce((s, a) => s + a.betrag, 0);

  // Verlauf des Kapitals nachbilden: vom Stand vor allen Abschluessen
  // bis heute. Der Hoechststand darunter ist der Bezugspunkt.
  const gesamt = abschluesse.reduce((s, a) => s + a.betrag, 0);
  let lauf = kapital - gesamt;
  let hoechststand = lauf;
  for (const a of abschluesse) {
    lauf += a.betrag;
    if (lauf > hoechststand) hoechststand = lauf;
  }

  const drawdown = hoechststand > 0 ? ((hoechststand - lauf) / hoechststand) * 100 : 0;

  return {
    // Nur Verluste werden ausgewiesen: Ein Gewinntag ist kein
    // negativer Verlust, er ist gar keiner.
    tagesverlustPct: realisiertHeute < 0 ? (-realisiertHeute / kapital) * 100 : 0,
    wochenverlustPct: realisiertWoche < 0 ? (-realisiertWoche / kapital) * 100 : 0,
    drawdownPct: Math.max(0, drawdown),
    kapital,
    realisiertHeute,
    realisiertWoche,
  };
}

const AUSSTIEGS_ROLLEN = new Set(['take_profit', 'stop_loss', 'trailing_stop']);

/** Wann eine Order wirksam wurde — gefuellt, sonst platziert. */
function zeitstempel(o: Record<string, unknown>): string {
  const gefuellt = (Number(o.filled_quantity) || 0) > 0;
  const roh = String((gefuellt ? (o.updated_at ?? o.placed_at) : o.placed_at) ?? '');
  // SQLite liefert "YYYY-MM-DD HH:MM:SS" in UTC, ohne Zonenangabe.
  return roh.includes('T') ? roh : roh.replace(' ', 'T') + 'Z';
}

/**
 * Das Ergebnis eines Plans, soweit eines vorliegt.
 *
 * Engine- und lokale Plaene tragen keines — sie laufen ueber einen
 * anderen Pfad und fuehren ihre Trades in `trades`.
 */
function ergebnisVon(plan: Record<string, unknown>): Ergebnis | null {
  return (plan.ergebnis as Ergebnis | undefined) ?? null;
}

function sicherListe(wert: unknown): unknown[] {
  if (Array.isArray(wert)) return wert;
  if (typeof wert !== 'string') return [];
  try {
    const geparst: unknown = JSON.parse(wert);
    return Array.isArray(geparst) ? geparst : [];
  } catch {
    return [];
  }
}
