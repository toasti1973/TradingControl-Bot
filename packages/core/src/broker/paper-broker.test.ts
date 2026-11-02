import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PaperBroker } from './paper-broker.js';
import { PaperAccount } from './paper-account.js';

// ============================================================
// Kursabruf bei Phemex
//
// Hier lagen zwei Fehler, die den Uebungsbetrieb unbrauchbar machten
// und beide stillschweigend wirkten — getPrice lieferte einfach null,
// und kein Plan kam je ueber die Preispruefung hinaus:
//
//   1. Die Antwort wurde als { code, data } gelesen, Phemex schickt
//      aber { error, result }.
//   2. Dem Symbol wurde ein "s" vorangestellt; die Schnittstelle
//      quittiert "sETHUSDT" mit "invalid argument".
// ============================================================
describe('PaperBroker — Kursabruf bei Phemex', () => {
  const urspruenglichesFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = urspruenglichesFetch;
    vi.restoreAllMocks();
  });

  /** Faengt die Abfrage ab und liefert eine vorgegebene Antwort. */
  function antworteMit(rumpf: unknown, ok = true) {
    const aufrufe: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      aufrufe.push(String(url));
      return { ok, json: async () => rumpf } as Response;
    }) as typeof fetch;
    return aufrufe;
  }

  it('liest die heutige Antwortform { error, result }', async () => {
    antworteMit({ error: null, id: 0, result: { markPriceRp: '2337.8', closeRp: '2337.8' } });
    const broker = new PaperBroker();
    expect(await broker.getPrice('ETHUSDT')).toBe(2337.8);
  });

  it('liest auch die aeltere Form { code, data }', async () => {
    antworteMit({ code: 0, data: { markPriceRp: '79982.1' } });
    const broker = new PaperBroker();
    expect(await broker.getPrice('BTCUSDT')).toBe(79982.1);
  });

  it('fragt das Symbol ohne vorangestelltes "s" ab', async () => {
    const aufrufe = antworteMit({ error: null, result: { markPriceRp: '100' } });
    const broker = new PaperBroker();
    await broker.getPrice('ETHUSDT');

    expect(aufrufe[0]).toContain('symbol=ETHUSDT');
    expect(aufrufe[0]).not.toContain('sETHUSDT');
  });

  it.each([
    ['BTC/USDT', 'BTCUSDT'],
    ['BTCUSDT.P', 'BTCUSDT'],
    ['btcusdt', 'BTCUSDT'],
  ])('vereinheitlicht %s zu %s', async (eingabe, erwartet) => {
    const aufrufe = antworteMit({ error: null, result: { markPriceRp: '100' } });
    await new PaperBroker().getPrice(eingabe);
    expect(aufrufe[0]).toContain(`symbol=${erwartet}`);
  });

  it('weicht auf closeRp aus, wenn kein Mark-Preis gefuehrt wird', async () => {
    antworteMit({ error: null, result: { closeRp: '1234.5' } });
    expect(await new PaperBroker().getPrice('ETHUSDT')).toBe(1234.5);
  });

  it('liefert null, wenn die Schnittstelle einen Fehler meldet', async () => {
    antworteMit({ error: { code: 6001, message: 'invalid argument' }, result: null });
    expect(await new PaperBroker().getPrice('QUATSCH')).toBeNull();
  });

  it('liefert null bei einem unbrauchbaren Kurs', async () => {
    antworteMit({ error: null, result: { markPriceRp: '0' } });
    expect(await new PaperBroker().getPrice('ETHUSDT')).toBeNull();
  });

  it('behaelt den zuletzt bekannten Kurs, wenn die Abfrage scheitert', async () => {
    antworteMit({ error: null, result: { markPriceRp: '2000' } });
    const broker = new PaperBroker();
    expect(await broker.getPrice('ETHUSDT')).toBe(2000);

    globalThis.fetch = (async () => { throw new Error('Netz weg'); }) as typeof fetch;
    expect(await broker.getPrice('ETHUSDT')).toBe(2000);
  });
});

