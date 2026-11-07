// ============================================================
// Positionsmodus im Echthandel
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
//
// **Und der Modus selbst gehoert geprueft.** Am 05.11.2026 schickte
// der Bot Phemex die One-Way-Form, obwohl das Konto im Hedge-Modus
// stand. `setLeverage` scheiterte (Hebel 20 statt 4), `cancelOrder`
// scheiterte (zwei Einstiege lagen unbeaufsichtigt an der Boerse).
// Die Tests weiter unten decken genau diese Kette ab.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CcxtBroker } from './ccxt-broker.js';

type Attrappe = {
  exchange: Record<string, unknown>;
  ensureMarkets(): Promise<void>;
  placeOrder(p: Record<string, unknown>): Promise<unknown>;
  cancelOrder(symbol: string, id: string, seite?: 'long' | 'short'): Promise<void>;
  setLeverage(symbol: string, hebel: number): Promise<void>;
  positionsModusVon(symbol: string): 'hedge' | 'oneway' | null;
};

/**
 * Faengt den Aufruf an ccxt ab und haelt die Parameter fest.
 *
 * Geprueft wird, was BEI DER BOERSE ankaeme — nicht, was der Broker
 * intern denkt.
 *
 * `modus` bestimmt, was die Boerse auf `fetchPositionMode` antwortet;
 * `undefined` heisst "keine Auskunft", wie bei Phemex in ccxt.
 */
function brokerMit(boersenId: string, modus?: 'hedge' | 'oneway') {
  const aufrufe: Array<Record<string, unknown>> = [];
  const hebelAufrufe: Array<Record<string, unknown>> = [];
  const stornoAufrufe: Array<Record<string, unknown>> = [];

  const broker = new CcxtBroker({
    exchange: boersenId,
    apiKey: 'test', apiSecret: 'test',
    marketType: 'futures',
  }) as unknown as Attrappe;

  broker.exchange = {
    id: boersenId,
    loadMarkets: async () => ({}),
    markets: {},
    // Wie bei Phemex: `fetchPositionMode` gibt es nicht, aber
    // `fetchPositions` traegt den Modus im Feld `hedged`.
    ...(modus
      ? { fetchPositions: async (symbole?: string[]) => [
          { symbol: symbole?.[0] ?? 'BTC/USDT:USDT', hedged: modus === 'hedge' },
        ] }
      : {}),
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
    cancelOrder: async (_id: string, _symbol: string, params: Record<string, unknown>) => {
      stornoAufrufe.push(params ?? {});
      return {};
    },
    setLeverage: async (_hebel: number, _symbol: string, params: Record<string, unknown>) => {
      hebelAufrufe.push(params ?? {});
      return {};
    },
  };
  broker.ensureMarkets = async () => {};

  return { broker, aufrufe, hebelAufrufe, stornoAufrufe };
}

