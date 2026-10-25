import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PriceMonitor } from './price-monitor.js';
import type { BrokerAdapter } from '../types/broker.js';
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

function createMockBroker(price: number): BrokerAdapter {
  return {
    name: 'mock',
    connect: vi.fn(),
    disconnect: vi.fn(),
    getPrice: vi.fn().mockResolvedValue(price),
    setLeverage: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOrder: vi.fn(),
    getPosition: vi.fn(),
  };
}

describe('PriceMonitor', () => {
  let broker: BrokerAdapter;
  let monitor: PriceMonitor;

  beforeEach(() => {
    broker = createMockBroker(50000);
    monitor = new PriceMonitor(broker, 50);
  });

  it('should emit price:update for watched symbols', async () => {
    const plan = makePlan();
    monitor.watchPlan(plan);

    const updates: Array<{ symbol: string; price: number }> = [];
    monitor.on('price:update', (symbol, price) => updates.push({ symbol, price }));

    monitor.start();
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
    monitor.stop();

    expect(updates[0]!.symbol).toBe('BTCUSDT');
    expect(updates[0]!.price).toBe(50000);
  });

  it('should activate plan with no conditions immediately', async () => {
    const plan = makePlan({ activation_conditions: [] });
    monitor.watchPlan(plan);

    const activated: string[] = [];
    monitor.on('activation:triggered', (planId) => activated.push(planId));

    monitor.start();
    await vi.waitFor(() => expect(activated.length).toBe(1));
    monitor.stop();

    expect(activated[0]).toBe('plan-001');
  });

  it('should activate plan when price_above condition is met', async () => {
    const plan = makePlan({
      activation_conditions: [{ type: 'price_above', value: 49000, met: false }],
    });
    monitor.watchPlan(plan);

    const activated: string[] = [];
    monitor.on('activation:triggered', (planId) => activated.push(planId));

    monitor.start();
    await vi.waitFor(() => expect(activated.length).toBe(1));
    monitor.stop();

    expect(monitor.isActivated('plan-001')).toBe(true);
  });

  it('should NOT activate when price_above condition is NOT met', async () => {
    broker = createMockBroker(48000);
    monitor = new PriceMonitor(broker, 50);

    const plan = makePlan({
      activation_conditions: [{ type: 'price_above', value: 49000, met: false }],
    });
    monitor.watchPlan(plan);

    const activated: string[] = [];
    monitor.on('activation:triggered', (planId) => activated.push(planId));

    monitor.start();
    // Warten, aber es sollte NICHT aktiviert werden
    await new Promise(resolve => setTimeout(resolve, 200));
    monitor.stop();

    expect(activated.length).toBe(0);
  });

  it('should activate when price_below condition is met', async () => {
    broker = createMockBroker(48000);
    monitor = new PriceMonitor(broker, 50);

    const plan = makePlan({
      activation_conditions: [{ type: 'price_below', value: 49000, met: false }],
    });
    monitor.watchPlan(plan);

    const activated: string[] = [];
    monitor.on('activation:triggered', (planId) => activated.push(planId));

    monitor.start();
    await vi.waitFor(() => expect(activated.length).toBe(1));
    monitor.stop();
  });

  it('should require ALL conditions to be met', async () => {
    broker = createMockBroker(50000);
    monitor = new PriceMonitor(broker, 50);

    const plan = makePlan({
      activation_conditions: [
        { type: 'price_above', value: 49000, met: false },
        { type: 'price_below', value: 45000, met: false },
      ],
    });
    monitor.watchPlan(plan);

    const activated: string[] = [];
    monitor.on('activation:triggered', (planId) => activated.push(planId));

    monitor.start();
    await new Promise(resolve => setTimeout(resolve, 200));
    monitor.stop();

    // price_above(49000) met, but price_below(45000) not met
    expect(activated.length).toBe(0);
  });

  it('should unwatch plans', async () => {
    const plan = makePlan();
    monitor.watchPlan(plan);
    monitor.unwatchPlan('plan-001');

    const activated: string[] = [];
    monitor.on('activation:triggered', (planId) => activated.push(planId));

    monitor.start();
    await new Promise(resolve => setTimeout(resolve, 150));
    monitor.stop();

    expect(activated.length).toBe(0);
  });
});