describe('PaperBroker — reduceOnly darf nicht eroeffnen', () => {
  // Der Fund aus dem ersten Papertrading-Lauf: Ein Take-Profit feuerte,
  // bevor ein Einstieg gefuellt war. Der Broker machte daraus eine
  // Position in der Gegenrichtung — aus einem geplanten Short ein Long
  // ueber 51.215 HBAR, den niemand wollte.

  it('weist eine Nur-Schliessen-Order ohne Position ab', async () => {
    const broker = new PaperBroker({ priceSource: 'static', staticPrices: { BTCUSDT: 50_000 } });

    const r = await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'market', quantity: 0.1, reduceOnly: true,
    });

    expect(r.status).toBe('rejected');
    expect(r.filledQuantity).toBe(0);
    expect(await broker.getPosition('BTCUSDT')).toBeNull();
  });

  it('weist sie auch dann ab, wenn die Position in dieselbe Richtung zeigt', async () => {
    const broker = new PaperBroker({ priceSource: 'static', staticPrices: { BTCUSDT: 50_000 } });
    await broker.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', quantity: 0.1 });

    // Ein "Schliessen" in Kaufrichtung bei einer Long-Position ergibt
    // keinen Sinn — das waere ein Nachkauf.
    const r = await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'buy', type: 'market', quantity: 0.1, reduceOnly: true,
    });

    expect(r.status).toBe('rejected');
    const pos = await broker.getPosition('BTCUSDT');
    expect(pos!.size).toBeCloseTo(0.1, 10);   // unveraendert
  });

  it('schliesst eine vorhandene Position', async () => {
    const broker = new PaperBroker({ priceSource: 'static', staticPrices: { BTCUSDT: 50_000 } });
    await broker.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', quantity: 0.1 });

    const r = await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'market', quantity: 0.1, reduceOnly: true,
    });

    expect(r.status).toBe('filled');
    expect(await broker.getPosition('BTCUSDT')).toBeNull();
  });

  it('begrenzt auf das, was offen ist — statt die Position zu drehen', async () => {
    const broker = new PaperBroker({ priceSource: 'static', staticPrices: { BTCUSDT: 50_000 } });
    await broker.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', quantity: 0.1 });

    // Doppelt so viel schliessen wollen wie da ist
    const r = await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'market', quantity: 0.2, reduceOnly: true,
    });

    expect(r.status).toBe('filled');
    expect(r.quantity).toBeCloseTo(0.1, 10);
    // Entscheidend: keine Short-Position als Rest
    expect(await broker.getPosition('BTCUSDT')).toBeNull();
  });

  it('laesst gewoehnliche Orders unberuehrt', async () => {
    const broker = new PaperBroker({ priceSource: 'static', staticPrices: { BTCUSDT: 50_000 } });
    const r = await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'market', quantity: 0.1,
    });

    expect(r.status).toBe('filled');
    const pos = await broker.getPosition('BTCUSDT');
    expect(pos!.side).toBe('sell');
  });

  it('prueft auch beim spaeteren Fuellen eines Limits erneut', async () => {
    const broker = new PaperBroker({ priceSource: 'static', staticPrices: { BTCUSDT: 50_000 } });
    await broker.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', quantity: 0.1 });

    // Schliessen-Limit platzieren, das noch nicht fuellt
    const limit = await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'limit', quantity: 0.1, price: 52_000,
      reduceOnly: true,
    });
    expect(limit.status).toBe('new');

    // Position verschwindet in der Zwischenzeit
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'market', quantity: 0.1, reduceOnly: true,
    });

    // Jetzt wird der Limit-Preis erreicht — es darf nichts entstehen
    broker.setPrice('BTCUSDT', 52_500);
    const stand = await broker.getOrder('BTCUSDT', limit.orderId);

    expect(stand!.status).toBe('rejected');
    expect(await broker.getPosition('BTCUSDT')).toBeNull();
  });
});