describe('CcxtBroker — Hedge-Modus', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  async function order(boersenId: string, seite: 'long' | 'short') {
    const { broker, aufrufe } = brokerMit(boersenId, 'hedge');
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

  // Ein Einstieg ist eindeutig: Ein Kauf eroeffnet einen Long.
  // Deshalb wird die Richtung erschlossen, statt die Order ohne Feld
  // hinauszuschicken — im Hedge-Modus waere sie sonst abgewiesen
  // worden oder in den falschen Topf gelaufen.
  it('erschliesst die Richtung beim Einstieg, wenn der Plan keine nennt', async () => {
    const { broker, aufrufe } = brokerMit('phemex', 'hedge');
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit',
      quantity: 1, price: 100, reduceOnly: false,
    });

    expect(aufrufe[0]).toMatchObject({ posSide: 'Long' });
  });

  // Bei `reduceOnly` ist sie NICHT eindeutig: Ein Verkauf schliesst
  // einen Long oder eroeffnet einen Short. Hier zu raten hiesse,
  // moeglicherweise die Gegenposition anzufassen.
  it('erschliesst nichts bei reduceOnly ohne Angabe', async () => {
    const { broker, aufrufe } = brokerMit('phemex', 'hedge');
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'limit',
      quantity: 1, price: 100, reduceOnly: true,
    });

    expect(aufrufe[0]!['posSide']).toBeUndefined();
  });

  it('traegt reduceOnly weiterhin mit', async () => {
    const { broker, aufrufe } = brokerMit('phemex', 'hedge');
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'sell', type: 'limit',
      quantity: 1, price: 100, reduceOnly: true, positionSide: 'long',
    });

    // Beides zusammen beschreibt den Take-Profit auf einen Long:
    // schliessend, und zwar die Long-Position.
    expect(aufrufe[0]).toMatchObject({ reduceOnly: true, posSide: 'Long' });
  });

  it('gibt setLeverage im Hedge-Modus hedged mit', async () => {
    // Ohne `hedged: true` schickt ccxt `leverageRr` statt
    // `longLeverageRr`/`shortLeverageRr` — genau das wies Phemex ab.
    const { broker, hebelAufrufe } = brokerMit('phemex', 'hedge');
    await broker.setLeverage('BTCUSDT', 4);

    expect(hebelAufrufe[0]).toMatchObject({ hedged: true });
  });

  // ccxt setzt bei Phemex von sich aus `posSide: "Merged"`, wenn
  // keines uebergeben wird. Ein `hedged: true` aendert daran nichts —
  // das wertet ccxt nur in `setLeverage` aus. Deshalb muss hier die
  // Richtung mit, und genau daran scheiterte der erste Behebungs-
  // versuch zum Vorfall vom 05.11.2026.
  it('gibt cancelOrder im Hedge-Modus die Richtung mit', async () => {
    const { broker, stornoAufrufe } = brokerMit('phemex', 'hedge');
    await broker.cancelOrder('BTCUSDT', 'order-1', 'long');

    expect(stornoAufrufe[0]).toMatchObject({ posSide: 'Long' });
  });

  it('gibt beim Short die Short-Richtung mit', async () => {
    const { broker, stornoAufrufe } = brokerMit('phemex', 'hedge');
    await broker.cancelOrder('BTCUSDT', 'order-1', 'short');

    expect(stornoAufrufe[0]).toMatchObject({ posSide: 'Short' });
  });

  // Ohne Richtung bleibt es bei ccxt's Voreinstellung. Eine geratene
  // Richtung waere hier schlimmer: Sie koennte die Order der
  // Gegenposition treffen.
  it('schickt ohne Richtung kein posSide', async () => {
    const { broker, stornoAufrufe } = brokerMit('phemex', 'hedge');
    await broker.cancelOrder('BTCUSDT', 'order-1');

    expect(stornoAufrufe[0]!['posSide']).toBeUndefined();
  });
});

describe('CcxtBroker — One-Way-Modus', () => {
  // Eine Boerse im One-Way-Modus will das Feld nicht weggelassen,
  // sondern mit ihrem Sammelwert belegt sehen. Ein fehlendes Feld und
  // ein Feld mit Sammelwert sind fuer sie nicht dasselbe.
  it('schickt den Sammelwert je Boerse', async () => {
    for (const [boerse, erwartet] of [
      ['phemex', { posSide: 'Merged' }],
      ['bybit', { positionIdx: 0 }],
      ['binance', { positionSide: 'BOTH' }],
      ['okx', { posSide: 'net' }],
    ] as const) {
      const { broker, aufrufe } = brokerMit(boerse, 'oneway');
      await broker.placeOrder({
        symbol: 'BTCUSDT', side: 'buy', type: 'limit',
        quantity: 1, price: 100, reduceOnly: false, positionSide: 'long',
      });
      expect(aufrufe[0]).toMatchObject(erwartet);
    }
  });

  it('gibt setLeverage kein hedged mit', async () => {
    const { broker, hebelAufrufe } = brokerMit('phemex', 'oneway');
    await broker.setLeverage('BTCUSDT', 4);

    expect(hebelAufrufe[0]!['hedged']).toBeUndefined();
  });

  // Ohne `positionSide` im Plan bleibt es auch im One-Way-Modus bei
  // nichts: Der Sammelwert ist dort die Voreinstellung der Boerse.
  it('schickt ohne Angabe im Plan kein Feld', async () => {
    const { broker, aufrufe } = brokerMit('phemex', 'oneway');
    await broker.placeOrder({
      symbol: 'BTCUSDT', side: 'buy', type: 'limit',
      quantity: 1, price: 100, reduceOnly: false,
    });

    expect(aufrufe[0]!['posSide']).toBeUndefined();
  });
});

