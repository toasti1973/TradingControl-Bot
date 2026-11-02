// ============================================================
// Alles liegt an der Boerse
//
// Der Bot hielt Einstiege, Ziele und Stop frueher selbst: Er
// beobachtete den Kurs und schickte erst beim Ueberschreiten eine
// Order. Das setzt drei Dinge voraus — dass er laeuft, Verbindung hat
// und im richtigen Augenblick hinsieht. Jedes davon kann ausfallen.
//
// Am 25.10. lief HYPEUSDT in der Minute 13:17 auf 77,034 und schloss
// bei 76,957. Ziel 1 lag bei 76,9907 und wurde nie ausgeloest: ein
// Docht zwischen zwei Kursabfragen im Zwei-Sekunden-Takt. Eine Order
// im Orderbuch waere gefuellt worden — und zum ZIELPREIS, nicht zu
// dem, was Sekunden spaeter noch uebrig war.
//
// Am selben Tag standen zwei von vier Einstiegen Stunden nach dem
// Signal noch auf "nicht abgeschickt", obwohl der Kurs sie laengst
// durchlaufen hatte.
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { TradePlanMonitor } from './trade-plan-monitor.js';
import type { BrokerRegistry } from './broker-factory.js';
import type { Logger } from './log-service.js';
import type { BrokerAdapter, OrderParams, OrderResult } from '@tradingcontrol/core';

const stilleAusgabe = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
} as unknown as Logger;

/**
 * Boerse mit Orderbuch.
 *
 * Limit- und Stop-Orders bleiben liegen und werden gefuellt, sobald
 * der Kurs sie beruehrt — unabhaengig davon, welchen Kurs der Monitor
 * gerade sieht. Genau darin liegt der Unterschied, um den es hier
 * geht.
 */
function boerseAttrappe(optionen: { einstiegeFuellen?: boolean } = {}) {
  const platziert: OrderParams[] = [];
  const storniert: string[] = [];
  const liegend = new Map<string, OrderParams>();
  const gefuellt = new Set<string>();
  let nummer = 0;
  let kurs = 50_000;

  /** Wuerde der Kurs diese liegende Order ausloesen? */
  function wuerdeFuellen(p: OrderParams): boolean {
    // Einstiege lassen sich abschalten, um Teilfuellungen nachzustellen.
    if (!p.reduceOnly && optionen.einstiegeFuellen === false) return false;

    if (p.type === 'stop' && p.stopPrice != null) {
      return p.side === 'sell' ? kurs <= p.stopPrice : kurs >= p.stopPrice;
    }
    if (p.price == null) return false;
    return p.side === 'buy' ? kurs <= p.price : kurs >= p.price;
  }

  const broker: BrokerAdapter = {
    name: 'attrappe',
    connect: async () => {},
    disconnect: async () => {},
    getPrice: async () => kurs,
    setLeverage: async () => {},

    placeOrder: async (p: OrderParams): Promise<OrderResult> => {
      platziert.push(p);
      nummer++;
      const id = `boerse-${nummer}`;
      if (p.type !== 'market') liegend.set(id, p);

      return {
        orderId: id,
        clientOrderId: p.clientOrderId ?? '',
        symbol: p.symbol, side: p.side, type: p.type,
        quantity: p.quantity, price: p.price ?? 0,
        status: p.type === 'market' ? 'filled' : 'new',
        filledQuantity: p.type === 'market' ? p.quantity : 0,
        avgFillPrice: p.price ?? kurs,
        timestamp: Date.now(),
      };
    },

    cancelOrder: async (_symbol: string, orderId: string) => {
      storniert.push(orderId);
      liegend.delete(orderId);
    },

    getOrder: async (_symbol: string, orderId: string): Promise<OrderResult | null> => {
      const p = liegend.get(orderId);
      if (!p) return null;

      if (!gefuellt.has(orderId) && wuerdeFuellen(p)) gefuellt.add(orderId);
      const ist = gefuellt.has(orderId);

      return {
        orderId,
        clientOrderId: p.clientOrderId ?? '',
        symbol: p.symbol, side: p.side, type: p.type,
        quantity: p.quantity, price: p.price ?? 0,
        status: ist ? 'filled' : 'new',
        filledQuantity: ist ? p.quantity : 0,
        avgFillPrice: p.stopPrice ?? p.price ?? kurs,
        timestamp: Date.now(),
      };
    },

    getPosition: async () => null,
  };

  return {
    platziert, storniert, broker,
    /**
     * Bewegt den Kurs AN DER BOERSE, ohne dass der Monitor ihn sieht.
     *
     * Damit laesst sich der Docht nachstellen: Das Orderbuch bekommt
     * ihn mit, die Kursabfrage des Bots nicht.
     */
    setKurs: (k: number) => { kurs = k; },
    registry: { get: async () => broker } as unknown as BrokerRegistry,
  };
}