// ============================================================
// Positionen ueberleben den Neustart
//
// Der Fund aus dem zweiten Papertrading-Lauf, und der teuerste bisher:
// Der Broker fuehrte seine Positionen in einer eigenen Liste neben der
// des Kontos. Gespeichert wird aber nur das Konto. Nach einem Neustart
// war die Liste des Brokers leer — und jede Nur-Schliessen-Order lief
// ins Leere.
//
// Am 25.10. traf es BNBUSDT: Take-Profit 1 feuerte bei 741,37, die
// Order wurde abgewiesen, 7,68 BNB blieben im Markt. Der Monitor hielt
// den Take-Profit trotzdem fuer ausgefuehrt, zog den Stop nach und
// erklaerte den Plan fuer abgeschlossen. Ab da sah niemand mehr hin.
// ============================================================
describe('PaperBroker — Positionen nach einem Neustart', () => {
  /**
   * Baut die Lage nach einem Neustart nach: ein frisches Konto, in das
   * der gespeicherte Stand samt Positionen geladen wurde, und ein
   * frischer Broker darauf.
   */
  function nachNeustart(): PaperBroker {
    const konto = new PaperAccount(10_000, 'USDT');
    konto.wiederherstellen({
      startkapital: 10_000, realisiert: 0, gebuehren: 1.39,
      trades: 0, gewinne: 0, verluste: 0,
      positionen: [
        { symbol: 'BNBUSDT', seite: 'buy', menge: 7.67954389, einstiegspreis: 737.81, hebel: 22 },
        { symbol: 'HYPEUSDT', seite: 'sell', menge: 108.66307676, einstiegspreis: 75.64, hebel: 16 },
      ],
    });

    return new PaperBroker({
      konto,
      priceSource: 'static',
      staticPrices: { BNBUSDT: 741.37, HYPEUSDT: 75.0 },
    });
  }

  it('kennt die wiederhergestellten Positionen', async () => {
    const broker = nachNeustart();

    const bnb = await broker.getPosition('BNBUSDT');
    expect(bnb).not.toBeNull();
    expect(bnb!.side).toBe('buy');
    expect(bnb!.size).toBeCloseTo(7.67954389, 8);
    expect(bnb!.entryPrice).toBeCloseTo(737.81, 6);
    expect(bnb!.leverage).toBe(22);
  });

  it('nimmt den Take-Profit auf eine wiederhergestellte Long-Position an', async () => {
    const broker = nachNeustart();

    // Genau der Fall vom 25.10.: TP1 auf BNBUSDT nach einem Neustart.
    const r = await broker.placeOrder({
      symbol: 'BNBUSDT', side: 'sell', type: 'market',
      quantity: 7.67954389, reduceOnly: true,
    });

    expect(r.status).toBe('filled');
    expect(r.filledQuantity).toBeCloseTo(7.67954389, 8);
    // Und die Position ist danach wirklich zu.
    expect(await broker.getPosition('BNBUSDT')).toBeNull();
  });

  it('nimmt den Take-Profit auf eine wiederhergestellte Short-Position an', async () => {
    const broker = nachNeustart();

    // Beim Short schliesst ein Kauf.
    const r = await broker.placeOrder({
      symbol: 'HYPEUSDT', side: 'buy', type: 'market',
      quantity: 54.33153838, reduceOnly: true,
    });

    expect(r.status).toBe('filled');
    const rest = await broker.getPosition('HYPEUSDT');
    expect(rest!.size).toBeCloseTo(54.33153838, 8);
  });

  it('weist eine Nur-Schliessen-Order auf ein Symbol ohne Position weiter ab', async () => {
    const broker = nachNeustart();

    const r = await broker.placeOrder({
      symbol: 'ETHUSDT', side: 'sell', type: 'market', quantity: 1, reduceOnly: true,
    });

    expect(r.status).toBe('rejected');
  });

  it('fuehrt nur ein Buch — Broker und Konto koennen nicht auseinanderlaufen', async () => {
    const broker = nachNeustart();

    await broker.placeOrder({
      symbol: 'BNBUSDT', side: 'sell', type: 'market',
      quantity: 3, reduceOnly: true,
    });

    const ausBroker = await broker.getPosition('BNBUSDT');
    const ausKonto = broker.konto.position('BNBUSDT');

    expect(ausBroker!.size).toBeCloseTo(ausKonto!.menge, 10);
    expect(ausBroker!.entryPrice).toBeCloseTo(ausKonto!.einstiegspreis, 10);
  });
});

