// ============================================================
// Einen Plan beenden — und was dabei nicht passieren darf
//
// Der gefaehrliche Fall ist nicht der, in dem etwas schiefgeht, sondern
// der, in dem es schiefgeht und niemand es merkt: Ein Plan, der als
// beendet gilt, waehrend seine Position weiterlaeuft, wird von
// niemandem mehr ueberwacht. Kein Stop wird nachgezogen, kein Gewinn
// mitgenommen — die Position laeuft, bis sie jemand von Hand findet.
//
// Genau so verhielt sich der alte Weg ueber `unregisterPlan`: Er nahm
// den Plan sofort aus der Ueberwachung, und das Aufraeumen der Orders
// im Poll-Durchlauf sah ihn nie wieder.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { TradePlanMonitor } from './trade-plan-monitor.js';
import { ErgebnisService } from './ergebnis-service.js';
import type { BrokerRegistry } from './broker-factory.js';
import type { Logger } from './log-service.js';
import type { BrokerAdapter, OrderParams, OrderResult } from '@tradingcontrol/core';

const stilleAusgabe = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
} as unknown as Logger;

/**
 * Broker-Attrappe.
 *
 * `marketFehler` laesst das Schliessen der Position scheitern — der
 * wichtigste Fall dieser Datei.
 */
function brokerAttrappe(optionen: {
  preis?: number;
  cancelFehler?: boolean;
  marketFehler?: boolean;
  /**
   * Weist Nur-Schliessen-Orders ab, statt einen Fehler zu werfen.
   *
   * Der feinere Unterschied zu `marketFehler`: Die Boerse antwortet
   * ordentlich, nur eben mit 'rejected'. Genau so verhielt sich der
   * Uebungsbroker am 25.10. — und genau diese Antwort wurde frueher
   * als Erfolg gelesen.
   */
  reduceOnlyAbweisen?: boolean;
} = {}) {
  const platziert: OrderParams[] = [];
  const storniert: string[] = [];
  const offeneLimits = new Map<string, OrderParams>();
  let laufendeNummer = 0;
  const kurs = optionen.preis ?? 50_000;

  const broker: BrokerAdapter = {
    name: 'attrappe',
    connect: async () => {},
    disconnect: async () => {},
    getPrice: async () => kurs,
    setLeverage: async () => {},
    placeOrder: async (p: OrderParams): Promise<OrderResult> => {
      if (p.type === 'market' && optionen.marketFehler) {
        throw new Error('Boerse lehnt die Order ab');
      }
      platziert.push(p);
      laufendeNummer++;
      const id = `boerse-${laufendeNummer}`;

      if (optionen.reduceOnlyAbweisen && p.reduceOnly) {
        return {
          orderId: id,
          clientOrderId: p.clientOrderId ?? '',
          symbol: p.symbol, side: p.side, type: p.type,
          quantity: p.quantity, price: p.price ?? 0,
          status: 'rejected',
          filledQuantity: 0,
          avgFillPrice: 0,
          timestamp: Date.now(),
        };
      }

      if (p.type !== 'market') offeneLimits.set(id, p);

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
      if (optionen.cancelFehler) throw new Error('Boerse nicht erreichbar');
      storniert.push(orderId);
      offeneLimits.delete(orderId);
    },
    getOrder: async () => null,
    getPosition: async () => null,
  };

  return {
    platziert, storniert, broker,
    registry: { get: async () => broker } as unknown as BrokerRegistry,
  };
}

