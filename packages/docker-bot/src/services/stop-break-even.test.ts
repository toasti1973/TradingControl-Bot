// ============================================================
// Nach dem ersten Take-Profit kann der Plan nicht mehr ins Minus
//
// Ein Signal rechnet seinen Break-Even-Stop auf die GEPLANTE
// Einstiegsstaffel. Fuellt davon nur ein Teil, liegt er unter dem
// tatsaechlichen Einstand — und der Trade endet trotz mitgenommenem
// Gewinn im Verlust.
//
// Das ist kein gedachter Fall. BNBUSDT am 26.10.2026:
//
//   geplante Einstiege   739,96 / 738,39 / 736,83 / 735,26
//   Durchschnitt davon   737,61   <- darauf setzte das Signal den Stop
//   tatsaechlich gefuellt   nur 739,96 (der erste)
//
//   TP1  (743,86 - 739,96) x 1,36399069  =  +5,32
//   SL   (737,61 - 739,96) x 4,09197206  =  -9,62
//   Gebuehren                               -1,91
//                                          ------
//                                           -6,21 USDT
//
// Der Stop lag 2,35 unter dem Einstand. 25 % der Position gingen mit
// Gewinn heraus, 75 % mit Verlust — rechnerisch konnte dieser Trade
// nach TP1 gar nicht mehr positiv enden.
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
 * Boerse, die nur AUSSTIEGE von selbst fuellt.
 *
 * Take-Profits und Stops werden gefuellt, sobald der Kurs sie
 * beruehrt — so wie ein echtes Orderbuch es taete. Die Einstiege
 * setzt der Test von Hand: Es geht hier gerade um den Fall, dass von
 * vier geplanten nur einer zustande kam.
 */
function boerseAttrappe() {
  const platziert: OrderParams[] = [];
  const storniert: string[] = [];
  const liegend = new Map<string, OrderParams>();
  const gefuellt = new Set<string>();
  let nummer = 0;
  let kurs = 739.96;

  function wuerdeFuellen(p: OrderParams): boolean {
    if (!p.reduceOnly) return false;          // Einstiege: nur von Hand
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

    cancelOrder: async (_s: string, orderId: string) => {
      storniert.push(orderId);
      liegend.delete(orderId);
    },

    getOrder: async (_s: string, orderId: string): Promise<OrderResult | null> => {
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
        avgFillPrice: ist ? (p.stopPrice ?? p.price ?? kurs) : 0,
        timestamp: Date.now(),
      };
    },

    getPosition: async () => null,
  };

  return {
    platziert, storniert, broker,
    setKurs: (k: number) => { kurs = k; },
    registry: { get: async () => broker } as unknown as BrokerRegistry,
  };
}

