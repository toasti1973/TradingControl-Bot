// ============================================================
// Planuebersicht fuer die Weboberflaeche
//
// Diese Route fasst alle Bestaende zusammen, die der Bot fuehrt. Sie
// muss vollstaendig bleiben: Was hier fehlt, ist in der Oberflaeche
// unsichtbar — und ein Plan, den niemand sieht, wird auch nicht geprueft.
//
// Die Bestaende sind getrennt (siehe CLAUDE.md, Regel 3), ihre Anzeige
// ist es nicht.
// ============================================================

import { Router } from 'express';

import { BotService } from '../../services/bot-service.js';
import { SqliteStore } from '../../store/sqlite-store.js';
import type { TradePlanMonitor } from '../../services/trade-plan-monitor.js';
import { ErgebnisService } from '../../services/ergebnis-service.js';

export function createPlansRouter(
  botService: BotService,
  store: SqliteStore,
  monitor: TradePlanMonitor,
): Router {
  const router = Router();
  const ergebnisService = new ErgebnisService(store);

  router.get('/api/plans', (_req, res) => {
    const plans: Record<string, unknown>[] = [];

    // Engine-Pläne (von TradingControl importiert)
    const engine = botService.getEngine();
    if (engine) {
      for (const p of engine.getAllPlans()) {
        plans.push({
          id: p.id,
          symbol: p.symbol,
          exchange: p.exchange,
          direction: p.direction,
          market_type: p.market_type,
          leverage: p.leverage,
          status: p.status,
          bot_enabled: p.bot_enabled,
          total_size: p.total_size,
          entry_orders: p.entry_orders.length,
          take_profits: p.take_profits.length,
          stop_loss_price: p.stop_loss_price,
          created_at: p.created_at,
          updated_at: p.updated_at,
          source: 'tc',
        });
      }
    }

    // Lokale Pläne
    const localPlans = store.getLocalPlans();
    for (const lp of localPlans) {
      const entryOrders = JSON.parse(lp.entry_orders);
      const takeProfits = JSON.parse(lp.take_profits);
      plans.push({
        id: lp.id,
        symbol: lp.symbol,
        direction: lp.direction,
        market_type: lp.market_type,
        leverage: lp.leverage,
        status: lp.status,
        bot_enabled: !!lp.bot_enabled,
        total_size: lp.total_size,
        entry_orders: entryOrders.length,
        take_profits: takeProfits.length,
        stop_loss_price: lp.stop_loss_price,
        created_at: lp.created_at,
        updated_at: lp.updated_at,
        source: 'local',
      });
    }

    // Vollplaene aus bot_trade_plans: aus dem Journal gespiegelt, hier
    // angelegt oder aus einem externen Handelssignal entstanden.
    //
    // Sie fehlten hier lange. Die Oberflaeche zeigte deshalb nichts an,
    // waehrend der Bot sehr wohl Plaene fuehrte — besonders misslich in
    // der Zuschauen-Phase eines neuen Signalgebers, in der die Plaene
    // angelegt, aber noch nicht ausgefuehrt werden.
    const ueberwacht = new Set(monitor.getAllStates().map(s => s.plan.id));

    for (const bp of store.getBotTradePlans({})) {
      const entryOrders = sicherListe(bp.entry_orders);
      const takeProfits = sicherListe(bp.take_profits);
      const id = String(bp.id);

      plans.push({
        id: bp.id,
        symbol: bp.symbol,
        exchange: bp.exchange,
        direction: bp.direction,
        market_type: bp.market_type,
        leverage: bp.leverage,
        status: bp.status,
        bot_enabled: !!bp.bot_enabled,
        total_size: bp.total_size,
        total_margin: bp.total_margin,
        entry_orders: entryOrders.length,
        take_profits: takeProfits.length,
        stop_loss_price: bp.stop_loss_price,
        notes: bp.notes,
        created_at: bp.created_at,
        updated_at: bp.updated_at,
        source: bp.source,
        // Erst damit laesst sich in der Uebersicht entscheiden, ob ein
        // Plan noch etwas im Markt hat — und ob das Beenden eine
        // Position schliesst oder nur Orders zuruecknimmt.
        ergebnis: ergebnisService.fuerPlan(
          id,
          bp.direction === 'short' ? 'short' : 'long',
          Number(bp.leverage) || 1,
          monitor.getState(id)?.lastPrice ?? null,
        ),
        ueberwacht: ueberwacht.has(id),
      });
    }

    res.json({ plans });
  });

  router.get('/api/plans/:id', (req, res) => {
    const engine = botService.getEngine();
    if (!engine) {
      res.status(404).json({ error: 'Bot not running' });
      return;
    }

    const plan = engine.getPlanManager().getPlan(req.params['id']!);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    const orderState = engine.getOrderManager().getPlanState(plan.id);

    res.json({
      plan,
      execution: orderState ? {
        status: orderState,
      } : null,
    });
  });

  return router;
}

/**
 * Liste aus einem JSON-Feld der Datenbank.
 *
 * Ein unlesbarer Eintrag darf die ganze Uebersicht nicht zu Fall
 * bringen — dann faehrt die Oberflaeche lieber mit einer 0 fort, als
 * gar nichts anzuzeigen.
 */
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