function plan() {
  return {
    id: 'plan-1',
    source: 'signal' as const,
    exchange: 'paper',
    symbol: 'BTCUSDT',
    market_type: 'futures' as const,
    direction: 'long' as const,
    leverage: 10,
    total_size: 0.2,
    entry_strategy: 'equal' as const,
    entry_orders: [
      { id: 'e1', price: 50_000, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
      { id: 'e2', price: 49_000, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
    ],
    entry_zones: null,
    take_profits: [{ price: 52_000, percentage: 100, order_type: 'limit' as const, status: 'pending' as const }],
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
  start(): void;
  stop(): void;
  registerPlan(plan: unknown): void;
  beendePlan(id: string, grund?: 'benutzer_abbruch' | 'benutzer_beendet'): Promise<{
    geschlosseneMenge: number; stornierteOrders: number; status: 'cancelled' | 'completed';
  }>;
  getState(id: string): { status: string; remainingSize: number } | undefined;
  getAllStates(): unknown[];
}

describe('TradePlanMonitor — einen Plan beenden', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'beenden-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));

    const p = plan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]',
      executed_orders: '[]',
      execution_mode: 'all_limit',
      entry_zones: null,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  const baue = (broker: ReturnType<typeof brokerAttrappe>) =>
    new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false,
      defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

  /** Ein gefuellter Einstieg — der Plan steht damit im Markt. */
  function einstiegGefuellt(menge = 0.1, preis = 50_000) {
    store.insertPlanOrder({
      id: 'order-e1', trade_plan_id: 'plan-1', entry_order_id: 'e1',
      side: 'buy', order_type: 'limit', role: 'entry', symbol: 'BTCUSDT',
      price: preis, quantity: menge, status: 'filled', broker: 'attrappe',
      broker_order_id: 'boerse-vorher-1',
    });
    store.updatePlanOrder('order-e1', { filled_quantity: menge, avg_fill_price: preis });
  }

  /** Ein noch offenes Kauf-Limit an der Boerse. */
  function limitOffen() {
    store.insertPlanOrder({
      id: 'order-e2', trade_plan_id: 'plan-1', entry_order_id: 'e2',
      side: 'buy', order_type: 'limit', role: 'entry', symbol: 'BTCUSDT',
      price: 49_000, quantity: 0.1, status: 'placed', broker: 'attrappe',
      broker_order_id: 'boerse-vorher-2',
    });
  }

  it('schliesst die offene Position zu Markt und nimmt offene Orders zurueck', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);
    einstiegGefuellt();
    limitOffen();
    monitor.registerPlan(plan());

    const ergebnis = await monitor.beendePlan('plan-1');

    // Genau eine Market-Order in der Gegenrichtung, reduceOnly.
    const marktOrders = broker.platziert.filter(o => o.type === 'market');
    expect(marktOrders).toHaveLength(1);
    expect(marktOrders[0]!.side).toBe('sell');
    expect(marktOrders[0]!.quantity).toBeCloseTo(0.1, 10);
    expect(marktOrders[0]!.reduceOnly).toBe(true);

    // Das offene Kauf-Limit ist zurueckgenommen.
    expect(broker.storniert).toContain('boerse-vorher-2');
    expect(ergebnis.stornierteOrders).toBe(1);
    expect(ergebnis.geschlosseneMenge).toBeCloseTo(0.1, 10);

    // War im Markt → abgeschlossen, nicht abgebrochen.
    expect(ergebnis.status).toBe('completed');
    expect(monitor.getAllStates()).toHaveLength(0);
  });

  it('bricht ab, ohne etwas zu schliessen, wenn nie eingestiegen wurde', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);
    limitOffen();
    monitor.registerPlan(plan());

    const ergebnis = await monitor.beendePlan('plan-1');

    expect(broker.platziert.filter(o => o.type === 'market')).toHaveLength(0);
    expect(ergebnis.geschlosseneMenge).toBe(0);
    expect(ergebnis.status).toBe('cancelled');
    expect(broker.storniert).toContain('boerse-vorher-2');
  });

  // ============================================================
  // Der Fall, auf den es ankommt
  // ============================================================

  it('laesst den Plan unter Aufsicht, wenn die Position sich nicht schliessen laesst', async () => {
    const broker = brokerAttrappe({ marketFehler: true });
    const monitor = baue(broker);
    einstiegGefuellt();
    limitOffen();
    monitor.registerPlan(plan());

    await expect(monitor.beendePlan('plan-1')).rejects.toThrow();

    // Der Plan bleibt angemeldet — sonst liefe die Position
    // unbeaufsichtigt weiter.
    expect(monitor.getState('plan-1')).toBeDefined();
    expect(monitor.getAllStates()).toHaveLength(1);
    expect(store.getMonitor('plan-1')).toBeDefined();

    // Und der Stop-Loss liegt noch: Es wurde nichts storniert, bevor das
    // Schliessen scheiterte.
    expect(broker.storniert).toHaveLength(0);
  });

  it('vermerkt eine misslungene Stornierung nicht als storniert', async () => {
    const broker = brokerAttrappe({ cancelFehler: true });
    const monitor = baue(broker);
    limitOffen();
    monitor.registerPlan(plan());

    const ergebnis = await monitor.beendePlan('plan-1');

    expect(ergebnis.stornierteOrders).toBe(0);
    // Die Order liegt weiter an der Boerse — das muss aus der Datenbank
    // hervorgehen, damit niemand sie fuer erledigt haelt.
    const order = store.getPlanOrder('order-e2');
    expect(order!.status).toBe('placed');
  });

  it('raeumt auch einen Plan auf, der gar nicht angemeldet war', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);
    limitOffen();
    // Bewusst kein registerPlan — etwa nach einem Neustart.

    const ergebnis = await monitor.beendePlan('plan-1');

    expect(ergebnis.status).toBe('cancelled');
    expect(broker.storniert).toContain('boerse-vorher-2');
  });

  it('haelt die Schliessung so fest, dass sie einen Neustart ueberlebt', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);
    einstiegGefuellt();
    monitor.registerPlan(plan());

    await monitor.beendePlan('plan-1');

    // Die Schliessung steht als gefuellte Order in der Datenbank. Ohne
    // filled_quantity saehe ein neu gestarteter Monitor die Position
    // wieder als offen — und handelte sie ein zweites Mal.
    const ergebnis = new ErgebnisService(store).fuerPlan('plan-1', 'long', 10, 50_000);
    expect(ergebnis.geschlossen).toBeCloseTo(0.1, 10);
    expect(ergebnis.offen).toBe(0);
  });

  // ============================================================
  // Ein Plan auf 'cancelled' — etwa durch ein Signal von aussen
  //
  // Hier lief der Bot in denselben Fehler, den `beendePlan()` laengst
  // vermeidet: Der Storno-Pfad in `processPlan` nahm nur die OFFENEN
  // ORDERS zurueck und liess die Position stehen. Unter diesen Orders
  // ist der Stop-Loss.
  //
  // Am 01.11.2026 stornierte TC-Synaptrix 42 Plaene auf einmal. Deren
  // Positionen blieben samt und sonders im Uebungskonto stehen — die
  // BNBUSDT-Position lief danach voellig ungesichert weiter, denn ihr
  // Stop war mit den Orders verschwunden.
  // ============================================================

  it('schliesst die Position auch, wenn der Plan ueber den Status storniert wird', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker) as unknown as MonitorIntern & {
      processPlan(state: unknown, preis: number): Promise<void>;
    };
    einstiegGefuellt();
    limitOffen();
    monitor.registerPlan(plan());

    // So kommt ein `cancel`-Signal an: nur der Status wandert.
    store.updateBotTradePlanStatus('plan-1', 'cancelled');
    const state = monitor.getState('plan-1') as unknown as { plan: { status: string } };
    state.plan.status = 'cancelled';

    await monitor.processPlan(state, 50_000);

    // Die Position ist zu — nicht nur die Orders.
    const marktOrders = broker.platziert.filter(o => o.type === 'market');
    expect(marktOrders).toHaveLength(1);
    expect(marktOrders[0]!.side).toBe('sell');
    expect(marktOrders[0]!.reduceOnly).toBe(true);
    expect(marktOrders[0]!.quantity).toBeCloseTo(0.1, 10);

    // Und das offene Kauf-Limit ist zurueckgenommen.
    expect(broker.storniert).toContain('boerse-vorher-2');

    const ergebnis = new ErgebnisService(store).fuerPlan('plan-1', 'long', 10, 50_000);
    expect(ergebnis.offen).toBe(0);
  });

  // Scheitert das Schliessen, bleiben die Orders liegen — und mit
  // ihnen der Stop. Lieber eine abgesicherte Position, die sich nicht
  // beenden laesst, als eine ungesicherte.
  it('nimmt keine Orders zurueck, wenn die Position sich nicht schliessen laesst', async () => {
    const broker = brokerAttrappe({ marketFehler: true });
    const monitor = baue(broker) as unknown as MonitorIntern & {
      processPlan(state: unknown, preis: number): Promise<void>;
    };
    einstiegGefuellt();
    limitOffen();
    monitor.registerPlan(plan());

    store.updateBotTradePlanStatus('plan-1', 'cancelled');
    const state = monitor.getState('plan-1') as unknown as { plan: { status: string } };
    state.plan.status = 'cancelled';

    await monitor.processPlan(state, 50_000);

    // Das Kauf-Limit liegt noch — und damit auch alles andere.
    expect(broker.storniert).not.toContain('boerse-vorher-2');
  });

  it('kommt ohne offene Position aus, ohne eine Market-Order zu schicken', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker) as unknown as MonitorIntern & {
      processPlan(state: unknown, preis: number): Promise<void>;
    };
    limitOffen();                 // nur ein Limit, nichts gefuellt
    monitor.registerPlan(plan());

    store.updateBotTradePlanStatus('plan-1', 'cancelled');
    const state = monitor.getState('plan-1') as unknown as { plan: { status: string } };
    state.plan.status = 'cancelled';

    await monitor.processPlan(state, 50_000);

    expect(broker.platziert.filter(o => o.type === 'market')).toHaveLength(0);
    expect(broker.storniert).toContain('boerse-vorher-2');
  });
});