describe('PaperBroker — Kontostand des Uebungskontos', () => {
  it('nennt das hinterlegte Startkapital', async () => {
    const broker = new PaperBroker({ startkapital: { USDT: 10_000 } });
    const bestand = await broker.getBalance();

    expect(bestand.total.USDT).toBe(10_000);
    expect(bestand.free.USDT).toBe(10_000);
    expect(bestand.used.USDT).toBe(0);
  });

  it('behauptet nichts, wenn kein Startkapital hinterlegt ist', async () => {
    const bestand = await new PaperBroker().getBalance();
    expect(bestand.total).toEqual({});
  });
});

describe('PaperBroker', () => {
  let broker: PaperBroker;

  beforeEach(() => {
    broker = new PaperBroker({
      priceSource: 'static',
      staticPrices: { BTCUSDT: 50000 },
    });
  });

  it('should return static prices', async () => {
    const price = await broker.getPrice('BTCUSDT');
    expect(price).toBe(50000);
  });

  it('should return null for unknown symbols', async () => {
    const price = await broker.getPrice('UNKNOWN');
    expect(price).toBeNull();
  });

  it('should set and track leverage', async () => {
    await broker.setLeverage('BTCUSDT', 10);
    // No error = success (Paper broker just stores it)
  });

  it('should place and fill market orders immediately', async () => {
    await broker.connect();
    const result = await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      quantity: 0.1,
    });

    expect(result.status).toBe('filled');
    expect(result.filledQuantity).toBe(0.1);
    expect(result.avgFillPrice).toBe(50000);
    expect(result.orderId).toMatch(/^paper-/);
  });

  it('should place limit orders as new', async () => {
    const result = await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      quantity: 0.1,
      price: 49000,
    });

    expect(result.status).toBe('new');
    expect(result.filledQuantity).toBe(0);
  });

  it('should fill limit buy when price drops to order price', async () => {
    const result = await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      quantity: 0.1,
      price: 50000,
    });

    // Preis auf exakt Order-Preis setzen
    broker.setPrice('BTCUSDT', 50000);
    const order = await broker.getOrder('BTCUSDT', result.orderId);

    expect(order?.status).toBe('filled');
    expect(order?.filledQuantity).toBe(0.1);
  });

  it('should not fill limit buy when price is above order price', async () => {
    const result = await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      quantity: 0.1,
      price: 49000,
    });

    broker.setPrice('BTCUSDT', 50000);
    const order = await broker.getOrder('BTCUSDT', result.orderId);
    expect(order?.status).toBe('new');
  });

  it('should cancel orders', async () => {
    const result = await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      quantity: 0.1,
      price: 49000,
    });

    await broker.cancelOrder('BTCUSDT', result.orderId);
    const order = await broker.getOrder('BTCUSDT', result.orderId);
    expect(order?.status).toBe('cancelled');
  });

  it('should track positions after market fill', async () => {
    await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      quantity: 0.5,
    });

    const pos = await broker.getPosition('BTCUSDT');
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe('buy');
    expect(pos!.size).toBe(0.5);
    expect(pos!.entryPrice).toBe(50000);
  });

  it('should return null position for no position', async () => {
    const pos = await broker.getPosition('BTCUSDT');
    expect(pos).toBeNull();
  });

  it('should check fills on all open orders', async () => {
    await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      quantity: 0.1,
      price: 50000,
    });

    broker.setPrice('BTCUSDT', 49000);
    const fills = await broker.checkFills();
    expect(fills.length).toBe(1);
    expect(fills[0]!.status).toBe('filled');
  });
});