/** Long auf BTCUSDT: drei gestaffelte Einstiege, zwei Ziele, Stop. */
function plan() {
  return {
    id: 'plan-1',
    source: 'signal' as const,
    exchange: 'paper',
    symbol: 'BTCUSDT',
    market_type: 'futures' as const,
    direction: 'long' as const,
    leverage: 10,
    total_size: 0.3,
    entry_strategy: 'equal' as const,
    entry_orders: [
      { id: 'e1', price: 50_000, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'e2', price: 49_000, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'e3', price: 48_500, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
    ],
    entry_zones: null,
    take_profits: [
      { price: 52_000, percentage: 30, order_type: 'limit' as const, status: 'pending' as const },
      { price: 55_000, percentage: 70, order_type: 'limit' as const, status: 'pending' as const },
    ],
    stop_loss_price: 47_000,
    stop_loss_type: 'fixed' as const,
    trailing_stop_pct: null,
    trailing_stop_activation: null,
    trailing_stop_size_pct: null,
    activation_conditions: [],
    status: 'active' as const,
    bot_enabled: true,
    executed_orders: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

interface MonitorIntern {
  registerPlan(p: unknown): void;
  processPlan(state: unknown, preis: number): Promise<void>;
  getState(id: string): {
    remainingSize: number;
    tpState: Array<{ triggered: boolean }>;
    slCurrent: number | null;
    status: string;
  } | undefined;
}

describe('TradePlanMonitor — Orders liegen an der Boerse', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'orderbuch-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function baue(broker: ReturnType<typeof boerseAttrappe>) {
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const p = plan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);
    return { monitor, state: monitor.getState('plan-1')! };
  }

  /** Zwei Durchlaeufe: legen, dann nach Fuellungen sehen. */
  async function takt(
    broker: ReturnType<typeof boerseAttrappe>,
    monitor: MonitorIntern, state: unknown, preis: number,
  ) {
    broker.setKurs(preis);
    await monitor.processPlan(state, preis);
    await monitor.processPlan(state, preis);
  }

  /** Einen Einstieg als gefuellt eintragen. */
  function einstiegGefuellt(nr = 0, menge = 0.1, preis = 50_000) {
    const entries = store.getPlanOrders('plan-1').filter(o => o.role === 'entry');
    store.updatePlanOrder(entries[nr]!.id as string, {
      status: 'filled', filled_quantity: menge, avg_fill_price: preis,
    });
  }

  it('legt alle Einstiege sofort ins Orderbuch', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    // Der Kurs steht WEIT ueber allen drei Einstiegen — frueher waere
    // keine einzige Order herausgegangen.
    await takt(broker, monitor, state, 60_000);

    const kaeufe = broker.platziert.filter(o => o.side === 'buy');
    expect(kaeufe).toHaveLength(3);
    expect(kaeufe.every(o => o.type === 'limit')).toBe(true);
    expect(kaeufe.every(o => o.reduceOnly !== true)).toBe(true);
  });

  it('legt alle Take-Profits, sobald eine Position steht', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();

    // Kurs weit UNTER allen Zielen — sie gehoeren trotzdem gelegt.
    await takt(broker, monitor, state, 50_100);

    const ziele = store.getPlanOrders('plan-1')
      .filter(o => o.role === 'take_profit' && o.status !== 'cancelled');

    expect(ziele).toHaveLength(2);
    expect(ziele.every(o => o.order_type === 'limit')).toBe(true);
  });

  it('hinterlegt den Stop als Order an der Boerse', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    const stops = broker.platziert.filter(o => o.type === 'stop');
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]!.stopPrice).toBeCloseTo(47_000, 6);
    expect(stops[0]!.reduceOnly).toBe(true);
    // Geschuetzt wird, was offen ist.
    expect(stops[0]!.quantity).toBeCloseTo(0.1, 10);
  });

  it('nimmt das Ziel beim Docht mit, ohne dass der Bot den Kurs sieht', async () => {
    // Der Fall vom 25.10.
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    // Der Docht: An der Boerse beruehrt der Kurs 52.000 — der Bot
    // sieht aber weiter 50.200.
    broker.setKurs(52_000);
    await monitor.processPlan(state, 50_200);

    expect(state.tpState[0]!.triggered).toBe(true);
  });

  it('loest den Stop aus, ohne dass der Bot den Kurs sieht', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    // Der Kurs faellt an der Boerse unter den Stop — der Bot sieht
    // weiter 50.100. Genau der Fall, in dem Aufsicht am noetigsten ist.
    broker.setKurs(46_500);
    await monitor.processPlan(state, 50_100);

    const stopOrders = store.getPlanOrders('plan-1')
      .filter(o => (o.role === 'stop_loss' || o.role === 'trailing_stop') &&
        Number(o.filled_quantity ?? 0) > 0);
    expect(stopOrders.length).toBeGreaterThan(0);
  });

  it('fuehrt die Ziele nach, wenn nachgekauft wurde', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt(0);
    await takt(broker, monitor, state, 50_100);

    const vorher = broker.platziert.filter(o => o.reduceOnly === true).length;

    // Ein zweiter Einstieg wird gefuellt — die Ziele muessen wachsen.
    einstiegGefuellt(1, 0.1, 49_000);
    await takt(broker, monitor, state, 50_100);

    expect(broker.storniert.length).toBeGreaterThan(0);
    expect(broker.platziert.filter(o => o.reduceOnly === true).length)
      .toBeGreaterThan(vorher);
  });

  it('zieht die Stop-Order mit, wenn der Stop wandert', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    const ersterStop = broker.platziert.filter(o => o.type === 'stop').pop();
    expect(ersterStop!.stopPrice).toBeCloseTo(47_000, 6);

    // Der Stop wandert — etwa nach einem Take-Profit.
    state.slCurrent = 49_500;
    await takt(broker, monitor, state, 50_100);

    const letzterStop = broker.platziert.filter(o => o.type === 'stop').pop();
    expect(letzterStop!.stopPrice).toBeCloseTo(49_500, 6);
    // Die alte wurde zurueckgenommen — zwei Stops schlossen zusammen
    // mehr, als offen ist.
    expect(broker.storniert.length).toBeGreaterThan(0);
  });

  it('legt keine Order ein zweites Mal, solange sich nichts aendert', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    const nachErstem = broker.platziert.length;
    const storniertVorher = broker.storniert.length;

    for (let i = 0; i < 10; i++) await takt(broker, monitor, state, 50_100 + i);

    // Ohne Toleranz beim Mengenvergleich wuerde hier bei jedem
    // Durchlauf zurueckgenommen und neu gelegt — im Takt der
    // Kursabfrage.
    expect(broker.platziert.length).toBe(nachErstem);
    expect(broker.storniert.length).toBe(storniertVorher);
  });

  it('nimmt die Ausstiegs-Orders zurueck, wenn nichts mehr offen ist', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    const vorher = broker.storniert.length;

    // Die Position wird geschlossen.
    store.insertPlanOrder({
      id: 'o-zu', trade_plan_id: 'plan-1', side: 'sell', order_type: 'market',
      role: 'take_profit', symbol: 'BTCUSDT', price: 52_000, quantity: 0.1,
      status: 'filled', broker: 'attrappe',
    });
    store.updatePlanOrder('o-zu', { filled_quantity: 0.1, avg_fill_price: 52_000 });

    await takt(broker, monitor, state, 50_100);

    // Was noch im Orderbuch laege, koennte eine spaetere Position
    // anknabbern.
    expect(broker.storniert.length).toBeGreaterThan(vorher);
  });

  it('legt nach einem Neustart keine zweite Stop-Order', async () => {
    // Beim Ausrollen am 25.10. passiert: `slOrderId` lebt im
    // Arbeitsspeicher und ueberlebt den Neustart nicht. Die Order lag
    // weiter an der Boerse — und der frische Monitor legte eine
    // zweite. Zwei Stops ueber je 124,19 bei 124,19 offener Position.
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    const nachErstem = broker.platziert.filter(o => o.type === 'stop').length;
    expect(nachErstem).toBe(1);

    // Neustart: ein frischer Monitor auf derselben Datenbank.
    const zweiter = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;
    zweiter.registerPlan(plan());
    const neuerState = zweiter.getState('plan-1')!;

    await takt(broker, zweiter, neuerState, 50_100);

    // Die liegende Order wurde aus den Orders wiedererkannt.
    expect(broker.platziert.filter(o => o.type === 'stop').length).toBe(nachErstem);
  });

  it('raeumt eine doppelt vorhandene Stop-Order auf', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    // Eine zweite Stop-Order von Hand eintragen — so, wie sie nach
    // dem Fehler vom 25.10. in der Datenbank stand.
    store.insertPlanOrder({
      id: 'stop-doppelt', trade_plan_id: 'plan-1', side: 'sell',
      order_type: 'stop', role: 'stop_loss', symbol: 'BTCUSDT',
      price: 47_000, stop_price: 47_000, quantity: 0.1,
      status: 'new', broker: 'attrappe', broker_order_id: 'boerse-doppelt',
    });

    const zweiter = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;
    zweiter.registerPlan(plan());
    await takt(broker, zweiter, zweiter.getState('plan-1')!, 50_100);

    // Genau eine bleibt liegen.
    const liegende = store.getPlanOrders('plan-1').filter(o =>
      o.role === 'stop_loss' && o.status === 'new');
    expect(liegende).toHaveLength(1);
  });

  it('legt nach einem Neustart keine zweiten Ziel-Orders', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 50_500);
    einstiegGefuellt();
    await takt(broker, monitor, state, 50_100);

    const nachErstem = store.getPlanOrders('plan-1')
      .filter(o => o.role === 'take_profit' && o.status === 'new').length;
    expect(nachErstem).toBe(2);

    const zweiter = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;
    zweiter.registerPlan(plan());
    await takt(broker, zweiter, zweiter.getState('plan-1')!, 50_100);

    const danach = store.getPlanOrders('plan-1')
      .filter(o => o.role === 'take_profit' && o.status === 'new').length;
    expect(danach).toBe(nachErstem);
  });

  it('legt die Ziele nicht, solange keine Position steht', async () => {
    const broker = boerseAttrappe({ einstiegeFuellen: false });
    const { monitor, state } = baue(broker);

    // Einstiege liegen, aber keiner ist gefuellt.
    await takt(broker, monitor, state, 50_500);

    const ausstiege = broker.platziert.filter(o => o.reduceOnly === true);
    // Eine Nur-Schliessen-Order ohne Position weist die Boerse ab —
    // und schlimmer: Ohne diese Pruefung eroeffnete sie im
    // Netting-Modus eine Gegenposition.
    expect(ausstiege).toHaveLength(0);
  });
});