describe('CcxtBroker — den Modus aus dem Fehler lernen', () => {
  /**
   * Eine Boerse, die keine Auskunft gibt und die One-Way-Form
   * ablehnt — genau Phemex am 05.11.2026.
   */
  function zickigePhemex() {
    const versuche: Array<Record<string, unknown>> = [];
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe;

    broker.exchange = {
      id: 'phemex',
      loadMarkets: async () => ({}),
      markets: {},
      // Kein `fetchPositionMode` — ccxt meldet es fuer Phemex nicht
      // einmal als unterstuetzt.
      setLeverage: async (_h: number, _s: string, params: Record<string, unknown>) => {
        versuche.push(params ?? {});
        if (!params?.['hedged']) {
          throw new Error('phemex {"code":20004,"msg":"TE_ERR_INCONSISTENT_POS_MODE","data":null}');
        }
        return {};
      },
      cancelOrder: async (_i: string, _s: string, params: Record<string, unknown>) => {
        versuche.push(params ?? {});
        // Wie die echte: Ohne `posSide` setzt ccxt "Merged", und ein
        // Hedge-Konto weist das ab.
        if (!params?.['posSide']) {
          throw new Error('phemex {"code":20004,"msg":"TE_ERR_INCONSISTENT_POS_MODE","data":null}');
        }
        return {};
      },
    };
    broker.ensureMarkets = async () => {};
    return { broker, versuche };
  }

  it('wiederholt setLeverage in der anderen Form und merkt sie sich', async () => {
    const { broker, versuche } = zickigePhemex();

    // Der Hebel wird gesetzt, obwohl der erste Versuch abgewiesen wird.
    await expect(broker.setLeverage('BTCUSDT', 4)).resolves.toBeUndefined();

    expect(versuche).toHaveLength(2);
    expect(versuche[0]!['hedged']).toBeUndefined();   // One-Way zuerst
    expect(versuche[1]).toMatchObject({ hedged: true });
    expect(broker.positionsModusVon('BTCUSDT')).toBe('hedge');

    // Und der naechste Aufruf liegt gleich richtig — kein zweiter
    // Fehlversuch mehr.
    versuche.length = 0;
    await broker.setLeverage('BTCUSDT', 4);
    expect(versuche).toHaveLength(1);
    expect(versuche[0]).toMatchObject({ hedged: true });
  });

  // Das ist der schwerste der drei Ausfaelle: Ein Bot, der nicht
  // aufraeumen kann, hinterlaesst Orders, von denen niemand weiss.
  it('bekommt cancelOrder trotz Modusfehler durch', async () => {
    const { broker, versuche } = zickigePhemex();

    await expect(broker.cancelOrder('BTCUSDT', 'order-1', 'long')).resolves.toBeUndefined();

    // Erst One-Way (kein posSide), dann Hedge mit Richtung.
    expect(versuche).toHaveLength(2);
    expect(versuche[0]!['posSide']).toBeUndefined();
    expect(versuche[1]).toMatchObject({ posSide: 'Long' });
    expect(broker.positionsModusVon('BTCUSDT')).toBe('hedge');
  });

  it('reicht einen Fehler weiter, der nichts mit dem Modus zu tun hat', async () => {
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe;
    let versuche = 0;
    broker.exchange = {
      id: 'phemex', loadMarkets: async () => ({}), markets: {},
      cancelOrder: async () => { versuche++; throw new Error('Rate limit exceeded'); },
    };
    broker.ensureMarkets = async () => {};

    // Nicht wiederholen und nicht verschlucken: Ein Rate-Limit wird
    // durch einen anderen Positionsmodus nicht freundlicher.
    await expect(broker.cancelOrder('BTCUSDT', 'x')).rejects.toThrow('Rate limit');
    expect(versuche).toBe(1);
  });

  it('merkt sich nichts, wenn auch die andere Form scheitert', async () => {
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe;
    broker.exchange = {
      id: 'phemex', loadMarkets: async () => ({}), markets: {},
      setLeverage: async () => {
        throw new Error('phemex {"code":20004,"msg":"TE_ERR_INCONSISTENT_POS_MODE"}');
      },
    };
    broker.ensureMarkets = async () => {};

    await expect(broker.setLeverage('BTCUSDT', 4)).rejects.toThrow();

    // Werden beide Formen abgewiesen, ist der Positionsmodus nicht die
    // Ursache. Eine falsche Lehre waere schlimmer als keine.
    expect(broker.positionsModusVon('BTCUSDT')).toBeNull();
  });
});