// ============================================================
// Beenden, wenn der Plan gar nicht mehr ueberwacht wird
//
// Der Fall aus dem Uebungsbetrieb vom 25.10.: Ein falsch verbuchter
// Take-Profit hatte den BNBUSDT-Plan als abgeschlossen ausgewiesen. Der
// Monitor fuehrte ihn nicht mehr — 7,68 BNB standen trotzdem im Markt.
//
// Wer so einen Plan beendete, bekam "erfolgreich beendet" zur Antwort,
// waehrend die Position unveraendert stehen blieb. Das Beenden raeumte
// nur die Orders auf und sah die Position gar nicht an.
// ============================================================

describe('TradePlanMonitor — beenden ohne laufende Ueberwachung', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'beenden-ohne-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));

    const p = plan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]',
      executed_orders: '[]',
      execution_mode: 'all_limit',
      entry_zones: null,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  const baue = (broker: ReturnType<typeof brokerAttrappe>) =>
    new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false,
      defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

  /** Gefuellter Einstieg in der Datenbank — ohne dass ein Monitor laeuft. */
  function offenePositionInDerDatenbank(menge = 7.67954389, preis = 737.81) {
    store.insertPlanOrder({
      id: 'order-e1', trade_plan_id: 'plan-1', entry_order_id: 'e1',
      side: 'buy', order_type: 'limit', role: 'entry', symbol: 'BTCUSDT',
      price: preis, quantity: menge, status: 'filled', broker: 'attrappe',
      broker_order_id: 'boerse-alt-1',
    });
    store.updatePlanOrder('order-e1', { filled_quantity: menge, avg_fill_price: preis });
  }

  it('schliesst die Position auch dann, wenn kein Monitor sie fuehrt', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);
    offenePositionInDerDatenbank();

    // Bewusst KEIN registerPlan — der Plan ist dem Monitor unbekannt.
    const ergebnis = await monitor.beendePlan('plan-1');

    const marktOrders = broker.platziert.filter(o => o.type === 'market');
    expect(marktOrders).toHaveLength(1);
    expect(marktOrders[0]!.side).toBe('sell');
    expect(marktOrders[0]!.quantity).toBeCloseTo(7.67954389, 8);
    expect(marktOrders[0]!.reduceOnly).toBe(true);

    expect(ergebnis.geschlosseneMenge).toBeCloseTo(7.67954389, 8);
  });

  it('meldet den Plan als abgeschlossen, nicht als abgebrochen', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);
    offenePositionInDerDatenbank();

    const ergebnis = await monitor.beendePlan('plan-1');

    // Er war im Markt — das ist der Unterschied zwischen einem Plan,
    // der abgebrochen wurde, und einem, der zu Ende gehandelt ist.
    expect(ergebnis.status).toBe('completed');
  });

  it('meldet keine geschlossene Menge, wenn nie eingestiegen wurde', async () => {
    const broker = brokerAttrappe();
    const monitor = baue(broker);

    // Nur ein offenes Limit, nie gefuellt.
    store.insertPlanOrder({
      id: 'order-e2', trade_plan_id: 'plan-1', entry_order_id: 'e2',
      side: 'buy', order_type: 'limit', role: 'entry', symbol: 'BTCUSDT',
      price: 49_000, quantity: 0.1, status: 'placed', broker: 'attrappe',
      broker_order_id: 'boerse-alt-2',
    });

    const ergebnis = await monitor.beendePlan('plan-1');

    expect(broker.platziert.filter(o => o.type === 'market')).toHaveLength(0);
    expect(ergebnis.geschlosseneMenge).toBe(0);
    expect(ergebnis.status).toBe('cancelled');
    expect(broker.storniert).toContain('boerse-alt-2');
  });

  it('meldet keine geschlossene Menge, wenn das Schliessen abgewiesen wird', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true });
    const monitor = baue(broker);
    offenePositionInDerDatenbank();

    const ergebnis = await monitor.beendePlan('plan-1');

    // Die schlechteste aller Auskuenfte waere "geschlossen" fuer eine
    // Menge, die im Markt geblieben ist.
    expect(ergebnis.geschlosseneMenge).toBe(0);
  });
});

