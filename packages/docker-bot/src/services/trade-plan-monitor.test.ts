// ============================================================
// Kein Nachkauf nach dem ersten Take-Profit
//
// Die Regel kostet im Fehlerfall echtes Geld: Bleibt ein Kauf-Limit
// liegen, kann es Stunden nach der Teilrealisierung zuschlagen — in
// eine Position hinein, die gerade abgebaut wird, und mit einem
// Stop-Loss, der fuer einen anderen Einstieg bemessen war.
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
 * Broker-Attrappe, die aufzeichnet, was bei ihr ankam.
 *
 * `cancelFehler` laesst das Zuruecknehmen scheitern — damit laesst sich
 * pruefen, ob der Nachlauf es erneut versucht.
 */
function brokerAttrappe(optionen: {
  preis?: number;
  cancelFehler?: boolean;
  /**
   * Sollen platzierte Limit-Orders beim naechsten Nachfragen als
   * gefuellt gelten?
   *
   * Voreingestellt ja — so verhaelt sich eine Boerse, bei der der Kurs
   * durch das Limit gelaufen ist. Wer den Fall "Order liegt noch"
   * pruefen will, schaltet es ab.
   */
  limitsFuellen?: boolean;
  /**
   * Weist Nur-Schliessen-Orders ab — wie eine Boerse, die zu dieser
   * Order keine passende Position kennt.
   *
   * Genau das geschah am 25.10. im Uebungsbetrieb: Der Broker hatte
   * seine Positionen beim Neustart verloren und wies Take-Profit 1 ab.
   */
  reduceOnlyAbweisen?: boolean;
} = {}) {
  const platziert: OrderParams[] = [];
  const storniert: string[] = [];
  const offeneLimits = new Map<string, OrderParams>();
  /** Einmal gefuellt bleibt gefuellt — eine Boerse nimmt nichts zurueck. */
  const gefuellteLimits = new Set<string>();
  let laufendeNummer = 0;
  let kurs = optionen.preis ?? 50_000;

  const broker: BrokerAdapter = {
    name: 'attrappe',
    connect: async () => {},
    disconnect: async () => {},
    getPrice: async () => kurs,
    setLeverage: async () => {},
    placeOrder: async (p: OrderParams): Promise<OrderResult> => {
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

      // Limit-Orders bleiben liegen, Market-Orders fuellen sofort —
      // wie an einer echten Boerse.
      if (p.type !== 'market') offeneLimits.set(id, p);

      return {
        orderId: id,
        clientOrderId: p.clientOrderId ?? '',
        symbol: p.symbol,
        side: p.side,
        type: p.type,
        quantity: p.quantity,
        price: p.price ?? 0,
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
    // Der Monitor fragt hier nach, ob ein Limit inzwischen gefuellt ist.
    getOrder: async (_symbol: string, orderId: string): Promise<OrderResult | null> => {
      const p = offeneLimits.get(orderId);
      if (!p) return null;

      // Gefuellt wird, was der Kurs erreicht hat — wie an einer Boerse.
      //
      // `limitsFuellen: false` steuert dabei nur die EINSTIEGE: Damit
      // lassen sich Teilfuellungen nachstellen (Entry 1 liegt im
      // Markt, Entry 2 und 3 noch nicht). Ausstiege erkennt man an
      // `reduceOnly`; sie fuellen immer nach Kurs, denn genau darum
      // werden sie im Voraus ins Orderbuch gelegt.
      var automatisch = p.reduceOnly === true || optionen.limitsFuellen !== false;
      if (automatisch && p.price != null && !gefuellteLimits.has(orderId)) {
        const erreicht = p.side === 'buy' ? kurs <= p.price : kurs >= p.price;
        if (erreicht) gefuellteLimits.add(orderId);
      }
      const gefuellt = gefuellteLimits.has(orderId);

      return {
        orderId,
        clientOrderId: p.clientOrderId ?? '',
        symbol: p.symbol,
        side: p.side,
        type: p.type,
        quantity: p.quantity,
        price: p.price ?? 0,
        status: gefuellt ? 'filled' : 'new',
        filledQuantity: gefuellt ? p.quantity : 0,
        avgFillPrice: p.price ?? kurs,
        timestamp: Date.now(),
      };
    },
    getPosition: async () => null,
  };

  return {
    platziert, storniert, broker,
    /** Kurs setzen, bevor processPlan mit demselben Wert gerufen wird. */
    setKurs: (k: number) => { kurs = k; },
    registry: { get: async () => broker } as unknown as BrokerRegistry,
  };
}

/** Long auf BTCUSDT mit drei gestaffelten Einstiegen und zwei TPs. */
function dreiEinstiegePlan() {
  return {
    id: 'plan-1',
    source: 'local' as const,
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

/**
 * Zugriff auf die inneren Teile des Monitors.
 *
 * `processPlan` ist privat und wird hier bewusst von aussen aufgerufen:
 * Der oeffentliche Weg fuehrt ueber einen Zeitgeber, und ein Test, der
 * Kursverlaeufe durchspielen will, braucht den Schritt einzeln. Ein
 * Schnittmengen-Typ mit der Klasse ginge nicht — TypeScript loest ihn zu
 * `never` auf, sobald ein Name auf beiden Seiten steht und auf einer
 * privat ist.
 */
/**
 * Setzt den Kurs der Attrappe und laesst den Monitor damit arbeiten.
 *
 * ZWEI Durchlaeufe, nicht einer: Im ersten legt der Monitor seine
 * Orders ins Orderbuch, im zweiten sieht er nach, ob sie gefuellt
 * wurden. Eine echte Boerse verhaelt sich genauso — zwischen dem
 * Legen einer Order und ihrer Fuellung liegt immer mindestens ein
 * Augenblick, und der Bot erfaehrt davon erst beim naechsten
 * Nachfragen.
 */
async function tick(
  broker: ReturnType<typeof brokerAttrappe>,
  monitor: MonitorIntern,
  state: unknown,
  preis: number,
): Promise<void> {
  broker.setKurs(preis);
  await monitor.processPlan(state, preis);
  await monitor.processPlan(state, preis);
}

interface MonitorIntern {
  start(): void;
  stop(): void;
  registerPlan(plan: unknown): void;
  updatePlan(plan: unknown): Promise<void>;
  processPlan(state: unknown, preis: number): Promise<void>;
  getState(id: string): {
    remainingSize: number;
    tpState: Array<{ triggered: boolean }>;
    triggeredEntries: Set<string>;
    einstiegeStorniert: boolean;
    status: string;
    slCurrent: number | null;
    errorCount: number;
  } | undefined;
}

describe('TradePlanMonitor — kein Nachkauf nach dem ersten Take-Profit', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'monitortest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
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

  /** Plan anlegen, Einstiege platzieren lassen, dann auf TP1 laufen. */
  async function bisTp1(broker: ReturnType<typeof brokerAttrappe>) {
    const monitor = baue(broker);
    const plan = dreiEinstiegePlan();

    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]',
      executed_orders: '[]',
      execution_mode: 'all_limit',
      entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    // Der Kurs faellt bis unter den tiefsten Einstieg: Alle drei Limits
    // gehen an die Boerse. Gefuellt wird davon nur das oberste — so
    // entsteht der Fall, um den es geht: eine offene Position UND zwei
    // Kauf-Limits, die noch im Markt liegen.
    await tick(broker, monitor, state, 48_400);

    const entries = store.getPlanOrders('plan-1').filter(o => o.role === 'entry');
    if (entries.length > 0) {
      store.updatePlanOrder(entries[0]!.id as string, {
        status: 'filled', filled_quantity: 0.1, avg_fill_price: 50_000,
      });
    }
    return { monitor, state };
  }

  it('platziert zunaechst alle drei Einstiege', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    await bisTp1(broker);

    const einstiege = broker.platziert.filter(o => o.side === 'buy');
    expect(einstiege).toHaveLength(3);
    expect(store.getPlanOrders('plan-1').filter(o => o.role === 'entry')).toHaveLength(3);
  });

  it('nimmt beim ersten Take-Profit alle offenen Kauf-Limits zurueck', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    expect(broker.storniert).toHaveLength(0);

    // Preis springt auf TP1
    await tick(broker, monitor, state, 52_100);

    expect(state.tpState[0]!.triggered).toBe(true);
    // Zurueckgenommen werden die beiden UNGEFUELLTEN Limits. Der erste
    // Einstieg ist gefuellt — der laesst sich nicht stornieren, er ist
    // die Position, die gerade abgebaut wird.
    expect(broker.storniert).toHaveLength(2);

    const einstiege = store.getPlanOrders('plan-1').filter(o => o.role === 'entry');
    expect(einstiege.filter(o => o.status === 'cancelled')).toHaveLength(2);
    expect(einstiege.filter(o => o.status === 'filled')).toHaveLength(1);
  });

  it('kauft nach dem Take-Profit nicht mehr nach, auch wenn der Preis zurueckfaellt', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    await tick(broker, monitor, state, 52_100);        // TP1
    const nachTp = broker.platziert.length;

    // Preis faellt wieder auf die Einstiegszone — hier wuerde ohne die
    // Regel nachgekauft.
    await tick(broker, monitor, state, 48_400);
    await tick(broker, monitor, state, 48_000);
    await tick(broker, monitor, state, 47_500);

    const neueKaeufe = broker.platziert.slice(nachTp).filter(o => o.side === 'buy');
    expect(neueKaeufe).toHaveLength(0);
  });

  it('kauft auch dann nicht nach, wenn ein Plan-Update neue Einstiege nachreicht', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);
    await tick(broker, monitor, state, 52_100);        // TP1
    const nachTp = broker.platziert.length;

    // Ein geaenderter Plan bringt einen zusaetzlichen Einstieg mit
    const geaendert = dreiEinstiegePlan();
    geaendert.entry_orders.push({
      id: 'e4-neu', price: 47_800, size: 0.1, order_type: 'limit', status: 'pending',
    });
    await monitor.updatePlan(geaendert);

    await tick(broker, monitor, monitor.getState('plan-1'), 47_700);

    const neueKaeufe = broker.platziert.slice(nachTp).filter(o => o.side === 'buy');
    expect(neueKaeufe).toHaveLength(0);
  });

  it('laesst stehen, was der Take-Profit NICHT geschlossen hat', async () => {
    // Die Korrektur vom 26.10. — und der gefaehrlichste Fehler, den
    // eine Gegenpruefung zutage foerderte:
    //
    // Hier stand frueher `remainingSize - entfallen - nieAbgeschickt`.
    // Das war eine doppelte Buchung aus der Zeit, als remainingSize bei
    // der GEPLANTEN Groesse begann. Mit 0,1 gekauft, 0,03 per
    // Take-Profit geschlossen und 0,2 storniert fiel der Merker auf 0 —
    // der Plan galt als abgeschlossen, waehrend 0,07 weiter im Markt
    // standen. Abgemeldet, ohne Aufsicht, und im Dashboard unter
    // "beendet", wo weder die gebundene Margin noch das schwebende
    // Ergebnis mitzaehlen.
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    // Ein Durchlauf, damit die Fill-Pruefung den eingetragenen Einstieg
    // in den Zustand uebernimmt.
    await tick(broker, monitor, state, 49_500);

    // Offen ist, was gefuellt wurde — ein Einstieg zu 0.1, nicht die
    // geplanten 0.3.
    expect(state.remainingSize).toBeCloseTo(0.1, 10);

    await tick(broker, monitor, state, 52_100);        // TP1

    // TP1 nimmt 30 % der geplanten 0,3 mit, also 0,09 — begrenzt auf
    // die offenen 0,1. Was er nicht schliesst, bleibt offen.
    const eingestiegen = store.getPlanOrders('plan-1')
      .filter(o => o.role === 'entry')
      .reduce((s, o) => s + Number(o.filled_quantity ?? 0), 0);
    const geschlossen = store.getPlanOrders('plan-1')
      .filter(o => o.role !== 'entry')
      .reduce((s, o) => s + Number(o.filled_quantity ?? 0), 0);

    expect(state.remainingSize).toBeCloseTo(eingestiegen - geschlossen, 10);
    // Und sie ist NICHT null — die stornierten Kauf-Limits haben sie
    // nie beruehrt.
    expect(state.remainingSize).toBeGreaterThan(0);
  });

  it('meldet einen Plan mit Restposition NICHT als abgeschlossen', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    await tick(broker, monitor, state, 49_500);
    await tick(broker, monitor, state, 52_100);        // TP1

    // Der Plan bleibt unter Aufsicht, solange etwas im Markt steht.
    expect(state.status).toBe('monitoring');
    expect(store.getBotTradePlan('plan-1')!.status).not.toBe('completed');
  });

  it('haelt den Vorgang im Ausfuehrungsprotokoll fest', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);
    await tick(broker, monitor, state, 52_100);

    const protokoll = store.getExecutionReports('plan-1');
    const stornos = protokoll.filter(e => {
      const meta = JSON.parse((e.metadata_json as string) ?? '{}');
      return meta.reason === 'kein_nachkauf_nach_tp';
    });

    expect(stornos).toHaveLength(2);
    expect(stornos[0]!.status).toBe('cancelled');
  });

  it('versucht es erneut, wenn die Boerse beim Zuruecknehmen nicht erreichbar war', async () => {
    const broker = brokerAttrappe({ cancelFehler: true, limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    await tick(broker, monitor, state, 52_100);        // TP1, Storno scheitert

    expect(state.tpState[0]!.triggered).toBe(true);
    // Das Zuruecknehmen schlug fehl — der Merker darf nicht "erledigt"
    // sagen, damit der Nachlauf es erneut versucht.
    expect(state.einstiegeStorniert).toBe(false);
    // Die Orders gelten weiterhin als offen — nicht stillschweigend
    // als storniert vermerkt
    const nochOffen = store.getPlanOrders('plan-1')
      .filter(o => o.role === 'entry' && o.status !== 'cancelled');
    expect(nochOffen.length).toBeGreaterThan(0);

    // Beim naechsten Durchlauf ist die Boerse wieder da
    const erreichbar = brokerAttrappe({ limitsFuellen: false });
    const monitor2 = baue(erreichbar);
    const plan = dreiEinstiegePlan();
    monitor2.registerPlan(plan);
    const state2 = monitor2.getState('plan-1')!;
    state2.tpState[0]!.triggered = true;             // TP1 war schon

    await tick(erreichbar, monitor2, state2, 49_000);

    expect(erreichbar.storniert.length).toBeGreaterThan(0);
    expect(state2.einstiegeStorniert).toBe(true);
  });

  // ============================================================
  // Die Teilrealisierung muss aus den Orders ablesbar sein
  // ============================================================
  //
  // `offenePosition()` rechnet aus den Orders: gefuellte Einstiege
  // minus gefuellte Ausstiege. Lange trug keine Take-Profit-Order ein
  // `filled_quantity` — `insertPlanOrder` kennt die Spalte nicht, und
  // nachgetragen wurde sie nur bei den Einstiegen.
  //
  // Die Folge war nicht bloss eine falsche Anzeige: Nach einem Neustart
  // laedt der Monitor die offene Position aus genau dieser Rechnung.
  // Ein Plan, von dem bereits 30 % mitgenommen waren, erschien wieder
  // mit voller Position — und haette sie ein zweites Mal verkauft.
  it('haelt eine mitgenommene Teilrealisierung in den Orders fest', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    const vorher = store.getPlanOrders('plan-1')
      .filter(o => o.role === 'entry')
      .reduce((s, o) => s + Number(o.filled_quantity ?? 0), 0);
    expect(vorher).toBeCloseTo(0.1, 10);

    await tick(broker, monitor, state, 52_100);        // TP1

    // Alle Ziele liegen im Orderbuch, eines davon ist gefuellt.
    const tpOrders = store.getPlanOrders('plan-1').filter(o => o.role === 'take_profit');
    const gefuellte = tpOrders.filter(o => Number(o.filled_quantity ?? 0) > 0);

    expect(gefuellte).toHaveLength(1);
    // Ohne diesen Eintrag waere die Schliessung aus den Orders
    // unsichtbar.
    expect(Number(gefuellte[0]!.avg_fill_price)).toBeGreaterThan(0);
    expect(gefuellte[0]!.status).toBe('filled');
  });

  it('sperrt die Einstiege auch nach einem Neustart', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);
    await tick(broker, monitor, state, 52_100);        // TP1

    // Der TP-Zustand liegt in bot_trade_plan_monitors — das ist die
    // Grundlage der Sperre.
    const gespeichert = store.getMonitor('plan-1');
    expect(gespeichert).toBeDefined();
    const tpStand = JSON.parse(String(gespeichert!.tp_state));
    expect(tpStand[0].triggered).toBe(true);

    // Neuer Monitor auf derselben Datenbank, Plan erneut angemeldet —
    // so wie es der Journal-Abgleich oder ein Neustart taete.
    const broker2 = brokerAttrappe({ limitsFuellen: false });
    const monitor2 = baue(broker2);
    monitor2.registerPlan(dreiEinstiegePlan());
    const state2 = monitor2.getState('plan-1')!;

    // Der TP-Stand wird aus der Datenbank uebernommen …
    state2.tpState = tpStand;

    // … und sperrt die Einstiege, auch wenn der Kurs zurueckkommt.
    await tick(broker2, monitor2, state2, 48_400);
    expect(broker2.platziert.filter(o => o.side === 'buy')).toHaveLength(0);
  });

  it('schliesst den Plan ab, wenn die Position WIRKLICH zu ist — auch ohne den zweiten TP', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await bisTp1(broker);

    await tick(broker, monitor, state, 52_100);        // TP1, TP2 bleibt offen
    expect(state.tpState[1]!.triggered).toBe(false);

    // Den Rest von Hand schliessen — so, wie es ein spaeterer
    // Take-Profit oder der Stop taete.
    const offen = state.remainingSize;
    expect(offen).toBeGreaterThan(0);

    store.insertPlanOrder({
      id: 'rest-zu', trade_plan_id: 'plan-1', side: 'sell', order_type: 'market',
      role: 'take_profit', symbol: 'BTCUSDT', price: 52_100, quantity: offen,
      status: 'filled', broker: 'attrappe',
    });
    store.updatePlanOrder('rest-zu', { filled_quantity: offen, avg_fill_price: 52_100 });

    await tick(broker, monitor, state, 52_100);

    // Jetzt — und erst jetzt — ist der Plan fertig. Die uebrigen Ziele
    // koennten nichts mehr schliessen.
    expect(state.remainingSize).toBeCloseTo(0, 10);
    expect(state.status).toBe('completed');
  });
});

