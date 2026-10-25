import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../store/sqlite-store.js';
import { BotService } from '../../services/bot-service.js';

function cleanupPlanFromEngine(botService: BotService, planId: string, _symbol: string): void {
  const engine = botService.getEngine();
  if (!engine) return;

  // OrderManager: offene Orders canceln
  engine.getOrderManager().cancelPlan(planId).catch(() => {});

  // PriceMonitor: Symbol-Watch entfernen
  engine.getPriceMonitor().unwatchPlan(planId);

  // VolatilityService: Symbol nur entfernen wenn kein anderer Plan es braucht
  // (koennte noch von einem anderen Plan benoetigt werden)
}

export function createLocalPlansRouter(store: SqliteStore, botService: BotService): Router {
  const router = Router();

  // GET all local plans
  router.get('/api/local-plans', (_req, res) => {
    const plans = store.getLocalPlans();
    res.json({ plans: plans.map(p => ({ ...p, bot_enabled: !!p.bot_enabled, entry_orders: JSON.parse(p.entry_orders), take_profits: JSON.parse(p.take_profits), activation_conditions: JSON.parse(p.activation_conditions) })) });
  });

  // GET single plan
  router.get('/api/local-plans/:id', (req, res) => {
    const plan = store.getLocalPlan(req.params['id']!);
    if (!plan) { res.status(404).json({ error: 'Plan nicht gefunden' }); return; }
    res.json({ ...plan, bot_enabled: !!plan.bot_enabled, entry_orders: JSON.parse(plan.entry_orders), take_profits: JSON.parse(plan.take_profits), activation_conditions: JSON.parse(plan.activation_conditions) });
  });

  // POST create plan
  router.post('/api/local-plans', (req, res) => {
    const b = req.body;
    if (!b || !b.symbol || !b.direction || !b.total_size) {
      res.status(400).json({ error: 'Symbol, Richtung und Gesamtgroesse erforderlich' });
      return;
    }

    // Validate direction
    if (!['long', 'short'].includes(b.direction)) {
      res.status(400).json({ error: 'Richtung muss long oder short sein' });
      return;
    }

    // Validate entry orders
    const entryOrders = Array.isArray(b.entry_orders) ? b.entry_orders : [];
    if (entryOrders.length === 0) {
      res.status(400).json({ error: 'Mindestens eine Entry-Order erforderlich' });
      return;
    }

    // Validate take profits
    const takeProfits = Array.isArray(b.take_profits) ? b.take_profits : [];

    // Validate activation conditions
    const activationConditions = Array.isArray(b.activation_conditions) ? b.activation_conditions : [];

    const id = randomUUID();
    store.insertLocalPlan({
      id,
      symbol: String(b.symbol).toUpperCase().trim(),
      direction: b.direction,
      market_type: b.market_type || 'futures',
      leverage: Number(b.leverage) || 1,
      total_size: Number(b.total_size),
      entry_strategy: b.entry_strategy || 'single',
      entry_orders: JSON.stringify(entryOrders),
      take_profits: JSON.stringify(takeProfits),
      stop_loss_price: b.stop_loss_price ? Number(b.stop_loss_price) : null,
      stop_loss_type: b.stop_loss_type || 'fixed',
      trailing_stop_pct: b.trailing_stop_pct ? Number(b.trailing_stop_pct) : null,
      trailing_stop_activation: b.trailing_stop_activation ? Number(b.trailing_stop_activation) : null,
      activation_conditions: JSON.stringify(activationConditions),
      status: 'planned',
      bot_enabled: true,
      notes: b.notes || null,
    });

    res.status(201).json({ success: true, id });
  });

  // PATCH status
  router.patch('/api/local-plans/:id/status', (req, res) => {
    const { status } = req.body;
    const validStatuses = ['planned', 'active', 'cancelled', 'completed'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: 'Ungueltiger Status' });
      return;
    }
    const plan = store.getLocalPlan(req.params['id']!);
    if (!plan) { res.status(404).json({ error: 'Plan nicht gefunden' }); return; }

    // Bei cancelled/completed: Engine-State aufraeumen
    if (status === 'cancelled' || status === 'completed') {
      cleanupPlanFromEngine(botService, req.params['id']!, plan.symbol);
    }

    store.updateLocalPlanStatus(req.params['id']!, status);
    res.json({ success: true });
  });

  // DELETE plan
  router.delete('/api/local-plans/:id', (req, res) => {
    const plan = store.getLocalPlan(req.params['id']!);
    if (!plan) { res.status(404).json({ error: 'Plan nicht gefunden' }); return; }

    // Engine-State aufraeumen bevor der Plan geloescht wird
    cleanupPlanFromEngine(botService, req.params['id']!, plan.symbol);

    store.deleteLocalPlan(req.params['id']!);
    res.json({ success: true });
  });

  return router;
}
