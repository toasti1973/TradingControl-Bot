// ============================================================
// Der Hebel muss den Neustart ueberleben
//
// Der Uebungsbroker hielt den Hebel in einer Map im Arbeitsspeicher,
// gefuellt durch `setLeverage()` beim Platzieren einer Order. Das
// genuegte, solange Einstiege als Market-Orders sofort nach dem
// Setzen hinausgingen.
//
// Seit die Einstiege als Limit-Orders im Orderbuch liegen (Regel
// 3aa), vergehen zwischen Platzieren und Fuellung oft Stunden. Faellt
// dazwischen ein Neustart, ist die Map leer — und `?? 1` buchte die
// Fuellung mit Hebel 1.
//
// Am 02.11.2026 sah das so aus:
//
//   Kontostand                 8.309,58 USDT
//   gebunden laut Anzeige     10.606,21 USDT   <- mehr als vorhanden
//   frei                           0,00 USDT
//
//   BNBUSDT buy  Hebel 1 statt 16  ->  4.854,18 statt  303,39
//   SOLUSDT buy  Hebel 1 statt 13  ->  3.082,81 statt  237,14
//
// Die Folge war schwerer als eine falsche Anzeige: Mit `frei = 0`
// fiel die Risikogrenze aus, die sich auf die verfuegbare Margin
// stuetzt — bei jedem Signal stand "Kein freier Betrag bekannt — die
// Grenze der verfuegbaren Margin wurde uebersprungen".
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { PaperBroker } from './paper-broker.js';
import { PaperAccount } from './paper-account.js';

function baue(): { broker: PaperBroker; konto: PaperAccount } {
  const konto = new PaperAccount(10_000);
  const broker = new PaperBroker({ priceSource: 'static', konto });
  return { broker, konto };
}

describe('PaperBroker — der Hebel an der Order', () => {
  let broker: PaperBroker;
  let konto: PaperAccount;

  beforeEach(() => {
    ({ broker, konto } = baue());
    broker.setPrice('BNBUSDT', 750);
  });

  it('bucht mit dem Hebel, den die Order mitbringt', async () => {
    // Ohne setLeverage — allein aus der Order.
    await broker.placeOrder({
      symbol: 'BNBUSDT', side: 'buy', type: 'market',
      quantity: 6.47760734, leverage: 16,
    });

    const pos = konto.position('BNBUSDT', 'buy');
    expect(pos?.hebel).toBe(16);

    // 6,4776 * 750 / 16 = 303,64 — nicht 4.858 wie mit Hebel 1.
    expect(konto.stand().gebunden).toBeCloseTo(6.47760734 * 750 / 16, 1);
    expect(konto.stand().gebunden).toBeLessThan(500);
  });

  it('nimmt den Hebel der Order auch dann, wenn die Map etwas anderes sagt', async () => {
    // Die Order ist die genauere Quelle: Sie gehoert zu EINEM Plan,
    // die Map nur zum Symbol.
    await broker.setLeverage('BNBUSDT', 5);
    await broker.placeOrder({
      symbol: 'BNBUSDT', side: 'buy', type: 'market',
      quantity: 1, leverage: 16,
    });

    expect(konto.position('BNBUSDT', 'buy')?.hebel).toBe(16);
  });

  it('faellt auf setLeverage zurueck, wenn die Order nichts mitbringt', async () => {
    await broker.setLeverage('BNBUSDT', 16);
    await broker.placeOrder({
      symbol: 'BNBUSDT', side: 'buy', type: 'market', quantity: 1,
    });

    expect(konto.position('BNBUSDT', 'buy')?.hebel).toBe(16);
  });

  it('uebernimmt den Hebel einer bestehenden Position', async () => {
    await broker.placeOrder({
      symbol: 'BNBUSDT', side: 'buy', type: 'market', quantity: 1, leverage: 16,
    });

    // Nachkauf ohne Hebelangabe und mit leerer Map — eine Position
    // mit zwei Hebeln gibt es nicht.
    const frisch = new PaperBroker({ priceSource: 'static', konto });
    frisch.setPrice('BNBUSDT', 750);
    await frisch.placeOrder({
      symbol: 'BNBUSDT', side: 'buy', type: 'market', quantity: 1,
    });

    expect(konto.position('BNBUSDT', 'buy')?.hebel).toBe(16);
  });
});

