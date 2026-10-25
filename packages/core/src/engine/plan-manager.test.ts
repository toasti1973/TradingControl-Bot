import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanManager } from './plan-manager.js';
import type { TcPlan } from '../types/plan.js';

function makePlan(overrides: Partial<TcPlan> = {}): TcPlan {
  return {
    id: 'plan-001',
    symbol: 'BTCUSDT',
    exchange: 'phemex',
    direction: 'long',
    market_type: 'futures',
    leverage: 10,
    entry_strategy: 'single',
    entry_orders: [{ price: 50000, size: 0.1, percentage: 100, order_type: 'limit', status: 'pending' }],
    take_profits: [{ price: 55000, percentage: 100, order_type: 'limit', status: 'pending' }],
    stop_loss_price: 48000,
    stop_loss_type: 'fixed',
    trailing_stop_pct: null,
    trailing_stop_activation: null,
    total_size: 0.1,
    activation_conditions: [],
    status: 'planned',
    bot_enabled: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('PlanManager', () => {
  let mockSource: { name: string; fetchPlans: ReturnType<typeof vi.fn> };
  let planManager: PlanManager;

  beforeEach(() => {
    mockSource = {
      name: 'test',
      fetchPlans: vi.fn().mockResolvedValue([]),
    };
    planManager = new PlanManager(mockSource, 100);
  });

  it('should emit plan:new for new plans', async () => {
    const plan = makePlan();
    mockSource.fetchPlans.mockResolvedValue([plan]);

    const newPlans: TcPlan[] = [];
    planManager.on('plan:new', (p) => newPlans.push(p));

    planManager.start();
    await vi.waitFor(() => expect(newPlans.length).toBe(1));
    planManager.stop();

    expect(newPlans[0]!.id).toBe('plan-001');
  });

  it('should emit plan:updated when plan changes', async () => {
    const plan = makePlan();
    mockSource.fetchPlans.mockResolvedValue([plan]);

    const updated: Array<{ plan: TcPlan; previous: TcPlan }> = [];
    planManager.on('plan:new', () => {});
    planManager.on('plan:updated', (p, prev) => updated.push({ plan: p, previous: prev }));

    planManager.start();
    await vi.waitFor(() => expect(planManager.getAllPlans().length).toBe(1));

    // Plan aktualisieren
    const updatedPlan = makePlan({ updated_at: '2024-01-02T00:00:00Z', status: 'active' });
    mockSource.fetchPlans.mockResolvedValue([updatedPlan]);

    await vi.waitFor(() => expect(updated.length).toBe(1));
    planManager.stop();

    expect(updated[0]!.plan.status).toBe('active');
    expect(updated[0]!.previous.status).toBe('planned');
  });

  it('should emit plan:removed when plan disappears', async () => {
    const plan = makePlan();
    mockSource.fetchPlans.mockResolvedValue([plan]);

    const removed: string[] = [];
    planManager.on('plan:new', () => {});
    planManager.on('plan:removed', (id) => removed.push(id));

    planManager.start();
    await vi.waitFor(() => expect(planManager.getAllPlans().length).toBe(1));

    // Plan entfernen
    mockSource.fetchPlans.mockResolvedValue([]);

    await vi.waitFor(() => expect(removed.length).toBe(1));
    planManager.stop();

    expect(removed[0]).toBe('plan-001');
  });

  it('should filter active plans correctly', async () => {
    const plans = [
      makePlan({ id: 'p1', status: 'planned', bot_enabled: true }),
      makePlan({ id: 'p2', status: 'completed', bot_enabled: true }),
      makePlan({ id: 'p3', status: 'active', bot_enabled: false }),
      makePlan({ id: 'p4', status: 'active', bot_enabled: true }),
    ];
    mockSource.fetchPlans.mockResolvedValue(plans);

    planManager.start();
    await vi.waitFor(() => expect(planManager.getAllPlans().length).toBe(4));
    planManager.stop();

    const active = planManager.getActivePlans();
    expect(active.length).toBe(2); // p1 (planned+enabled) and p4 (active+enabled)
    expect(active.map(p => p.id).sort()).toEqual(['p1', 'p4']);
  });

  it('should emit plan:error on API failure after cache expires', async () => {
    mockSource.fetchPlans.mockRejectedValue(new Error('Network error'));

    const errors: Error[] = [];
    planManager.on('plan:error', (e) => errors.push(e));

    // Manager mit kurzem Cache
    planManager = new PlanManager(mockSource, 50, 100);
    planManager.on('plan:error', (e) => errors.push(e));

    planManager.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 500 });
    planManager.stop();
  });
});
