import { Router } from 'express';
import { SqliteStore } from '../../store/sqlite-store.js';

export function createTradesRouter(store: SqliteStore): Router {
  const router = Router();

  router.get('/api/trades', (req, res) => {
    const limit = Math.min(parseInt(req.query['limit'] as string) || 50, 500);
    const offset = parseInt(req.query['offset'] as string) || 0;
    const trades = store.getTrades(limit, offset);
    const total = store.getTradeCount();

    res.json({ trades, total, limit, offset });
  });

  router.get('/api/trades/plan/:planId', (req, res) => {
    const trades = store.getTradesByPlan(req.params['planId']!);
    res.json({ trades });
  });

  return router;
}