// ============================================================
// Plan und Monitor laufen auseinander
//
// Der Monitor setzte beim Abschliessen lange nur seinen eigenen
// Zustand auf 'completed'; der Plan in `bot_trade_plans` blieb auf
// 'active'. Die Uebersichten fragen den Plan — ein durch Stop-Loss
// beendeter Trade stand deshalb fuer immer unter den aktiven, mit
// offener Position 0 und ohne dass noch etwas geschah.
//
// So erging es dem HYPEUSDT-Short vom 25.10.: alle vier Einstiege
// gefuellt, durch den Stop glattgestellt, und trotzdem Tag fuer Tag
// in der Liste der laufenden Trades.
// ============================================================

describe('TradePlanMonitor — Widersprueche beim Hochfahren', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'widerspruch-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));

    const p = plan();
    store.upsertBotTradePlan({
      ...p,
      entry_orders: JSON.stringify(p.entry_orders),
      take_profits: JSON.stringify(p.take_profits),
      activation_conditions: '[]',
      executed_orders: '[]',
      execution_mode: 'all_limit',
      entry_zones: null,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Ein Monitor-Datensatz mit einem bestimmten Status. */
  function monitorMit(status: string, offen: number): void {
    store.upsertMonitor({
      trade_plan_id: 'plan-1', status, activation_step: 0,
      tp_state: '[]', sl_current: 47_000, sl_type_current: 'fixed',
      trailing_active: false, trailing_best_price: null, trailing_size_pct: null,
      remaining_size: offen, last_price: 50_000, error_count: 0,
    });
  }

  /** Einstieg gefuellt, durch Stop wieder geschlossen. */
  function durchgehandelt(): void {
    store.insertPlanOrder({
      id: 'w-e', trade_plan_id: 'plan-1', side: 'buy', order_type: 'limit',
      role: 'entry', symbol: 'BTCUSDT', price: 50_000, quantity: 0.1,
      status: 'filled', broker: 'attrappe',
    });
    store.updatePlanOrder('w-e', { filled_quantity: 0.1, avg_fill_price: 50_000 });
    store.insertPlanOrder({
      id: 'w-sl', trade_plan_id: 'plan-1', side: 'sell', order_type: 'market',
      role: 'stop_loss', symbol: 'BTCUSDT', price: 47_000, quantity: 0.1,
      status: 'filled', broker: 'attrappe',
    });
    store.updatePlanOrder('w-sl', { filled_quantity: 0.1, avg_fill_price: 47_000 });
  }

  it('findet den Widerspruch: Monitor fertig, Plan aktiv', () => {
    monitorMit('completed', 0);

    const offen = store.getAbgeschlosseneMitAktivemPlan();
    expect(offen).toHaveLength(1);
    expect(offen[0]!.trade_plan_id).toBe('plan-1');
  });

  it('zieht den Plan beim Hochfahren nach', () => {
    durchgehandelt();
    monitorMit('completed', 0);

    const broker = brokerAttrappe();
    const monitor = baueMitStart(broker);
    monitor.stop();

    // Er war im Markt und ist es nicht mehr: abgeschlossen.
    expect(store.getBotTradePlan('plan-1')!.status).toBe('completed');
  });

  it('nennt einen nie gehandelten Plan abgebrochen, nicht abgeschlossen', () => {
    monitorMit('cancelled', 0);

    const broker = brokerAttrappe();
    const monitor = baueMitStart(broker);
    monitor.stop();

    expect(store.getBotTradePlan('plan-1')!.status).toBe('cancelled');
  });

  it('laesst einen Plan mit offener Position in Ruhe', () => {
    // Einstieg gefuellt, nie geschlossen — trotz 'completed' im Monitor.
    store.insertPlanOrder({
      id: 'w-e2', trade_plan_id: 'plan-1', side: 'buy', order_type: 'limit',
      role: 'entry', symbol: 'BTCUSDT', price: 50_000, quantity: 0.1,
      status: 'filled', broker: 'attrappe',
    });
    store.updatePlanOrder('w-e2', { filled_quantity: 0.1, avg_fill_price: 50_000 });
    monitorMit('completed', 0);

    const broker = brokerAttrappe();
    const monitor = baueMitStart(broker);
    monitor.stop();

    // Ihn abzuschliessen hiesse, eine offene Position aus der Aufsicht
    // zu nehmen — der schlimmere der beiden Fehler.
    expect(store.getBotTradePlan('plan-1')!.status).toBe('active');
  });

  it('ruehrt laufende Plaene nicht an', () => {
    monitorMit('monitoring', 0.1);

    const broker = brokerAttrappe();
    const monitor = baueMitStart(broker);
    monitor.stop();

    expect(store.getBotTradePlan('plan-1')!.status).toBe('active');
  });

  /**
   * Baut den Monitor und faehrt ihn hoch.
   *
   * Der Abgleich laeuft beim Laden der Zustaende, nicht im Konstruktor
   * — er braucht deshalb ein `start()`.
   */
  function baueMitStart(broker: ReturnType<typeof brokerAttrappe>) {
    const m = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false,
      defaultExchange: 'paper',
    }) as unknown as MonitorIntern;
    m.start();
    return m;
  }
});
