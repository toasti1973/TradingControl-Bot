// ============================================================
// Worauf sich ein Take-Profit-Anteil bezieht
//
// TC führt in der Chart-Planung einen Wahlschalter ein: 25 % der
// URSPRÜNGLICHEN Position oder 25 % der RESTPOSITION. Der
// Unterschied wächst mit jeder Stufe.
//
// Vier Ziele zu je 25 % auf 100 Einheiten:
//
//        eingestiegen     rest
//   TP1       25          25
//   TP2       25          18,75
//   TP3       25          14,06
//   TP4       25          10,55
//   bleibt     0          31,64
//
// Dazu drei Felder, die der Bot bisher gar nicht las:
// `size` (feste Menge), `trigger` (Indikator je Ziel) und
// `trailing_stop_activation` (Schwelle, ab der das Trailing läuft).
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

const still = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
} as unknown as Logger;

function boerse() {
  const platziert: OrderParams[] = [];
  const liegend = new Map<string, OrderParams>();
  let nummer = 0;
  let kurs = 100;

  const broker: BrokerAdapter = {
    name: 'attrappe',
    connect: async () => {}, disconnect: async () => {},
    getPrice: async () => kurs,
    setLeverage: async () => {},
    placeOrder: async (p: OrderParams): Promise<OrderResult> => {
      platziert.push(p);
      const id = `b-${++nummer}`;
      if (p.type !== 'market') liegend.set(id, p);
      return {
        orderId: id, clientOrderId: p.clientOrderId ?? '', symbol: p.symbol,
        side: p.side, type: p.type, quantity: p.quantity, price: p.price ?? 0,
        status: p.type === 'market' ? 'filled' : 'new',
        filledQuantity: p.type === 'market' ? p.quantity : 0,
        avgFillPrice: p.price ?? kurs, timestamp: Date.now(),
      };
    },
    cancelOrder: async (_s, id) => { liegend.delete(id); },
    getOrder: async (_s, id): Promise<OrderResult | null> => {
      const p = liegend.get(id);
      if (!p) return null;
      return {
        orderId: id, clientOrderId: p.clientOrderId ?? '', symbol: p.symbol,
        side: p.side, type: p.type, quantity: p.quantity, price: p.price ?? 0,
        status: 'new', filledQuantity: 0, avgFillPrice: 0, timestamp: Date.now(),
      };
    },
    getPosition: async () => null,
  };

  return {
    platziert, broker,
    setKurs: (k: number) => { kurs = k; },
    registry: { get: async () => broker, uebt: () => true } as unknown as BrokerRegistry,
  };
}

interface Intern {
  registerPlan(p: unknown): void;
  processPlan(s: unknown, preis: number): Promise<void>;
  tpMengen(s: unknown, offen: number): number[];
  updateTrailingStop(s: unknown, preis: number): void;
  getState(id: string): {
    tpState: Array<{ triggered: boolean }>;
    slCurrent: number | null;
    trailingBestPrice: number | null;
    plan: Record<string, unknown>;
  } | undefined;
}