/** Der BNBUSDT-Plan vom 26.10.2026, Zahlen aus der Datenbank. */
function bnbPlan() {
  return {
    id: 'plan-bnb',
    source: 'signal' as const,
    exchange: 'paper',
    symbol: 'BNBUSDT',
    market_type: 'futures' as const,
    direction: 'long' as const,
    leverage: 16,
    total_size: 21.823851,
    entry_strategy: 'equal' as const,
    entry_orders: [
      { id: 'e1', price: 739.96, size: 5.45596275, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'e2', price: 738.39, size: 5.45596275, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'e3', price: 736.83, size: 5.45596275, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'e4', price: 735.26, size: 5.45596275, order_type: 'limit' as const, status: 'pending' as const },
    ],
    entry_zones: null,
    take_profits: [
      // Genau wie im Signal: Stop auf 737,61 — den Durchschnitt ALLER
      // vier geplanten Einstiege.
      {
        price: 743.86, percentage: 25, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 737.61,
      },
      {
        price: 747.42, percentage: 32.5, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 743.86,
      },
      {
        price: 750.99, percentage: 32.5, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 747.42,
      },
    ],
    stop_loss_price: 733.03,
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
  setzeStopLoss(
    planId: string, stop: number, herkunft: { quelle: string; signalId?: string },
  ): Promise<{ geaendert: boolean; grund: string; vorher: number | null }>;
  getState(id: string): {
    remainingSize: number;
    tpState: Array<{ triggered: boolean; filledPrice?: number }>;
    slCurrent: number | null;
    slType: string;
    trailingBestPrice?: number | null;
    plan: { direction: string; trailing_stop_pct: number | null };
  } | undefined;
}

describe('Stop auf den Einstand — der BNBUSDT-Fall', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'breakeven-'));
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

    const p = bnbPlan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);
    return { monitor, state: monitor.getState('plan-bnb')! };
  }

  async function takt(
    broker: ReturnType<typeof boerseAttrappe>,
    monitor: MonitorIntern, state: unknown, preis: number,
  ) {
    broker.setKurs(preis);
    await monitor.processPlan(state, preis);
    await monitor.processPlan(state, preis);
  }

  /** Trägt eine Einstiegsfuellung ein, wie der Monitor es tut. */
  function einstiegGefuellt(nr: number, menge: number, preis: number) {
    const entries = store.getPlanOrders('plan-bnb').filter(o => o.role === 'entry');
    const order = entries[nr];
    if (!order) throw new Error(`Einstieg ${nr} nicht gefunden`);
    store.updatePlanOrder(order.id as string, {
      status: 'filled', filled_quantity: menge, avg_fill_price: preis,
    });
  }

  it('zieht den Stop auf den echten Einstand statt auf den geplanten Durchschnitt', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 739.96);
    // Nur der erste Einstieg fuellt — wie am 26.10.
    einstiegGefuellt(0, 5.45596275, 739.96);
    await takt(broker, monitor, state, 739.96);

    // Vor dem Take-Profit steht der urspruengliche Stop.
    expect(state.slCurrent).toBeCloseTo(733.03, 2);

    // TP1 greift.
    await takt(broker, monitor, state, 743.86);

    expect(state.tpState[0]!.triggered).toBe(true);

    // Das Signal wollte 737,61. Der echte Einstand ist 739,96 — und
    // der gilt. Genau diese 2,35 Differenz kosteten 6,21 USDT.
    expect(state.slCurrent).toBeCloseTo(739.96, 4);
    expect(state.slCurrent).not.toBeCloseTo(737.61, 2);
  });

  it('laesst den Stop des Signals stehen, wenn er bereits besser liegt', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 739.96);
    // Diesmal fuellen alle vier — der Einstand ist dann 737,61 …
    einstiegGefuellt(0, 5.45596275, 739.96);
    einstiegGefuellt(1, 5.45596275, 738.39);
    einstiegGefuellt(2, 5.45596275, 736.83);
    einstiegGefuellt(3, 5.45596275, 735.26);
    await takt(broker, monitor, state, 739.96);

    await takt(broker, monitor, state, 743.86);

    // … und damit liegt der Stop des Signals genau richtig. Die
    // Schranke greift nicht ein: Sie korrigiert nur, was danebenliegt.
    expect(state.slCurrent).toBeCloseTo(737.61, 2);
  });

  it('verschiebt den Stop niemals in die riskante Richtung', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 739.96);
    einstiegGefuellt(0, 5.45596275, 739.96);
    await takt(broker, monitor, state, 739.96);
    await takt(broker, monitor, state, 743.86);

    const nachTp1 = state.slCurrent!;
    expect(nachTp1).toBeCloseTo(739.96, 4);

    // TP2 will auf 743,86 — das ist BESSER als der Einstand, also gilt es.
    await takt(broker, monitor, state, 747.42);
    expect(state.slCurrent!).toBeGreaterThanOrEqual(nachTp1);
  });

  it('greift auch beim Short — dort nach unten', async () => {
    const broker = boerseAttrappe();
    const p = bnbPlan();
    p.id = 'plan-short';
    p.direction = 'short' as 'long';
    p.entry_orders = [
      { id: 's1', price: 100, size: 10, order_type: 'limit' as const, status: 'pending' as const },
      { id: 's2', price: 102, size: 10, order_type: 'limit' as const, status: 'pending' as const },
    ];
    // Das Signal rechnet mit dem Durchschnitt beider Einstiege (101).
    //
    // Ein zweites, nicht erreichtes Ziel steht dahinter: Sonst griffe
    // zusaetzlich die Regel "alle Ziele erreicht" und setzte den Stop
    // auf 95 — richtig, aber hier nicht das, was geprueft wird.
    p.take_profits = [
      {
        price: 95, percentage: 40, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 101,
      },
      {
        price: 90, percentage: 40, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: false, sl_new_price: 0,
      },
    ];
    p.stop_loss_price = 105;

    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);
    const state = monitor.getState('plan-short')!;

    await takt(broker, monitor, state, 100);
    // Nur der erste Short-Einstieg fuellt, zu 100.
    const entries = store.getPlanOrders('plan-short').filter(o => o.role === 'entry');
    store.updatePlanOrder(entries[0]!.id as string, {
      status: 'filled', filled_quantity: 10, avg_fill_price: 100,
    });
    await takt(broker, monitor, state, 100);
    await takt(broker, monitor, state, 95);

    // Das Signal wollte 101 — das laege ÜBER dem Einstand und damit im
    // Verlust. Beim Short ist der sichere Stop der niedrigere.
    expect(state.slCurrent).toBeCloseTo(100, 4);
  });

  it('tut nichts, solange kein Einstieg gefuellt ist', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baue(broker);

    await takt(broker, monitor, state, 739.96);

    // Ohne Fuellung gibt es keinen Einstand — der Stop bleibt, wo er war.
    expect(state.slCurrent).toBeCloseTo(733.03, 2);
  });
});

