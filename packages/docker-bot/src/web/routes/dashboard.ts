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
const AKTIVE_STATUS = new Set(['planned', 'active', 'monitoring', 'executing']);

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
      if (!AKTIVE_STATUS.has(String(bp.status))) continue;

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

      aufnehmen({
        id: bp.id, symbol: bp.symbol, direction: bp.direction, status: bp.status,
        source: bp.source,
        exchange: bp.exchange,
        leverage: hebel,
        total_size: totalSize,
        avg_entry: ergebnis.einstiegsPreis ?? kennzahlen.avgEntry,
        margin,
        liq_price: kennzahlen.liqPrice,
        stop_loss_price: bp.stop_loss_price,
        bot_enabled: !!bp.bot_enabled,
        created_at: bp.created_at,
        ergebnis,
      });
    }

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

    // KPIs
    const trades = store.getTrades(1000, 0);
    // Realisiert: die Trades der TradingEngine plus das, was die
    // Vollplaene eingebracht haben. Beide Pfade fuehren eigene Buecher
    // (CLAUDE.md, Regel 3), fuer die Kennzahl zaehlt die Summe.
    const realizedPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0)
      + plans.reduce((s, p) => s + (ergebnisVon(p)?.realisiert ?? 0), 0);
    const unrealizedPnl = plans.reduce((s, p) => s + (ergebnisVon(p)?.unrealisiert ?? 0), 0);

    // Die geplante Margin aller gezeigten Plaene — nicht die an der
    // Boerse tatsaechlich gebundene. Was davon schon gebunden ist, sagt
    // das Uebungskonto bzw. die Boerse.
    const totalMargin = plans.reduce((s, p) => s + (Number(p.margin) || 0), 0);
    const kpi = {
      margin: Math.round(totalMargin * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      roi: totalMargin > 0 ? Math.round((realizedPnl / totalMargin) * 10000) / 100 : 0,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    };

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
      kpi,
      risk: riskStats ? {
        dailyLossPct: (riskStats.dailyLossPct * 100).toFixed(1),
        weeklyLossPct: (riskStats.weeklyLossPct * 100).toFixed(1),
        drawdownPct: (riskStats.drawdownPct * 100).toFixed(1),
        halted: riskStats.halted,
        haltReason: riskStats.haltReason,
        cooldowns: riskStats.cooldowns,
      } : null,
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
): { totalSize: number; avgEntry: number; margin: number | null; liqPrice: number | null } {
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

  return { totalSize, avgEntry, margin, liqPrice };
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