describe('CcxtBroker — eine Order, die es nicht gibt', () => {
  /**
   * Das ist kein Randfall, sondern der Normalfall nach jedem Eingriff
   * von Hand. Am 05.11.2026 entfernte der Nutzer zwei Einstiege
   * selbst bei Phemex; der Bot versuchte danach alle zwei Sekunden,
   * sie zurueckzunehmen, und vermerkte sie nie als storniert.
   */
  function brokerMitFehler(text: string, typName?: string) {
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe;
    let versuche = 0;

    class OrderNotFound extends Error {}
    broker.exchange = {
      id: 'phemex', loadMarkets: async () => ({}), markets: {},
      cancelOrder: async () => {
        versuche++;
        throw typName === 'OrderNotFound' ? new OrderNotFound(text) : new Error(text);
      },
    };
    broker.ensureMarkets = async () => {};
    return { broker, zaehler: () => versuche };
  }

  it('verbucht Phemex OM_ORDER_NOT_FOUND als zurueckgenommen', async () => {
    const { broker } = brokerMitFehler(
      'phemex {"code":10002,"msg":"OM_ORDER_NOT_FOUND","data":null}',
    );

    await expect(broker.cancelOrder('BTCUSDT', 'weg', 'long')).resolves.toBeUndefined();
  });

  it('erkennt den ccxt-Typ OrderNotFound', async () => {
    const { broker } = brokerMitFehler('irgendein Text', 'OrderNotFound');

    await expect(broker.cancelOrder('BTCUSDT', 'weg')).resolves.toBeUndefined();
  });

  it('erkennt die ueblichen Formulierungen anderer Boersen', async () => {
    for (const text of ['Order not found', 'Unknown order sent', 'order does not exist']) {
      const { broker } = brokerMitFehler(text);
      await expect(broker.cancelOrder('BTCUSDT', 'weg')).resolves.toBeUndefined();
    }
  });

  // Nicht in eine Schleife laufen: Der Fehler wird beim ersten Mal
  // richtig gedeutet, nicht nach mehreren Versuchen.
  it('versucht es nicht erneut', async () => {
    const { broker, zaehler } = brokerMitFehler(
      'phemex {"code":10002,"msg":"OM_ORDER_NOT_FOUND"}',
    );

    await broker.cancelOrder('BTCUSDT', 'weg', 'long');

    expect(zaehler()).toBe(1);
  });
});