// ============================================================
// Alle Ziele erreicht — der Stop darf nicht unter das letzte fallen
//
// Die Signale ziehen den Stop stufenweise nach: TP2 setzt ihn auf TP1,
// TP3 auf TP2, TP4 auf TP3. Nach dem LETZTEN Ziel kommt diese Stufe
// nicht mehr — ab hier traegt allein das Trailing.
//
// HYPEUSDT am 27.10.2026, alle vier Ziele erreicht:
//
//   TP4 gefuellt zu       80,1464
//   Stop danach (= TP3)   79,6404
//   Hoechstkurs seither   80,497
//   Trailing 1,5 % davon  79,2895   <- noch unter dem Stop
//
// Das Trailing haette erst ab einem Kurs von 80,853 gegriffen. Bis
// dahin hingen 1,11 USDT bereits erreichter Gewinn in der Luft.
// ============================================================

/** Der HYPEUSDT-Plan: vier Ziele, Stop folgt jeweils dem vorherigen. */
function hypePlan() {
  return {
    id: 'plan-hype',
    source: 'signal' as const,
    exchange: 'paper',
    symbol: 'HYPEUSDT',
    market_type: 'futures' as const,
    direction: 'long' as const,
    leverage: 7,
    total_size: 87.94084664,
    entry_strategy: 'equal' as const,
    entry_orders: [
      { id: 'h1', price: 77.812, size: 21.98521166, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'h2', price: 77.3391, size: 21.98521166, order_type: 'limit' as const, status: 'pending' as const },
    ],
    entry_zones: null,
    take_profits: [
      {
        price: 78.2322, percentage: 25, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 77.1027,
      },
      {
        price: 79.1345, percentage: 21.7, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 78.2322,
      },
      {
        price: 79.6404, percentage: 21.7, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 79.1345,
      },
      {
        // Das letzte Ziel zieht den Stop auf TP3 — und schaltet das
        // Trailing ein. Danach kommt keine Stufe mehr.
        //
        // Die vier Anteile ergeben zusammen 90,1 %, nicht 100: Ein
        // Rest von knapp 10 % bleibt im Markt und laeuft mit dem
        // Trailing weiter. Genau um diesen Rest geht es hier.
        price: 80.1464, percentage: 21.7, order_type: 'limit' as const, status: 'pending' as const,
        sl_adjust: true, sl_new_price: 79.6404,
        activate_trailing: true, trailing_pct: 1.5,
      },
    ],
    stop_loss_price: 76.0225,
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

describe('Alle Ziele erreicht — der HYPEUSDT-Fall', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'zielsicher-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function baueHype(broker: ReturnType<typeof boerseAttrappe>) {
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const p = hypePlan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);
    return { monitor, state: monitor.getState('plan-hype')! };
  }

  async function takt(
    broker: ReturnType<typeof boerseAttrappe>,
    monitor: MonitorIntern, state: unknown, preis: number,
  ) {
    broker.setKurs(preis);
    await monitor.processPlan(state, preis);
    await monitor.processPlan(state, preis);
  }

  /** Bringt den Plan in den Zustand "alle vier Ziele erreicht". */
  async function alleZieleErreichen(
    broker: ReturnType<typeof boerseAttrappe>, monitor: MonitorIntern, state: {
      tpState: Array<{ triggered: boolean }>;
    },
  ) {
    await takt(broker, monitor, state, 77.812);
    const entries = store.getPlanOrders('plan-hype').filter(o => o.role === 'entry');
    store.updatePlanOrder(entries[0]!.id as string, {
      status: 'filled', filled_quantity: 21.98521166, avg_fill_price: 77.812,
    });
    await takt(broker, monitor, state, 77.812);

    for (const kurs of [78.2322, 79.1345, 79.6404, 80.1464]) {
      await takt(broker, monitor, state, kurs);
    }
    return state.tpState.every(t => t.triggered);
  }

  it('hebt den Stop auf das letzte Ziel, sobald der Kurs Abstand hat', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);

    expect(await alleZieleErreichen(broker, monitor, state)).toBe(true);

    // Unmittelbar nach dem Fill steht der Kurs AUF dem Ziel — da wird
    // noch gewartet. Sonst laege der Stop auf dem Kurs.
    expect(state.slCurrent).toBeCloseTo(79.6404, 4);

    // Ein Stueck weiter: Jetzt greift die Grenze.
    await takt(broker, monitor, state, 80.216);

    // Das Signal wollte 79,6404 (= TP3). Weil kein Ziel mehr folgt,
    // gilt das letzte erreichte: 80,1464.
    expect(state.slCurrent).toBeCloseTo(80.1464, 4);
  });

  // Ein Stop auf Hoehe des Kurses ist kein Stop, sondern ein Verkauf
  // zu Markt. Ohne diese Wartezeit loeste er im Test zweimal in
  // derselben Sekunde aus und schloss mehr, als offen war.
  it('legt den Stop nicht auf den Kurs selbst', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);
    await alleZieleErreichen(broker, monitor, state);

    // 80,1464 + 0,05 % = 80,187. Alles darunter ist zu dicht.
    await takt(broker, monitor, state, 80.15);
    expect(state.slCurrent).toBeCloseTo(79.6404, 4);

    await takt(broker, monitor, state, 80.19);
    expect(state.slCurrent).toBeCloseTo(80.1464, 4);

    // Und die Restposition steht noch — nichts wurde vorzeitig
    // geschlossen.
    const offen = (monitor as unknown as {
      offenePosition(s: unknown): number;
    }).offenePosition(state);
    expect(offen).toBeGreaterThan(0);
  });

  it('laesst das Trailing den Stop nicht wieder darunter ziehen', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);
    await alleZieleErreichen(broker, monitor, state);

    // Der Kurs lief auf 80,497 — 1,5 % darunter sind 79,2895, also
    // deutlich unter dem letzten Ziel. Genau hier lag die Luecke.
    await takt(broker, monitor, state, 80.497);
    expect(state.slCurrent).toBeCloseTo(80.1464, 4);

    // Und bei 80,216, dem Kurs aus dem Bildschirmfoto. Das Trailing
    // rechnet weiter 79,2895 — die Grenze haelt dagegen.
    await takt(broker, monitor, state, 80.216);
    expect(state.slCurrent).toBeCloseTo(80.1464, 4);
  });

  it('laesst das Trailing weiter nachziehen, sobald es darueber liegt', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);
    await alleZieleErreichen(broker, monitor, state);

    // Ab 81,37 liegen 1,5 % darunter ueber dem letzten Ziel —
    // 81,37 * 0,985 = 80,149. Die Grenze blockiert nicht, sie haelt
    // nur einen Boden.
    await takt(broker, monitor, state, 82);
    expect(state.slCurrent!).toBeGreaterThan(80.1464);
    expect(state.slCurrent!).toBeCloseTo(82 * 0.985, 3);
  });

  it('greift nicht, solange noch ein Ziel offen ist', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);

    await takt(broker, monitor, state, 77.812);
    const entries = store.getPlanOrders('plan-hype').filter(o => o.role === 'entry');
    store.updatePlanOrder(entries[0]!.id as string, {
      status: 'filled', filled_quantity: 21.98521166, avg_fill_price: 77.812,
    });
    await takt(broker, monitor, state, 77.812);

    // Nur die ersten drei Ziele.
    for (const kurs of [78.2322, 79.1345, 79.6404]) {
      await takt(broker, monitor, state, kurs);
    }

    // TP4 steht noch aus und zoege den Stop selbst nach. Haelt man ihn
    // jetzt schon auf TP3, ist die Luft weg, die das Signal dem Trade
    // bewusst laesst.
    expect(state.tpState[3]!.triggered).toBe(false);
    expect(state.slCurrent).toBeCloseTo(79.1345, 4);
  });

  it('wirkt auch nach einem Neustart', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);
    await alleZieleErreichen(broker, monitor, state);

    // Einen Zustand nachstellen, wie ihn ein Neustart wiederherstellt:
    // Der Stop steht auf dem Wert des Signals, `tpErreicht()` laeuft
    // nie wieder. Ohne die Pruefung im Durchlauf bliebe es dabei.
    state.slCurrent = 79.6404;
    await takt(broker, monitor, state, 80.216);

    expect(state.slCurrent).toBeCloseTo(80.1464, 4);
  });

  it('nimmt den tatsaechlichen Fuellpreis, nicht den geplanten', async () => {
    const broker = boerseAttrappe();
    const { monitor, state } = baueHype(broker);
    await alleZieleErreichen(broker, monitor, state);

    // Ein Ziel, das besser fuellte als geplant, zaehlt mit seinem
    // echten Preis — das ist das, was wirklich erloest wurde.
    state.tpState[3]!.filledPrice = 80.30;
    state.slCurrent = 79.6404;
    await takt(broker, monitor, state, 80.5);

    expect(state.slCurrent).toBeCloseTo(80.30, 4);
  });
});

