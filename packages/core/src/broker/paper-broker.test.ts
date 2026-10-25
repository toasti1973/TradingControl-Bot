import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PaperBroker } from './paper-broker.js';

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
