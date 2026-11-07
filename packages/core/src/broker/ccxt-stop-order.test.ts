// ============================================================
// Stop-Orders, wie die Boerse sie wirklich braucht
//
// Diese Datei prueft nicht, was der Broker denkt, sondern **was bei
// ccxt ankommt** — denn dort entsteht aus unseren Angaben der
// eigentliche Boersenauftrag.
//
// Anlass: Am 07.11.2026 wurde gegen die offizielle Phemex-Dokumentation
// und zwei Fremdprojekte geprueft, ob die Befehle stimmen. Zwei Fehler
// kamen heraus, und **beide hatten noch nie eine echte Boerse
// erreicht** — am 05.11.2026 gingen nur zwei Einstiege an Phemex, nie
// ein Stop. Der Uebungsbroker braucht keines der beiden Felder.
//
//   1. `triggerDirection` fehlte. ccxt verlangt es fuer Phemex
//      zwingend und wirft sonst `ArgumentsRequired` — die Order
//      verlaesst den Bot nicht einmal.
//
//   2. `type: 'stop'` wurde unveraendert durchgereicht. ccxt schreibt
//      den Wert gross und vergleicht gegen `'Market'`; aus `'Stop'`
//      wurde deshalb `ordType: 'StopLimit'` — eine Stop-Limit-Order
//      **ohne Limitpreis**.
// ============================================================

import { describe, it, expect } from 'vitest';
import { CcxtBroker } from './ccxt-broker.js';

type Gesendet = Record<string, unknown>;

/**
 * Baut einen Broker, dessen ccxt-Instanz den Auftrag festhaelt,
 * anstatt ihn abzuschicken.
 *
 * Es wird die **echte** ccxt-Phemex-Klasse benutzt: Nur dann prueft
 * der Test die wirkliche Uebersetzung und nicht unsere Vorstellung
 * davon.
 */
async function abfangenderBroker() {
  const gesendet: Gesendet[] = [];
  const broker = new CcxtBroker({
    exchange: 'phemex', apiKey: 'x', apiSecret: 'y', marketType: 'futures',
  });
  const ex = (broker as unknown as { exchange: Record<string, unknown> }).exchange;

  await (ex as unknown as { loadMarkets(): Promise<unknown> }).loadMarkets();

  for (const m of ['privatePostGOrders', 'privatePutGOrdersCreate', 'privatePostOrders']) {
    if (typeof ex[m] === 'function') {
      ex[m] = async (anfrage: Gesendet) => {
        gesendet.push(anfrage);
        throw new Error('ABGEFANGEN');
      };
    }
  }

  const schicke = async (p: Record<string, unknown>) => {
    try {
      await (broker as unknown as { placeOrder(p: unknown): Promise<unknown> }).placeOrder(p);
    } catch (err) {
      // Nur das Abfangen ist erwartet; alles andere ist ein echter
      // Befund und muss den Test zum Scheitern bringen.
      if ((err as Error).message !== 'ABGEFANGEN') throw err;
    }
    return gesendet[gesendet.length - 1]!;
  };

  return { schicke, gesendet };
}

describe('Stop-Order an Phemex', () => {
  it('kommt als Stop-Market an, nicht als StopLimit ohne Preis', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'sell', type: 'stop',
      stopPrice: 70_000, quantity: 0.01, reduceOnly: true, positionSide: 'long',
    });

    // Vorher stand hier `StopLimit` — ohne `priceRp`.
    expect(auftrag['ordType']).toBe('Stop');
    expect(auftrag['stopPxRp']).toBe('70000');
    expect(auftrag['priceRp']).toBeUndefined();
  });

  it('traegt triggerDirection, sonst wirft ccxt vor dem Absenden', async () => {
    const { schicke } = await abfangenderBroker();

    // Ohne das Feld haette dieser Aufruf `ArgumentsRequired` geworfen
    // und der Test waere daran gescheitert — `schicke` reicht jeden
    // anderen Fehler weiter.
    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'sell', type: 'stop',
      stopPrice: 70_000, quantity: 0.01, reduceOnly: true, positionSide: 'long',
    });

    expect(auftrag['ordType']).toBe('Stop');
    expect(auftrag['triggerType']).toBe('ByMarkPrice');
  });

  // Die Paarung von Seite und Richtung entscheidet bei ccxt ueber den
  // `ordType`. Nur diese beiden ergeben einen echten Stop; vertauscht
  // ergaeben sie `MarketIfTouched`, also eine Order, die in
  // Gewinnrichtung ausloest.
  it('macht aus dem Long-Stop einen Stop (Verkauf, fallend)', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'sell', type: 'stop',
      stopPrice: 70_000, quantity: 0.01, reduceOnly: true, positionSide: 'long',
    });

    expect(auftrag['ordType']).toBe('Stop');
    expect(auftrag['side']).toBe('Sell');
  });

  it('macht aus dem Short-Stop einen Stop (Kauf, steigend)', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'buy', type: 'stop',
      stopPrice: 85_000, quantity: 0.01, reduceOnly: true, positionSide: 'short',
    });

    expect(auftrag['ordType']).toBe('Stop');
    expect(auftrag['side']).toBe('Buy');
  });

  it('macht aus stop_limit eine StopLimit MIT Limitpreis', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'sell', type: 'stop_limit',
      stopPrice: 70_000, price: 69_900, quantity: 0.01,
      reduceOnly: true, positionSide: 'long',
    });

    expect(auftrag['ordType']).toBe('StopLimit');
    expect(auftrag['stopPxRp']).toBe('70000');
    expect(auftrag['priceRp']).toBe('69900');
  });
});

describe('Die uebrigen Orderarten bleiben unberuehrt', () => {
  it('schickt den Take-Profit als gewoehnliches reduceOnly-Limit', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'sell', type: 'limit',
      price: 85_000, quantity: 0.01, reduceOnly: true, positionSide: 'long',
    });

    // Kein Trigger: Die Ziele liegen als Limit-Orders im Buch
    // (Regel 3aa), damit die Boerse sie bei jedem Tick prueft.
    expect(auftrag['ordType']).toBe('Limit');
    expect(auftrag['priceRp']).toBe('85000');
    expect(auftrag['reduceOnly']).toBe(true);
    expect(auftrag['stopPxRp']).toBeUndefined();
  });

  it('schickt den Einstieg als Limit ohne reduceOnly', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit',
      price: 70_000, quantity: 0.01, reduceOnly: false, positionSide: 'long',
    });

    expect(auftrag['ordType']).toBe('Limit');
    expect(auftrag['priceRp']).toBe('70000');
    expect(auftrag['reduceOnly']).toBeUndefined();
  });

  it('schickt die Markt-Eroeffnung als Market', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'buy', type: 'market',
      quantity: 0.01, reduceOnly: false, positionSide: 'long',
    });

    expect(auftrag['ordType']).toBe('Market');
    expect(auftrag['stopPxRp']).toBeUndefined();
  });

  // Die Menge geht bei USDT-Kontrakten als `orderQtyRq` hinaus, nicht
  // als `orderQty` — das waere die Form der Inverse-Kontrakte und
  // wuerde auf eine ganze Zahl gerundet.
  it('schickt die Menge als orderQtyRq', async () => {
    const { schicke } = await abfangenderBroker();

    const auftrag = await schicke({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit',
      price: 70_000, quantity: 0.01, reduceOnly: false, positionSide: 'long',
    });

    expect(auftrag['orderQtyRq']).toBe(0.01);
    expect(auftrag['orderQty']).toBeUndefined();
  });
});