// ============================================================
// Der Stop von aussen — TC-Synaptrix korrigiert nach
// ============================================================

describe('setzeStopLoss — der Weg fuer TC-Synaptrix', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'extstop-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function baue() {
    const broker = boerseAttrappe();
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const p = bnbPlan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);
    return { monitor, state: monitor.getState('plan-bnb')! };
  }

  it('nimmt einen Stop an, der das Risiko verkleinert', async () => {
    const { monitor, state } = baue();
    expect(state.slCurrent).toBeCloseTo(733.03, 2);

    const ergebnis = await monitor.setzeStopLoss('plan-bnb', 739.96, {
      quelle: 'signal', signalId: 'mbcma-f23-11811710',
    });

    expect(ergebnis.geaendert).toBe(true);
    expect(state.slCurrent).toBeCloseTo(739.96, 4);
  });

  it('lehnt einen Stop ab, der das Risiko vergroessern wuerde', async () => {
    const { monitor, state } = baue();

    // 730 liegt WEITER weg als die 733,03 des Plans — das waere mehr
    // Risiko, als beim Eroeffnen vereinbart war.
    const ergebnis = await monitor.setzeStopLoss('plan-bnb', 730, { quelle: 'signal' });

    expect(ergebnis.geaendert).toBe(false);
    expect(ergebnis.grund).toContain('Risiko');
    expect(state.slCurrent).toBeCloseTo(733.03, 2);
  });

  it('lehnt beim Short einen hoeheren Stop ab', async () => {
    const broker = boerseAttrappe();
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const p = bnbPlan();
    p.id = 'plan-s';
    p.direction = 'short' as 'long';
    p.stop_loss_price = 750;
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);

    const hoeher = await monitor.setzeStopLoss('plan-s', 760, { quelle: 'signal' });
    expect(hoeher.geaendert).toBe(false);

    const niedriger = await monitor.setzeStopLoss('plan-s', 745, { quelle: 'signal' });
    expect(niedriger.geaendert).toBe(true);
  });

  it('weist einen unbrauchbaren Preis ab', async () => {
    const { monitor } = baue();

    for (const unsinn of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ergebnis = await monitor.setzeStopLoss('plan-bnb', unsinn, { quelle: 'signal' });
      expect(ergebnis.geaendert).toBe(false);
    }
  });

  it('meldet einen Plan, der nicht ueberwacht wird', async () => {
    const { monitor } = baue();
    const ergebnis = await monitor.setzeStopLoss('gibt-es-nicht', 700, { quelle: 'signal' });

    expect(ergebnis.geaendert).toBe(false);
    expect(ergebnis.grund).toContain('nicht ueberwacht');
  });

  it('macht aus einem Trailing-Stop einen festen', async () => {
    const { monitor, state } = baue();
    state.slType = 'trailing';

    await monitor.setzeStopLoss('plan-bnb', 739.96, { quelle: 'signal' });

    // Bliebe er auf 'trailing', zoege die Prozentregel ihn beim
    // naechsten Kursschlag wieder weg — das Update waere vergessen.
    expect(state.slType).toBe('fixed');
  });
});

// ============================================================
// Der Trailing-Stop darf einen gesetzten Schutz nicht unterlaufen
// ============================================================

describe('Trailing-Stop — Erstsetzung', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'trailing-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('senkt einen bereits gesetzten Stop nicht durch den ersten Trailing-Lauf', async () => {
    const broker = boerseAttrappe();
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern & {
      updateTrailingStop(state: unknown, preis: number): void;
    };

    const p = bnbPlan();
    p.trailing_stop_pct = 1.5 as unknown as null;
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(p);
    const state = monitor.getState('plan-bnb')!;

    // Der Stop steht bereits auf dem Einstand.
    state.slCurrent = 739.96;
    state.trailingBestPrice = null;

    // Jetzt laeuft das Trailing zum ersten Mal — bei 742 ergaeben
    // 1,5 % einen Stop von 730,87. Das waere ein Rueckschritt unter
    // den Einstand.
    monitor.updateTrailingStop(state, 742);

    expect(state.slCurrent).toBeCloseTo(739.96, 4);
  });
});