describe('TradePlanMonitor — kein Ausstieg ohne Einstieg', () => {
  // Der Fund aus dem ersten Papertrading-Lauf: Beim HBARUSDT-Plan war
  // kein einziger Einstieg gefuellt — die Limits lagen noch an der
  // Boerse. Trotzdem feuerte der Take-Profit, sobald sein Preis
  // erreicht war, und erzeugte eine Position in der Gegenrichtung.
  //
  // Ursache: `remainingSize` begann bei der GEPLANTEN Groesse, nicht
  // bei der tatsaechlich offenen. "Position offen?" war damit von
  // Anfang an mit ja beantwortet.

  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'monitortest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Short-Plan, dessen Take-Profit UNTER dem Einstieg liegt. */
  function shortPlan() {
    const p = dreiEinstiegePlan();
    return {
      ...p,
      direction: 'short' as const,
      entry_orders: [
        { id: 'e1', price: 0.07873, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
        { id: 'e2', price: 0.07853, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
      ],
      take_profits: [
        { price: 0.07760, percentage: 100, order_type: 'limit' as const, status: 'pending' as const },
      ],
      stop_loss_price: 0.07902,
      total_size: 0.2,
    };
  }

  it('feuert keinen Take-Profit, solange kein Einstieg gefuellt ist', async () => {
    // Limits bleiben hier ausdruecklich liegen — genau der Fall aus dem
    // Papertrading-Lauf.
    const broker = brokerAttrappe({ limitsFuellen: false });
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const plan = shortPlan();
    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    // Die offene Position ist 0 — nichts wurde gefuellt.
    expect(state.remainingSize).toBe(0);

    // Der Kurs faellt unter den Take-Profit, OHNE dass ein Einstieg
    // gegriffen hat (Short fuellt erst bei Kurs >= Einstieg).
    await monitor.processPlan(state, 0.07740);

    const ausstiege = broker.platziert.filter(o => o.side === 'buy');
    expect(ausstiege).toHaveLength(0);
    expect(state.tpState[0]!.triggered).toBe(false);
  });

  it('loest auch den Stop nicht aus, solange nichts offen ist', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const plan = shortPlan();
    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    // Kurs ueber den Stop — bei einem Short der Verlustfall.
    // Der Einstieg bei 0.07853 fuellt dabei zwar (Short: Kurs >= Preis),
    // aber als LIMIT-Order, die beim Uebungsbroker liegen bleibt.
    await monitor.processPlan(state, 0.07950);

    // Es darf keine Schliessen-Order geben, denn es ist nichts offen.
    const geschlossen = broker.platziert.filter(o => o.side === 'buy');
    expect(geschlossen).toHaveLength(0);
  });

  it('nimmt den Gewinn, sobald ein Einstieg wirklich gefuellt ist', async () => {
    // Gegenprobe: Mit gefuelltem Einstieg muss der TP greifen.
    const broker = brokerAttrappe({ limitsFuellen: false });
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const plan = shortPlan();
    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    // Einen gefuellten Einstieg eintragen, wie ihn die Fill-Pruefung
    // vorfaende.
    store.insertPlanOrder({
      id: 'o-entry-1', trade_plan_id: 'plan-1', entry_order_id: 'e1',
      side: 'sell', order_type: 'limit', role: 'entry', symbol: 'BTCUSDT',
      price: 0.07873, quantity: 0.1, status: 'filled', broker: 'attrappe',
      broker_order_id: 'boerse-1',
    });
    store.updatePlanOrder('o-entry-1', { filled_quantity: 0.1, avg_fill_price: 0.07873 });

    await monitor.processPlan(state, 0.07740);

    // Ausstiege gehen jetzt vorab ins Orderbuch — Ziele wie Stop.
    const ausstiege = broker.platziert.filter(o => o.side === 'buy');
    expect(ausstiege.length).toBeGreaterThan(0);
    expect(ausstiege.every(o => o.reduceOnly === true)).toBe(true);

    // Geschlossen wird nur, was offen ist — 0.1, nicht die geplanten
    // 0.2. Das gilt fuer jede einzelne Order und fuer ihre Summe.
    expect(ausstiege.every(o => o.quantity <= 0.1 + 1e-9)).toBe(true);
    const summe = ausstiege.reduce((s, o) => s + o.quantity, 0);
    expect(summe).toBeLessThanOrEqual(0.1 * 2 + 1e-9);   // Stop + Ziele
  });
});

describe('TradePlanMonitor — die Regel greift nicht zu frueh', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'monitortest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('gilt NICHT als abgeschlossen, solange nie eingestiegen wurde', async () => {
    // Der Fehler aus dem zweiten Papertrading-Lauf: Seit die offene
    // Position bei 0 beginnt, erfuellte ein frischer Plan die
    // Abschlussbedingung "nichts mehr offen" vom ersten Durchlauf an.
    // Er galt als fertig, bevor er je eine Order abgeschickt hatte —
    // und wurde nach dem naechsten Neustart nicht mehr aufgenommen.
    const broker = brokerAttrappe({ limitsFuellen: false });
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const plan = dreiEinstiegePlan();
    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    // Kurs weit ueber allen Einstiegen — es passiert gar nichts.
    await tick(broker, monitor, state, 60_000);

    expect(state.remainingSize).toBe(0);
    expect(state.status).not.toBe('completed');

    // Und der gespeicherte Stand darf das auch nicht behaupten,
    // sonst nimmt loadActiveMonitors den Plan nach einem Neustart
    // nicht mehr auf.
    const gespeichert = store.getMonitor('plan-1');
    expect(gespeichert!.status).not.toBe('completed');
  });

  it('bleibt auch nach vielen ereignislosen Durchlaeufen unter Aufsicht', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const plan = dreiEinstiegePlan();
    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    for (let i = 0; i < 20; i++) await tick(broker, monitor, state, 60_000 + i);

    expect(state.status).toBe('monitoring');
  });

  it('kauft vor dem ersten Take-Profit weiter gestaffelt nach', async () => {
    const broker = brokerAttrappe({ limitsFuellen: false });
    const monitor = new TradePlanMonitor(broker.registry, store, stilleAusgabe, {
      nurMicaBoersen: false, defaultExchange: 'paper',
    }) as unknown as MonitorIntern;

    const plan = dreiEinstiegePlan();
    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    // Alle drei Kauf-Limits gehen SOFORT ins Orderbuch — nicht erst,
    // wenn der Kurs sie beruehrt.
    //
    // Darauf zu warten verschenkte genau das, wofuer ein Limit da ist:
    // Es liegt an der Boerse und wird gefuellt, auch waehrend eines
    // Neustarts oder zwischen zwei Kursabfragen. Am 25.10. standen
    // deshalb zwei von vier Einstiegen Stunden spaeter noch auf "nicht
    // abgeschickt", obwohl der Kurs sie laengst durchlaufen hatte.
    await monitor.processPlan(state, 50_000);
    expect(broker.platziert.filter(o => o.side === 'buy')).toHaveLength(3);

    // Und sie werden nicht ein zweites Mal gelegt.
    await monitor.processPlan(state, 49_000);
    await monitor.processPlan(state, 48_500);
    expect(broker.platziert.filter(o => o.side === 'buy')).toHaveLength(3);

    // Nichts wurde zurueckgenommen, solange kein TP griff
    expect(broker.storniert).toHaveLength(0);
  });
});