// ============================================================
// Kennungen duerfen sich nicht wiederholen
//
// Der schwerste Fund vom 25.10.: Die Order-Kennungen waren ein
// fortlaufender Zaehler, der nach jedem Neustart wieder bei 1 begann —
// waehrend in der Datenbank noch die Kennungen des vorigen Laufs
// standen. Dazu ignorierte getOrder() das Symbol.
//
// Die Folge: Die Frage nach einer BNBUSDT-Order wurde mit einer
// HYPEUSDT-Order beantwortet. Eine Bestellung ueber 1,67 BNB galt als
// mit 122,14 Stueck zu 76,45 gefuellt, und der Bot verbuchte
// 80.768 USDT Verlust auf einem Konto mit 10.000.
// ============================================================
describe('PaperBroker — Order-Kennungen', () => {
  it('vergibt eindeutige Kennungen, auch ueber Neustarts hinweg', async () => {
    const ersterLauf = new PaperBroker({
      priceSource: 'static', staticPrices: { BTCUSDT: 50_000 },
      startkapital: { USDT: 10_000 },
    });
    const a = await ersterLauf.placeOrder({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit', quantity: 1, price: 40_000,
    });

    // Ein frischer Broker — wie nach einem Neustart.
    const zweiterLauf = new PaperBroker({
      priceSource: 'static', staticPrices: { BTCUSDT: 50_000 },
      startkapital: { USDT: 10_000 },
    });
    const b = await zweiterLauf.placeOrder({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit', quantity: 1, price: 40_000,
    });

    // Mit einem Zaehler hiessen beide "paper-1".
    expect(a.orderId).not.toBe(b.orderId);
  });

  it('antwortet nicht mit einer Order zu einem anderen Symbol', async () => {
    const broker = new PaperBroker({
      priceSource: 'static',
      staticPrices: { BTCUSDT: 50_000, ETHUSDT: 3_000 },
      startkapital: { USDT: 10_000 },
    });

    const eth = await broker.placeOrder({
      symbol: 'ETHUSDT', side: 'buy', type: 'limit', quantity: 2, price: 2_000,
    });

    // Dieselbe Kennung, aber nach BTCUSDT gefragt.
    const antwort = await broker.getOrder('BTCUSDT', eth.orderId);

    // Lieber keine Antwort als die falsche.
    expect(antwort).toBeNull();
  });

  it('antwortet auf die Frage nach dem richtigen Symbol', async () => {
    const broker = new PaperBroker({
      priceSource: 'static', staticPrices: { ETHUSDT: 3_000 },
      startkapital: { USDT: 10_000 },
    });

    const eth = await broker.placeOrder({
      symbol: 'ETHUSDT', side: 'buy', type: 'limit', quantity: 2, price: 2_000,
    });

    const antwort = await broker.getOrder('ETHUSDT', eth.orderId);
    expect(antwort).not.toBeNull();
    expect(antwort!.symbol).toBe('ETHUSDT');
  });

  it('erkennt dasselbe Symbol in anderer Schreibweise', async () => {
    const broker = new PaperBroker({
      priceSource: 'static', staticPrices: { ETHUSDT: 3_000 },
      startkapital: { USDT: 10_000 },
    });

    const eth = await broker.placeOrder({
      symbol: 'ETHUSDT', side: 'buy', type: 'limit', quantity: 2, price: 2_000,
    });

    // ETH/USDT und ETHUSDT meinen denselben Markt — die Pruefung darf
    // nicht an der Schreibweise scheitern.
    expect(await broker.getOrder('ETH/USDT', eth.orderId)).not.toBeNull();
  });
});

