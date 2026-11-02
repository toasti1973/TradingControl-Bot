// ============================================================
// Hedge-Modus im Echthandel
//
// Im Hedge-Modus fuehrt die Boerse zu einem Symbol einen Long UND
// einen Short. Die Orderseite genuegt dann nicht, um zu sagen, welche
// gemeint ist: Ein Verkauf kann einen Long schliessen ODER einen Short
// eroeffnen.
//
// Fehlt die Angabe, landet die Order im falschen Topf oder wird
// abgewiesen. Im Uebungsbetrieb faellt das nicht auf — der eigene
// Broker braucht sie nicht. Beim ersten echten Trade schon.
//
// ccxt reicht solche Felder unveraendert durch; jede Boerse nennt sie
// anders. Diese Uebersetzung ist deshalb Handarbeit und gehoert
// geprueft.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CcxtBroker } from './ccxt-broker.js';

/**
 * Faengt den Aufruf an ccxt ab und haelt die Parameter fest.
 *
 * Geprueft wird, was BEI DER BOERSE ankaeme — nicht, was der Broker
 * intern denkt.
 */
function brokerMit(boersenId: string) {
  const aufrufe: Array<Record<string, unknown>> = [];

  const broker = new CcxtBroker({
    exchange: boersenId,
    apiKey: 'test', apiSecret: 'test',
    marketType: 'futures',
  }) as unknown as {
    exchange: Record<string, unknown>;
    ensureMarkets(): Promise<void>;
    placeOrder(p: Record<string, unknown>): Promise<unknown>;
  };

  broker.exchange = {
    id: boersenId,
    loadMarkets: async () => ({}),
    markets: {},
    createOrder: async (
      _symbol: string, _type: string, _side: string,
      _menge: number, _preis: number | undefined,
      params: Record<string, unknown>,
    ) => {
      aufrufe.push(params);
      return {
        id: 'x', clientOrderId: '', symbol: 'BTC/USDT:USDT',
        side: 'buy', type: 'limit', amount: 1, price: 100,
        status: 'open', filled: 0, average: 0, timestamp: 0,
      };
    },
  };
  broker.ensureMarkets = async () => {};

  return { broker, aufrufe };
}

describe('CcxtBroker — Hedge-Modus', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  async function order(boersenId: string, seite: 'long' | 'short') {
    const { broker, aufrufe } = brokerMit(boersenId);
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: seite === 'long' ? 'buy' : 'sell',
      type: 'limit', quantity: 1, price: 100,
      reduceOnly: false, positionSide: seite,
    });
    return aufrufe[0]!;
  }

  it('schickt Phemex posSide in Grossschreibung', async () => {
    // Phemex erwartet "Long"/"Short" — kleingeschrieben wird es
    // abgewiesen.
    expect(await order('phemex', 'long')).toMatchObject({ posSide: 'Long' });
    expect(await order('phemex', 'short')).toMatchObject({ posSide: 'Short' });
  });

  it('schickt Bybit positionIdx als Zahl', async () => {
    // 1 = Long, 2 = Short. Die 0 waere der One-Way-Modus.
    expect(await order('bybit', 'long')).toMatchObject({ positionIdx: 1 });
    expect(await order('bybit', 'short')).toMatchObject({ positionIdx: 2 });
  });

  it('schickt Binance positionSide in Versalien', async () => {
    expect(await order('binance', 'long')).toMatchObject({ positionSide: 'LONG' });
    expect(await order('binance', 'short')).toMatchObject({ positionSide: 'SHORT' });
  });

  it('schickt OKX posSide kleingeschrieben', async () => {
    expect(await order('okx', 'long')).toMatchObject({ posSide: 'long' });
    expect(await order('okx', 'short')).toMatchObject({ posSide: 'short' });
  });

  it('schickt einer Boerse ohne bekanntes Feld gar nichts', async () => {
    // Fuer BingX ist hier keine Uebersetzung hinterlegt. Lieber
    // nichts schicken als ein erfundenes Feld: Wird es ignoriert,
    // liefe die Order im Netting-Modus und knabberte an der
    // Gegenposition. Wird es abgewiesen, faellt es sofort auf —
    // besser als eine stillschweigend falsch gebuchte Order.
    const params = await order('bingx', 'long');
    expect(params['posSide']).toBeUndefined();
    expect(params['positionIdx']).toBeUndefined();
    expect(params['positionSide']).toBeUndefined();
  });

  it('laesst die Angabe weg, wenn der Plan keine nennt', async () => {
    const { broker, aufrufe } = brokerMit('phemex');
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit',
      quantity: 1, price: 100, reduceOnly: false,
    });

    expect(aufrufe[0]!['posSide']).toBeUndefined();
  });

  it('traegt reduceOnly weiterhin mit', async () => {
    const { broker, aufrufe } = brokerMit('phemex');
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'limit',
      quantity: 1, price: 100, reduceOnly: true, positionSide: 'long',
    });

    // Beides zusammen beschreibt den Take-Profit auf einen Long:
    // schliessend, und zwar die Long-Position.
    expect(aufrufe[0]).toMatchObject({ reduceOnly: true, posSide: 'Long' });
  });
});