describe('tpMengen — Bezugsgröße der Anteile', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'tpbezug-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Plan mit vier Zielen zu je 25 %, eingestiegen 100. */
  function baue(tps: Array<Record<string, unknown>>, eingestiegen = 100) {
    const b = boerse();
    const monitor = new TradePlanMonitor(b.registry, store, still, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as Intern;

    const plan = {
      id: 'p1', source: 'signal' as const, exchange: 'paper', symbol: 'XUSDT',
      market_type: 'futures' as const, direction: 'long' as const, leverage: 10,
      total_size: 100, entry_strategy: 'single' as const,
      entry_orders: [{ id: 'e1', price: 100, size: 100, order_type: 'limit' as const, status: 'pending' as const }],
      entry_zones: null, take_profits: tps,
      stop_loss_price: 90, stop_loss_type: 'fixed' as const,
      trailing_stop_pct: null, trailing_stop_activation: null, trailing_stop_size_pct: null,
      activation_conditions: [], status: 'active' as const, bot_enabled: true,
      executed_orders: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(tps),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });

    if (eingestiegen > 0) {
      store.insertPlanOrder({
        id: 'o-e1', trade_plan_id: 'p1', side: 'buy', order_type: 'limit', role: 'entry',
        symbol: 'XUSDT', price: 100, quantity: eingestiegen, status: 'filled', broker: 'paper',
      });
      store.updatePlanOrder('o-e1', { filled_quantity: eingestiegen, avg_fill_price: 100 });
    }

    monitor.registerPlan(plan);
    return { monitor, state: monitor.getState('p1')!, b };
  }

  const vier = (basis?: string) => [110, 120, 130, 140].map(price => ({
    price, percentage: 25, order_type: 'limit', status: 'pending',
    ...(basis ? { size_basis: basis } : {}),
  }));

  it('rechnet ohne Angabe auf die eingestiegene Menge — wie bisher', () => {
    const { monitor, state } = baue(vier());
    expect(monitor.tpMengen(state, 100)).toEqual([25, 25, 25, 25]);
  });

  it('rechnet mit size_basis "eingestiegen" genauso', () => {
    const { monitor, state } = baue(vier('eingestiegen'));
    expect(monitor.tpMengen(state, 100)).toEqual([25, 25, 25, 25]);
  });

  it('rechnet mit size_basis "rest" absteigend', () => {
    const { monitor, state } = baue(vier('rest'));
    const m = monitor.tpMengen(state, 100);

    expect(m[0]).toBeCloseTo(25, 6);       // 25 % von 100
    expect(m[1]).toBeCloseTo(18.75, 6);    // 25 % von 75
    expect(m[2]).toBeCloseTo(14.0625, 6);  // 25 % von 56,25
    expect(m[3]).toBeCloseTo(10.546875, 6);

    // Mit "rest" bleibt immer etwas liegen — das ist der Zweck.
    const summe = m.reduce((s, x) => s + x, 0);
    expect(summe).toBeLessThan(100);
    expect(100 - summe).toBeCloseTo(31.640625, 4);
  });

  it('schließt die Position mit "eingestiegen" vollständig', () => {
    const { monitor, state } = baue(vier());
    const summe = monitor.tpMengen(state, 100).reduce((s, x) => s + x, 0);
    expect(summe).toBeCloseTo(100, 6);
  });

  // Der Kern des aktiven Positionsmanagements: Die Anteile hängen an
  // der tatsächlich eingestiegenen Menge, nicht an der geplanten.
  it('wächst mit jedem weiteren Einstieg', () => {
    const { monitor, state } = baue(vier(), 40);
    expect(monitor.tpMengen(state, 40)).toEqual([10, 10, 10, 10]);

    // Ein zweiter Einstieg kommt dazu.
    store.insertPlanOrder({
      id: 'o-e2', trade_plan_id: 'p1', side: 'buy', order_type: 'limit', role: 'entry',
      symbol: 'XUSDT', price: 98, quantity: 60, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('o-e2', { filled_quantity: 60, avg_fill_price: 98 });

    expect(monitor.tpMengen(state, 100)).toEqual([25, 25, 25, 25]);
  });

  it('nimmt eine feste Menge vor dem Prozentsatz', () => {
    // `size` wurde bisher gar nicht gelesen — ein Plan mit absoluten
    // Zielmengen wurde nach Prozenten gehandelt.
    const { monitor, state } = baue([
      { price: 110, size: 30, percentage: 25, order_type: 'limit', status: 'pending' },
      { price: 120, percentage: 25, order_type: 'limit', status: 'pending' },
    ]);

    const m = monitor.tpMengen(state, 100);
    expect(m[0]).toBe(30);
    expect(m[1]).toBe(25);
  });

  it('deckelt die Summe auf die offene Menge', () => {
    const { monitor, state } = baue([
      { price: 110, percentage: 60, order_type: 'limit', status: 'pending' },
      { price: 120, percentage: 60, order_type: 'limit', status: 'pending' },
    ]);

    const m = monitor.tpMengen(state, 100);
    // Das zweite Ziel bekommt nur noch, was übrig ist.
    expect(m[0]).toBe(60);
    expect(m[1]).toBe(40);
  });

  it('überspringt bereits erreichte Ziele, rechnet den Rest aber weiter', () => {
    const { monitor, state } = baue(vier('rest'));
    state.tpState[0]!.triggered = true;

    const m = monitor.tpMengen(state, 75);
    expect(m[0]).toBe(0);
    // TP2 rechnet auf dem Stand NACH TP1 — nicht auf den vollen 100.
    expect(m[1]).toBeCloseTo(18.75, 6);
  });
});

// ============================================================
// Die Trailing-Schwelle
// ============================================================

describe('Trailing-Stop — Aktivierungsschwelle', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'tschwelle-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function baue(richtung: 'long' | 'short', schwelle: number | null) {
    const b = boerse();
    const monitor = new TradePlanMonitor(b.registry, store, still, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as Intern;

    const plan = {
      id: 'pt', source: 'signal' as const, exchange: 'paper', symbol: 'XUSDT',
      market_type: 'futures' as const, direction: richtung, leverage: 10,
      total_size: 10, entry_strategy: 'single' as const,
      entry_orders: [{ id: 'e1', price: 100, size: 10, order_type: 'limit' as const, status: 'pending' as const }],
      entry_zones: null, take_profits: [],
      stop_loss_price: richtung === 'long' ? 90 : 110,
      stop_loss_type: 'trailing' as const,
      trailing_stop_pct: 2, trailing_stop_activation: schwelle, trailing_stop_size_pct: null,
      activation_conditions: [], status: 'active' as const, bot_enabled: true,
      executed_orders: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    store.upsertBotTradePlan({
      ...plan, entry_orders: JSON.stringify(plan.entry_orders), take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    return { monitor, state: monitor.getState('pt')! };
  }

  it('wartet beim Long, bis die Schwelle erreicht ist', () => {
    const { monitor, state } = baue('long', 110);
    const vorher = state.slCurrent;

    // Darunter: Der Stop bleibt, wo er war.
    monitor.updateTrailingStop(state, 105);
    expect(state.trailingBestPrice).toBeNull();
    expect(state.slCurrent).toBe(vorher);

    // Ab der Schwelle zieht er mit.
    monitor.updateTrailingStop(state, 110);
    expect(state.trailingBestPrice).toBe(110);
    expect(state.slCurrent).toBeCloseTo(110 * 0.98, 6);
  });

  it('wartet beim Short, bis der Kurs darunter fällt', () => {
    const { monitor, state } = baue('short', 90);

    monitor.updateTrailingStop(state, 95);
    expect(state.trailingBestPrice).toBeNull();

    monitor.updateTrailingStop(state, 90);
    expect(state.trailingBestPrice).toBe(90);
  });

  it('läuft ohne Schwelle sofort — wie bisher', () => {
    const { monitor, state } = baue('long', null);
    monitor.updateTrailingStop(state, 101);
    expect(state.trailingBestPrice).toBe(101);
  });

  it('prüft die Schwelle nur einmal, dann läuft es weiter', () => {
    const { monitor, state } = baue('long', 110);
    monitor.updateTrailingStop(state, 112);
    expect(state.trailingBestPrice).toBe(112);

    // Fällt der Kurs wieder unter die Schwelle, bleibt das Trailing
    // aktiv — es ist eine Startbedingung, kein Schalter.
    monitor.updateTrailingStop(state, 105);
    expect(state.trailingBestPrice).toBe(112);
  });
});

// ============================================================
// Der Trailing-Stop schließt ALLES
//
// Er reizt den letzten Rest bis zum Ende aus — und wenn er greift,
// geht die gesamte verbliebene Position.
//
// `trailing_stop_size_pct` aus dem Journal (Migration 074) wird
// deshalb bewusst nicht ausgewertet: Ein Stop, der nur einen Teil
// schließt, ließe den Rest ohne Absicherung stehen. Das ist das
// Gegenteil dessen, wofür ein Stop da ist.
//
// Damit das kein stilles Übergehen bleibt, meldet der Bot es beim
// Anmelden des Plans.
// ============================================================

describe('Trailing-Stop — schließt immer die ganze Position', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'tsvoll-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function baue(teilTrailing: number | null, meldungen?: string[]) {
    const b = boerse();
    const logger = meldungen
      ? { ...still, warn: (_o: unknown, m?: string) => { meldungen.push(String(m ?? '')); } }
      : still;

    const monitor = new TradePlanMonitor(b.registry, store, logger as Logger, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as Intern;

    const plan = {
      id: 'pv', source: 'signal' as const, exchange: 'paper', symbol: 'XUSDT',
      market_type: 'futures' as const, direction: 'long' as const, leverage: 10,
      total_size: 100, entry_strategy: 'single' as const,
      entry_orders: [{ id: 'e1', price: 100, size: 100, order_type: 'limit' as const, status: 'pending' as const }],
      entry_zones: null, take_profits: [],
      stop_loss_price: 90, stop_loss_type: 'trailing' as const,
      trailing_stop_pct: 2, trailing_stop_activation: null,
      trailing_stop_size_pct: teilTrailing,
      activation_conditions: [], status: 'active' as const, bot_enabled: true,
      executed_orders: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    store.upsertBotTradePlan({
      ...plan, entry_orders: JSON.stringify(plan.entry_orders), take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });

    // Eine offene Position von 100.
    //
    // Eindeutige Id je Aufruf: `baue()` wird in einem Test mehrfach
    // gerufen, und seit `upsertBotTradePlan` die Orders nicht mehr
    // loescht (kein INSERT OR REPLACE), kollidierte eine feste Id.
    const orderId = 'o-e1-' + Math.random().toString(36).slice(2);
    store.insertPlanOrder({
      id: orderId, trade_plan_id: 'pv', side: 'buy', order_type: 'limit', role: 'entry',
      symbol: 'XUSDT', price: 100, quantity: 100, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(orderId, { filled_quantity: 100, avg_fill_price: 100 });

    monitor.registerPlan(plan);
    return { monitor, state: monitor.getState('pv')!, b };
  }

  it('legt die Stop-Order über die GANZE offene Position', async () => {
    const { monitor, state, b } = baue(null);
    await monitor.processPlan(state, 100);

    const stops = b.platziert.filter(o => o.type === 'stop');
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[stops.length - 1]!.quantity).toBeCloseTo(100, 6);
    expect(stops[stops.length - 1]!.reduceOnly).toBe(true);
  });

  it('schließt auch mit trailing_stop_size_pct die ganze Position', async () => {
    // Der Plan will 50 % — der Bot nimmt trotzdem alles.
    const { monitor, state, b } = baue(50);
    await monitor.processPlan(state, 100);

    const stops = b.platziert.filter(o => o.type === 'stop');
    expect(stops[stops.length - 1]!.quantity).toBeCloseTo(100, 6);
    expect(stops[stops.length - 1]!.quantity).not.toBeCloseTo(50, 6);
  });

  it('meldet ein vorgesehenes Teil-Trailing, statt es stillschweigend zu übergehen', () => {
    const meldungen: string[] = [];
    baue(50, meldungen);

    expect(meldungen.join(' ')).toMatch(/Teil-Trailing/i);
    expect(meldungen.join(' ')).toMatch(/GANZE Position/i);
  });

  it('schweigt, wenn kein Teil-Trailing vorgesehen ist', () => {
    for (const wert of [null, 0, 100]) {
      const meldungen: string[] = [];
      baue(wert as number | null, meldungen);
      expect(meldungen.join(' '), `Wert ${wert}`).not.toMatch(/Teil-Trailing/i);
    }
  });

  it('zieht den Stop nach und behält dabei die volle Menge', async () => {
    const { monitor, state, b } = baue(null);
    await monitor.processPlan(state, 100);

    // Der Kurs läuft. Der Stop im Zustand zieht sofort mit …
    await monitor.processPlan(state, 120);
    expect(state.slCurrent).toBeCloseTo(120 * 0.98, 4);

    // … die ORDER erst im nächsten Durchlauf: `synchronisiereSlOrder`
    // läuft in Schritt 4, `updateTrailingStop` in Schritt 5. Bei einem
    // Poll-Takt von zwei Sekunden ist das unkritisch — festgehalten
    // wird es, damit niemand die Verzögerung für einen Fehler hält.
    await monitor.processPlan(state, 120);

    const stops = b.platziert.filter(o => o.type === 'stop');
    const letzter = stops[stops.length - 1]!;
    expect(letzter.quantity).toBeCloseTo(100, 6);
    expect(letzter.stopPrice).toBeCloseTo(120 * 0.98, 4);
  });
});

// ============================================================
// Erste Order zu Markt, Rest als Limit
//
// `execution_mode: 'first_market_rest_limit'` soll die Position
// SOFORT eröffnen — darum wählt man es.
//
// Hier stand eine Preisprüfung: Die Market-Order ging erst hinaus,
// wenn der Kurs den geplanten Einstieg berührte. Damit war sie ein
// schlechteres Limit — dieselbe Wartezeit, aber Taker-Gebühr statt
// Maker und ohne die Sicherheit einer liegenden Order.
//
// Eine Schranke bleibt: Steht der Kurs deutlich schlechter als
// geplant, eröffnete ein spät eintreffendes Signal eine Position,
// zu der der geplante Stop nicht mehr passt.
// ============================================================

describe('execution_mode — erste Order zu Markt', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'exmode-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function baue(modus: string, richtung: 'long' | 'short' = 'long', ersterPreis = 99) {
    const b = boerse();
    const monitor = new TradePlanMonitor(b.registry, store, still, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as Intern;

    const plan = {
      id: 'pm', source: 'signal' as const, exchange: 'paper', symbol: 'XUSDT',
      market_type: 'futures' as const, direction: richtung, leverage: 10,
      total_size: 20, entry_strategy: 'equal' as const,
      entry_orders: [
        { id: 'e1', price: ersterPreis, size: 10, order_type: 'limit' as const, status: 'pending' as const },
        { id: 'e2', price: richtung === 'long' ? 95 : 105, size: 10, order_type: 'limit' as const, status: 'pending' as const },
      ],
      entry_zones: null, take_profits: [],
      stop_loss_price: richtung === 'long' ? 90 : 110, stop_loss_type: 'fixed' as const,
      trailing_stop_pct: null, trailing_stop_activation: null, trailing_stop_size_pct: null,
      activation_conditions: [], status: 'active' as const, bot_enabled: true,
      executed_orders: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    store.upsertBotTradePlan({
      ...plan, entry_orders: JSON.stringify(plan.entry_orders), take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: modus, entry_zones: null,
    });
    monitor.registerPlan({ ...plan, execution_mode: modus });
    return { monitor, state: monitor.getState('pm')!, b };
  }

  it('eröffnet sofort zu Markt, auch wenn der Kurs den Einstieg nicht berührt', async () => {
    // Kurs 100, geplanter Einstieg 99 — ein Limit würde warten.
    const { monitor, state, b } = baue('first_market_rest_limit');
    await monitor.processPlan(state, 100);

    const markt = b.platziert.filter(o => o.type === 'market');
    expect(markt).toHaveLength(1);
    expect(markt[0]!.side).toBe('buy');
    expect(markt[0]!.quantity).toBe(10);
  });

  it('legt die übrigen Einstiege als Limit ins Orderbuch', async () => {
    const { monitor, state, b } = baue('first_market_rest_limit');
    await monitor.processPlan(state, 100);

    const limits = b.platziert.filter(o => o.type === 'limit' && o.side === 'buy');
    expect(limits).toHaveLength(1);
    expect(limits[0]!.price).toBe(95);
  });

  it('legt bei all_limit auch den ersten als Limit', async () => {
    const { monitor, state, b } = baue('all_limit');
    await monitor.processPlan(state, 100);

    expect(b.platziert.filter(o => o.type === 'market')).toHaveLength(0);
    expect(b.platziert.filter(o => o.type === 'limit' && o.side === 'buy')).toHaveLength(2);
  });

  it('nimmt einen günstigeren Kurs ohne Zögern', async () => {
    // Kurs 97 liegt UNTER dem geplanten Einstieg 99 — ein Geschenk.
    const { monitor, state, b } = baue('first_market_rest_limit');
    await monitor.processPlan(state, 97);

    expect(b.platziert.filter(o => o.type === 'market')).toHaveLength(1);
  });

  it('lehnt ab, wenn der Kurs dem Plan davongelaufen ist', async () => {
    // Einstieg 99, Stop 90 — 9 Punkte Risiko. Bei Kurs 105 waeren es
    // 15 Punkte, also zwei Drittel mehr als geplant.
    const { monitor, state, b } = baue('first_market_rest_limit');
    await monitor.processPlan(state, 105);

    expect(b.platziert.filter(o => o.type === 'market')).toHaveLength(0);
  });

  it('greift beim Short in die andere Richtung', async () => {
    // Short mit geplantem Einstieg 101, Kurs 102 = günstiger.
    const guenstig = baue('first_market_rest_limit', 'short', 101);
    await guenstig.monitor.processPlan(guenstig.state, 102);
    expect(guenstig.b.platziert.filter(o => o.type === 'market')).toHaveLength(1);

    store.close();
    verzeichnis = mkdtempSync(join(tmpdir(), 'exmode2-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));

    // Short: Einstieg 101, Stop 110 — 9 Punkte. Kurs 95 ergaebe 15.
    const schlecht = baue('first_market_rest_limit', 'short', 101);
    await schlecht.monitor.processPlan(schlecht.state, 95);
    expect(schlecht.b.platziert.filter(o => o.type === 'market')).toHaveLength(0);
  });

  it('macht nur die ERSTE Order zu Markt', async () => {
    const { monitor, state, b } = baue('first_market_rest_limit');
    await monitor.processPlan(state, 100);
    await monitor.processPlan(state, 100);

    // Auch nach mehreren Durchläufen bleibt es bei einer Market-Order.
    expect(b.platziert.filter(o => o.type === 'market')).toHaveLength(1);
  });
});