// ============================================================
// Der Fall, der den Fehler ausloeste
// ============================================================

describe('PaperBroker — liegende Order ueberlebt den Neustart MIT Hebel', () => {
  it('bucht die Fuellung einer wiederhergestellten Order nicht mit Hebel 1', async () => {
    const konto = new PaperAccount(10_000);

    // --- Lauf 1: Limit-Einstieg legen, nichts fuellt ---
    const alt = new PaperBroker({ priceSource: 'static', konto });
    alt.setPrice('BNBUSDT', 760);
    await alt.setLeverage('BNBUSDT', 16);
    const gelegt = await alt.placeOrder({
      symbol: 'BNBUSDT', side: 'buy', type: 'limit',
      quantity: 6.47760734, price: 750, leverage: 16,
    });
    expect(gelegt.status).toBe('new');

    // --- Neustart: neuer Broker, leere Map ---
    const neu = new PaperBroker({ priceSource: 'static', konto });
    neu.setPrice('BNBUSDT', 749);

    const aufgenommen = neu.ordersWiederherstellen([{
      brokerOrderId: gelegt.orderId,
      clientOrderId: gelegt.clientOrderId,
      symbol: 'BNBUSDT', side: 'buy', type: 'limit',
      quantity: 6.47760734, price: 750,
      reduceOnly: false,
      // Der Hebel kommt aus dem Plan mit — ohne ihn waere es 1.
      leverage: 16,
    }]);
    expect(aufgenommen).toBe(1);

    // --- Der Kurs erreicht das Limit ---
    const gefuellt = await neu.getOrder('BNBUSDT', gelegt.orderId);
    expect(gefuellt?.status).toBe('filled');

    const pos = konto.position('BNBUSDT', 'buy');
    expect(pos?.hebel).toBe(16);

    // Das ist der Kern: 303 statt 4.854 gebunden.
    expect(konto.stand().gebunden).toBeLessThan(500);
    expect(konto.stand().gebunden).toBeCloseTo(6.47760734 * 750 / 16, 0);
  });

  it('haelt die gebundene Margin unter dem Kontostand', async () => {
    const konto = new PaperAccount(10_000);
    const broker = new PaperBroker({ priceSource: 'static', konto });

    // Die sechs Positionen vom 02.11., mit ihren echten Hebeln.
    const positionen: Array<[string, 'buy' | 'sell', number, number, number]> = [
      ['BNBUSDT', 'buy', 6.47760734, 749.38, 16],
      ['SOLUSDT', 'buy', 30.55611315, 100.89, 13],
      ['HBARUSDT', 'sell', 437403.61181691, 0.0718051850074487, 18],
      ['ETHUSDT', 'buy', 2.30319136, 2343.148, 22],
      ['XRPUSDT', 'sell', 55.59084666, 95.0664652693696, 13],
      ['HYPEUSDT', 'buy', 5.9988376701, 81.6433801908103, 18],
    ];

    for (const [symbol, seite, menge, preis, hebel] of positionen) {
      broker.setPrice(symbol, preis);
      await broker.placeOrder({
        symbol, side: seite, type: 'market', quantity: menge, leverage: hebel,
      });
    }

    const stand = konto.stand();

    // Mit richtigen Hebeln bleibt die Margin weit unter dem Kapital —
    // mit Hebel 1 waere sie bei ueber 10.000 gelandet.
    expect(stand.gebunden).toBeLessThan(stand.equity);
    expect(stand.frei).toBeGreaterThan(0);
  });

  it('meldet es, wenn gar kein Hebel bekannt ist', async () => {
    const konto = new PaperAccount(10_000);
    const broker = new PaperBroker({ priceSource: 'static', konto });
    broker.setPrice('NEUUSDT', 100);

    const warnungen: string[] = [];
    const vorher = console.warn;
    console.warn = (...args: unknown[]) => { warnungen.push(args.join(' ')); };

    try {
      await broker.placeOrder({
        symbol: 'NEUUSDT', side: 'buy', type: 'market', quantity: 1,
      });
    } finally {
      console.warn = vorher;
    }

    // Hebel 1 ist die Notannahme — aber keine stille.
    expect(konto.position('NEUUSDT', 'buy')?.hebel).toBe(1);
    expect(warnungen.join(' ')).toContain('Kein Hebel');
  });
});