describe('CcxtBroker — den Modus vorab erfragen', () => {
  /**
   * Eine Boerse, die Auskunft gibt — und zaehlt, wie oft gefragt wird.
   *
   * Nachgebildet ist Phemex: kein `fetchPositionMode` (ccxt wirft dort
   * `NotSupported`), aber `fetchPositions` mit dem Feld `hedged`, das
   * ccxt aus `posMode` ableitet.
   */
  function boerseMitAuskunft(modi: Record<string, boolean>) {
    const abfragen: string[] = [];
    const versuche: Array<Record<string, unknown>> = [];
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe & { positionsModi(): unknown[] };

    broker.exchange = {
      id: 'phemex',
      loadMarkets: async () => ({}),
      markets: {},
      fetchPositions: async (symbole?: string[]) => {
        const s = symbole?.[0] ?? '';
        abfragen.push(s);
        const hedged = modi[s];
        return hedged === undefined ? [] : [{ symbol: s, hedged }];
      },
      setLeverage: async (_h: number, _s: string, params: Record<string, unknown>) => {
        versuche.push(params ?? {});
        return {};
      },
    };
    broker.ensureMarkets = async () => {};
    return { broker, abfragen, versuche };
  }

  // Der eigentliche Gewinn: Die erste Order liegt gleich richtig,
  // statt erst abgewiesen zu werden.
  it('liegt beim ersten Aufruf richtig, ohne Fehlversuch', async () => {
    const { broker, versuche } = boerseMitAuskunft({ 'BTC/USDT:USDT': true });

    await broker.setLeverage('BTCUSDT', 4);

    expect(versuche).toHaveLength(1);
    expect(versuche[0]).toMatchObject({ hedged: true });
    expect(broker.positionsModusVon('BTCUSDT')).toBe('hedge');
  });

  it('erkennt auch den One-Way-Modus', async () => {
    const { broker, versuche } = boerseMitAuskunft({ 'BTC/USDT:USDT': false });

    await broker.setLeverage('BTCUSDT', 4);

    expect(versuche[0]!['hedged']).toBeUndefined();
    expect(broker.positionsModusVon('BTCUSDT')).toBe('oneway');
  });

  // Phemex stellt den Modus je Symbol ein. Ein gemeinsamer Merker
  // waere fuer das eine Symbol richtig und fuer das andere falsch.
  it('fuehrt den Modus je Symbol getrennt', async () => {
    const { broker } = boerseMitAuskunft({
      'BTC/USDT:USDT': true,
      'ETH/USDT:USDT': false,
    });

    await broker.setLeverage('BTCUSDT', 4);
    await broker.setLeverage('ETHUSDT', 4);

    expect(broker.positionsModusVon('BTCUSDT')).toBe('hedge');
    expect(broker.positionsModusVon('ETHUSDT')).toBe('oneway');
  });

  it('fragt je Symbol nur einmal', async () => {
    const { broker, abfragen } = boerseMitAuskunft({ 'BTC/USDT:USDT': true });

    await broker.setLeverage('BTCUSDT', 4);
    await broker.setLeverage('BTCUSDT', 4);
    await broker.setLeverage('BTCUSDT', 4);

    expect(abfragen).toEqual(['BTC/USDT:USDT']);
  });

  // Schweigt die Boerse, bleibt der Lernmechanismus — er war vorher
  // der einzige Weg und muss weiter tragen.
  it('fragt auch ohne Auskunft nicht zweimal', async () => {
    const { broker, abfragen } = boerseMitAuskunft({});   // leere Antwort

    await broker.setLeverage('BTCUSDT', 4);
    await broker.setLeverage('BTCUSDT', 4);

    expect(abfragen).toHaveLength(1);
    expect(broker.positionsModusVon('BTCUSDT')).toBeNull();
  });

  it('laesst sich von einer scheiternden Abfrage nicht aufhalten', async () => {
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe;
    const versuche: Array<Record<string, unknown>> = [];
    broker.exchange = {
      id: 'phemex', loadMarkets: async () => ({}), markets: {},
      fetchPositions: async () => { throw new Error('403 Forbidden'); },
      setLeverage: async (_h: number, _s: string, p: Record<string, unknown>) => {
        versuche.push(p ?? {});
        return {};
      },
    };
    broker.ensureMarkets = async () => {};

    // Der Hebel wird trotzdem gesetzt — mit der One-Way-Annahme, und
    // bei einem Widerspruch greift die Wiederholung.
    await expect(broker.setLeverage('BTCUSDT', 4)).resolves.toBeUndefined();
    expect(versuche).toHaveLength(1);
  });

  // Im Hedge-Modus liefert Phemex zwei Positionen je Symbol, eine je
  // Richtung — und dazu moeglicherweise fremde Symbole.
  it('nimmt den Eintrag zum richtigen Symbol', async () => {
    const broker = new CcxtBroker({
      exchange: 'phemex', apiKey: 't', apiSecret: 't', marketType: 'futures',
    }) as unknown as Attrappe;
    broker.exchange = {
      id: 'phemex', loadMarkets: async () => ({}), markets: {},
      fetchPositions: async () => [
        { symbol: 'SOL/USDT:USDT', hedged: false },
        { symbol: 'BTC/USDT:USDT', hedged: true },
        { symbol: 'BTC/USDT:USDT', hedged: true },
      ],
      setLeverage: async () => ({}),
    };
    broker.ensureMarkets = async () => {};

    await broker.setLeverage('BTCUSDT', 4);

    expect(broker.positionsModusVon('BTCUSDT')).toBe('hedge');
  });
});
