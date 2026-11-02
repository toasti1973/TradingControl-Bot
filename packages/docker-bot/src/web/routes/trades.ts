// ============================================================
// Trade History — was tatsaechlich gehandelt wurde
//
// Sie war leer, obwohl der Bot handelte: Gelesen wurde allein die
// Tabelle `trades`, die zur TradingEngine gehoert. Die Signal-Plaene
// laufen ueber den TradePlanMonitor und schreiben ihre Orders nach
// `bot_trade_plan_orders` (CLAUDE.md, Regel 3) — dort sah niemand nach.
//
// Die Bestaende sind getrennt, ihre Anzeige ist es nicht: Hier werden
// beide zusammengefuehrt und nach Zeit sortiert.
// ============================================================

import { Router } from 'express';
import { SqliteStore } from '../../store/sqlite-store.js';
import { ErgebnisService } from '../../services/ergebnis-service.js';

/** Rollen, die eine Position verkleinern — nur sie realisieren etwas. */
const AUSSTIEGS_ROLLEN = new Set(['take_profit', 'stop_loss', 'trailing_stop']);

export function createTradesRouter(store: SqliteStore): Router {
  const router = Router();
  const ergebnisService = new ErgebnisService(store);

  router.get('/api/trades', (req, res) => {
    const limit = Math.min(parseInt(req.query['limit'] as string) || 50, 500);
    const offset = parseInt(req.query['offset'] as string) || 0;

    const alle = [...engineTrades(store), ...planTrades(store, ergebnisService)];

    // Das Juengste zuerst — danach wird gesucht.
    alle.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));

    const total = alle.length;
    const trades = alle.slice(offset, offset + limit);

    res.json({ trades, total, limit, offset });
  });

  router.get('/api/trades/plan/:planId', (req, res) => {
    const planId = req.params['planId']!;
    const ausEngine = store.getTradesByPlan(planId);
    const ausPlan = planTrades(store, ergebnisService).filter(t => t.plan_id === planId);
    res.json({ trades: [...ausEngine, ...ausPlan] });
  });

  return router;
}

/** Die Trades der TradingEngine, unveraendert. */
function engineTrades(store: SqliteStore): Array<Record<string, unknown>> {
  return store.getTrades(500, 0).map(t => ({ ...t, quelle: 'engine' }));
}

/**
 * Die Orders der Vollplaene als Trades.
 *
 * Jede gefuellte Order ist eine Zeile. Das Ergebnis traegt nur der
 * Ausstieg: Ein Einstieg realisiert nichts, er bindet Kapital. Ihn
 * trotzdem zu zeigen ist richtig — die Frage "wann bin ich zu welchem
 * Preis hinein?" beantwortet sonst niemand.
 */
function planTrades(
  store: SqliteStore, ergebnisService: ErgebnisService,
): Array<Record<string, unknown>> {
  const zeilen: Array<Record<string, unknown>> = [];

  for (const bp of store.getBotTradePlans({})) {
    const planId = String(bp.id);
    const orders = store.getPlanOrders(planId);
    if (orders.length === 0) continue;

    const richtung = bp.direction === 'short' ? 'short' : 'long';
    const hebel = Number(bp.leverage) || 1;
    const e = ergebnisService.fuerPlan(planId, richtung, hebel, null);
    const vorzeichen = richtung === 'short' ? -1 : 1;

    for (const o of orders) {
      const menge = Number(o.filled_quantity) || 0;
      const preis = Number(o.avg_fill_price) || 0;
      if (menge <= 0 || preis <= 0) continue;   // Nur, was wirklich lief.

      const istAusstieg = AUSSTIEGS_ROLLEN.has(String(o.role));
      const gebuehr = Number(o.fees) || 0;

      // Ergebnis nur beim Ausstieg, gegen den Durchschnittseinstieg.
      const pnl = (istAusstieg && e.einstiegsPreis != null)
        ? vorzeichen * (preis - e.einstiegsPreis) * menge - gebuehr
        : -gebuehr;

      // Der Einsatz dieser Teilmenge — Bezugsgroesse der Rendite.
      //
      // Beim Ausstieg zaehlt der Durchschnittseinstieg des Plans: Das
      // ist das Kapital, das diese Menge gebunden hatte. Beim Einstieg
      // zaehlt sein EIGENER Fuellpreis — er hat gebunden, was er
      // gekostet hat, nicht was der Plan im Mittel kostete.
      const bezugsPreis = (istAusstieg && e.einstiegsPreis != null) ? e.einstiegsPreis : preis;
      const einsatz = bezugsPreis * menge / hebel;

      zeilen.push({
        id: o.id,
        plan_id: planId,
        symbol: bp.symbol,
        side: o.side,
        action: rollenName(String(o.role)),
        role: o.role,
        direction: richtung,
        leverage: hebel,
        filled_quantity: menge,
        avg_fill_price: preis,
        entry_price: e.einstiegsPreis,
        fees: gebuehr,
        pnl: runden(pnl),
        roi: einsatz > 0 ? runden((pnl / einsatz) * 100) : null,
        einsatz: runden(einsatz),
        timestamp: zeitstempel(o),
        broker: o.broker,
        source: bp.source,
        quelle: 'plan',
      });
    }
  }

  return zeilen;
}

function rollenName(rolle: string): string {
  switch (rolle) {
    case 'entry': return 'Einstieg';
    case 'take_profit': return 'Take-Profit';
    case 'stop_loss': return 'Stop-Loss';
    case 'trailing_stop': return 'Trailing-Stop';
    default: return rolle;
  }
}

/**
 * Wann die Order wirksam wurde.
 *
 * SQLite liefert "YYYY-MM-DD HH:MM:SS" in UTC, ohne Zonenangabe — ohne
 * das angehaengte Z laese der Browser sie als Ortszeit.
 */
function zeitstempel(o: Record<string, unknown>): string {
  const roh = String((o.updated_at ?? o.placed_at) ?? '');
  if (!roh) return '';
  return roh.includes('T') ? roh : roh.replace(' ', 'T') + 'Z';
}

function runden(wert: number): number {
  return Math.round(wert * 100) / 100;
}