// ============================================================
// Das Orderbuch ueberlebt den Neustart
//
// Der Fund vom 26.10.: Dieser Zugang haelt seine Orders im
// Arbeitsspeicher. Nach einem Neustart war die Liste leer — eine
// Order, die in der Datenbank des Bots als "liegt an der Boerse"
// stand, war ihm unbekannt. `getOrder` lieferte null, der Monitor
// erfuhr nie von ihrer Fuellung, und sie fuellte auch nie.
//
// Konkret: BNBUSDT, Take-Profit 1 bei 743,86, Kurs bei 746,73 — zwei
// Mark darueber. Die Order haette fuellen MUESSEN und lag unberuehrt.
//
// Eine echte Boerse verliert ihr Orderbuch nicht, wenn der Bot neu
// startet. Dieser Zugang darf es auch nicht.
// ============================================================
describe('PaperBroker — Orderbuch nach einem Neustart', () => {
  /** Ein frischer Zugang, wie nach einem Neustart. */
  function nachNeustart(kurs: number) {
    const konto = new PaperAccount(10_000, 'USDT');
    konto.wiederherstellen({
      startkapital: 10_000, realisiert: 0, gebuehren: 0,
      trades: 0, gewinne: 0, verluste: 0,
      positionen: [
        { symbol: 'BNBUSDT', seite: 'buy', menge: 5.455963, einstiegspreis: 739.96, hebel: 10 },
      ],
    });

    return new PaperBroker({
      konto, priceSource: 'static', staticPrices: { BNBUSDT: kurs },
    });
  }

  it('kennt eine wieder aufgenommene Order', async () => {
    const broker = nachNeustart(746.73);

    const zahl = broker.ordersWiederherstellen([{
      brokerOrderId: 'paper-a8247fbb', symbol: 'BNBUSDT', side: 'sell',
      type: 'limit', quantity: 1.3639906875, price: 743.85524, reduceOnly: true,
    }]);

    expect(zahl).toBe(1);
    expect(await broker.getOrder('BNBUSDT', 'paper-a8247fbb')).not.toBeNull();
  });

  it('fuellt sie, wenn der Kurs laengst darueber steht', async () => {
    // Genau der Fall vom 26.10.
    const broker = nachNeustart(746.73);
    broker.ordersWiederherstellen([{
      brokerOrderId: 'paper-a8247fbb', symbol: 'BNBUSDT', side: 'sell',
      type: 'limit', quantity: 1.3639906875, price: 743.85524, reduceOnly: true,
    }]);

    const stand = await broker.getOrder('BNBUSDT', 'paper-a8247fbb');

    expect(stand!.status).toBe('filled');
    expect(stand!.filledQuantity).toBeCloseTo(1.3639906875, 8);
  });

  it('nimmt dieselbe Order nicht zweimal auf', async () => {
    const broker = nachNeustart(740);
    const order = {
      brokerOrderId: 'paper-x', symbol: 'BNBUSDT', side: 'sell' as const,
      type: 'limit' as const, quantity: 1, price: 743.85, reduceOnly: true,
    };

    expect(broker.ordersWiederherstellen([order])).toBe(1);
    expect(broker.ordersWiederherstellen([order])).toBe(0);
  });

  it('nimmt auch Stop-Orders wieder auf', async () => {
    const broker = nachNeustart(732);
    broker.ordersWiederherstellen([{
      brokerOrderId: 'paper-stop', symbol: 'BNBUSDT', side: 'sell',
      type: 'stop', quantity: 5.455963, stopPrice: 733.0287, reduceOnly: true,
    }]);

    // Der Kurs ist unter den Stop gefallen — er muss ausloesen.
    const stand = await broker.getOrder('BNBUSDT', 'paper-stop');
    expect(stand!.status).toBe('filled');
  });

  it('laesst eine Order liegen, die der Kurs nicht erreicht hat', async () => {
    const broker = nachNeustart(740);
    broker.ordersWiederherstellen([{
      brokerOrderId: 'paper-y', symbol: 'BNBUSDT', side: 'sell',
      type: 'limit', quantity: 1, price: 750, reduceOnly: true,
    }]);

    expect((await broker.getOrder('BNBUSDT', 'paper-y'))!.status).toBe('new');
  });

  it('uebergeht Eintraege ohne Boersen-Kennung', async () => {
    const broker = nachNeustart(740);
    const zahl = broker.ordersWiederherstellen([{
      brokerOrderId: '', symbol: 'BNBUSDT', side: 'sell',
      type: 'limit', quantity: 1, price: 743, reduceOnly: true,
    }]);

    expect(zahl).toBe(0);
  });
});