// ============================================================
// Eine abgewiesene Ausstiegs-Order hat nichts geschlossen
//
// Der Fund vom 25.10. im Uebungsbetrieb, und der folgenschwerste:
// Take-Profit 1 auf BNBUSDT wurde von der Boerse abgewiesen (der
// Uebungsbroker hatte beim Neustart seine Positionen verloren). Der
// Monitor verbuchte ihn trotzdem als ausgefuehrt — er zog den Stop
// nach, beendete die Einstiegsphase und erklaerte den Plan fuer
// abgeschlossen.
//
// Zurueck blieben 7,68 BNB im Markt, die niemand mehr beaufsichtigte.
// Die Anzeige behauptete einen Gewinn, den es nicht gab, und der Stop,
// der haette greifen muessen, wurde nie geprueft.
// ============================================================

describe('TradePlanMonitor — abgewiesene Ausstiegs-Orders', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'monitorabweis-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
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

  /**
   * Bringt einen Plan in den Zustand "ein Einstieg gefuellt, Position
   * offen" — genau die Lage, in der TP1 feuert.
   */
  async function mitOffenerPosition(broker: ReturnType<typeof brokerAttrappe>) {
    const monitor = baue(broker);
    const plan = dreiEinstiegePlan();

    store.upsertBotTradePlan({
      ...plan,
      entry_orders: JSON.stringify(plan.entry_orders),
      take_profits: JSON.stringify(plan.take_profits),
      activation_conditions: '[]',
      executed_orders: '[]',
      execution_mode: 'all_limit',
      entry_zones: null,
    });
    monitor.registerPlan(plan);
    const state = monitor.getState('plan-1')!;

    await tick(broker, monitor, state, 48_400);

    const entries = store.getPlanOrders('plan-1').filter(o => o.role === 'entry');
    store.updatePlanOrder(entries[0]!.id as string, {
      status: 'filled', filled_quantity: 0.1, avg_fill_price: 50_000,
    });

    return { monitor, state };
  }

  it('haelt den Take-Profit offen, wenn die Order abgewiesen wurde', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    // Der Kurs erreicht TP1.
    await tick(broker, monitor, state, 52_000);

    // Der Versuch wurde unternommen ...
    expect(broker.platziert.some(o => o.reduceOnly)).toBe(true);
    // ... aber er ist gescheitert, also gilt der TP NICHT als erreicht.
    expect(state.tpState[0]!.triggered).toBe(false);
  });

  it('zieht den Stop nach einem abgewiesenen Take-Profit NICHT nach', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);
    const slVorher = state.slCurrent;

    await tick(broker, monitor, state, 52_000);

    // Ein nachgezogener Stop auf einen Gewinn, der nie realisiert wurde,
    // waere die gefaehrlichste Folge: Er wuerde die Position bei einem
    // Ruecksetzer glattstellen, den der Plan ausdruecklich aushalten
    // sollte.
    expect(state.slCurrent).toBe(slVorher);
  });

  it('beendet die Einstiegsphase nach einem abgewiesenen Take-Profit nicht', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    await tick(broker, monitor, state, 52_000);

    // "Kein Nachkauf nach TP1" setzt voraus, dass TP1 wirklich griff.
    expect(state.einstiegeStorniert).toBe(false);
    expect(broker.storniert).toHaveLength(0);
  });

  it('erklaert den Plan nach einem abgewiesenen Take-Profit nicht fuer abgeschlossen', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    await tick(broker, monitor, state, 52_000);

    expect(state.status).not.toBe('completed');
    // Die Position steht weiter im Markt.
    expect(state.remainingSize).toBeCloseTo(0.1, 10);
  });

  it('versucht den Take-Profit beim naechsten Durchlauf erneut', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    await tick(broker, monitor, state, 52_000);
    const nachErstem = broker.platziert.filter(o => o.reduceOnly).length;

    await tick(broker, monitor, state, 52_100);
    const nachZweitem = broker.platziert.filter(o => o.reduceOnly).length;

    // Aufgeben waere das Gegenteil von richtig: Die Ursache kann eine
    // voruebergehende sein, das Ziel ist erreicht, und die Position
    // soll heraus.
    expect(nachZweitem).toBeGreaterThan(nachErstem);
  });

  it('haelt die Order mit ihrem Status fest', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    await tick(broker, monitor, state, 52_000);

    // Der Fehlschlag muss aus der Datenbank hervorgehen — sonst sieht
    // die Detailansicht einen Take-Profit, den es nie gab.
    const tps = store.getPlanOrders('plan-1').filter(o => o.role === 'take_profit');
    expect(tps.length).toBeGreaterThan(0);
    expect(tps[0]!.status).toBe('rejected');
    expect(Number(tps[0]!.filled_quantity)).toBe(0);
  });

  it('schliesst den Plan nach einem abgewiesenen Stop-Loss nicht ab', async () => {
    const broker = brokerAttrappe({ reduceOnlyAbweisen: true, limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    // Der Kurs faellt unter den Stop bei 47.000.
    await tick(broker, monitor, state, 46_500);

    // Der Stop wird nebenher ausgeloest (`void executeStopLossHit`),
    // nicht im Zug von processPlan — ohne diese Atempause praefte der
    // Test einen Zustand, den der Monitor noch gar nicht erreicht hat.
    await new Promise(aufloesen => setTimeout(aufloesen, 30));

    // Der gefaehrlichste Fall ueberhaupt: Der Plan gaelte als
    // abgeschlossen, waehrend die Position jenseits ihres Stops im
    // Markt steht — und niemand mehr hinsieht.
    expect(state.status).not.toBe('completed');
    expect(state.remainingSize).toBeCloseTo(0.1, 10);
    expect(state.errorCount).toBeGreaterThan(0);
  });

  it('nimmt den Take-Profit an, sobald die Boerse ihn durchlaesst', async () => {
    // Die Gegenprobe: Ohne Abweisung laeuft alles wie bisher.
    const broker = brokerAttrappe({ limitsFuellen: false });
    const { monitor, state } = await mitOffenerPosition(broker);

    await tick(broker, monitor, state, 52_000);

    expect(state.tpState[0]!.triggered).toBe(true);
    expect(state.einstiegeStorniert).toBe(true);
  });
});
