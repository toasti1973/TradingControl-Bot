// ============================================================
// Der Riegel gegen echten Handel
//
// Diese Tests sind die Zusicherung, auf die sich der Uebungsbetrieb
// stuetzt. Sie pruefen ausdruecklich den gefaehrlichen Fall: Es SIND
// Zugangsdaten hinterlegt, und trotzdem darf kein Boersenzugang
// entstehen.
// ============================================================

import { describe, it, expect } from 'vitest';
import { createBroker, BrokerRegistry } from './broker-factory.js';
import type { BotConfig } from '../config.js';

/** Konfiguration mit echten Phemex-Zugangsdaten — wie in einer .env. */
function config(ueberschreibungen: Partial<BotConfig> = {}): BotConfig {
  return {
    tcApiUrl: 'http://localhost:8080',
    tcApiKey: '',
    defaultExchange: 'paper',
    exchanges: {
      phemex: { apiKey: 'echter-schluessel', apiSecret: 'echtes-geheimnis', testnet: false },
      bybit: { apiKey: 'echter-schluessel', apiSecret: 'echtes-geheimnis' },
    },
    webUiPassword: 'x',
    webPort: 3300,
    planPollInterval: 30_000,
    pricePollInterval: 2_000,
    orderCheckInterval: 3_000,
    logLevel: 'info',
    dataDir: './data',
    telegramBotToken: '',
    telegramChatId: '',
    telegramEnabled: false,
    nurMicaBoersen: false,
    nurUebungsbetrieb: false,
    uebungsKapital: 10_000,
    uebungsWaehrung: 'USDT',
    signale: {
      webhookSecret: '', requireSignature: false, referenceCapital: 10_000,
      maxAgeSeconds: 300, autoStart: false, triggerTtlSeconds: 300,
      capitalFraction: 1, multiplier: 1, maxRiskPerTradePct: 0.02,
      maxMarginPerTradePct: 0.2, usableFreeMarginPct: 0.9,
      belowMinimum: 'drop', minRemainingFraction: 0.5,
      fallbackEquity: 0, allowFallback: false,
    },
    ...ueberschreibungen,
  };
}

describe('Uebungsbetrieb — kein Auftrag verlaesst den Bot', () => {
  it('liefert den Uebungsbroker, obwohl Phemex-Zugangsdaten hinterlegt sind', () => {
    const broker = createBroker(config({ nurUebungsbetrieb: true }), 'phemex');
    expect(broker.name).toBe('paper');
  });

  it('leitet jede genannte Boerse um — auch solche ohne Zugangsdaten', () => {
    const c = config({ nurUebungsbetrieb: true });
    for (const boerse of ['phemex', 'bybit', 'okx', 'kraken', 'binance', 'unbekannt']) {
      expect(createBroker(c, boerse).name).toBe('paper');
    }
  });

  it('leitet auch mit ausdruecklicher Marktart um', () => {
    const c = config({ nurUebungsbetrieb: true });
    expect(createBroker(c, 'phemex', 'futures').name).toBe('paper');
    expect(createBroker(c, 'bybit', 'spot').name).toBe('paper');
  });

  it('stattet das Uebungskonto mit dem eingestellten Startkapital aus', async () => {
    const broker = createBroker(
      config({ nurUebungsbetrieb: true, uebungsKapital: 2_500, uebungsWaehrung: 'USDT' }),
      'phemex',
    );
    const bestand = await broker.getBalance!();
    expect(bestand.total.USDT).toBe(2_500);
    expect(bestand.free.USDT).toBe(2_500);
  });

  it('gibt allen Boersen denselben Zugang, damit die Positionen zusammenbleiben', async () => {
    const registry = new BrokerRegistry(config({ nurUebungsbetrieb: true }));
    const a = await registry.get('phemex', 'futures');
    const b = await registry.get('bybit', 'spot');
    const c = await registry.get('paper');

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('baut auch ueber die Registry keinen echten Zugang auf', async () => {
    const registry = new BrokerRegistry(config({ nurUebungsbetrieb: true }));
    const broker = await registry.get('phemex', 'futures');
    expect(broker.name).toBe('paper');
    expect(registry.listActive().every(b => b.name === 'paper')).toBe(true);
  });
});

describe('Echthandel — der Riegel steht nur, wenn er gesetzt ist', () => {
  it('baut mit Zugangsdaten einen echten Zugang auf', () => {
    const broker = createBroker(config({ nurUebungsbetrieb: false }), 'phemex');
    expect(broker.name).not.toBe('paper');
  });

  it('verweigert ohne Zugangsdaten den Dienst, statt stillschweigend zu ueben', () => {
    expect(() => createBroker(config({ nurUebungsbetrieb: false }), 'kraken'))
      .toThrow(/keine Zugangsdaten/i);
  });

  it('liefert fuer "paper" weiterhin den Uebungsbroker', () => {
    expect(createBroker(config({ nurUebungsbetrieb: false }), 'paper').name).toBe('paper');
  });
});

describe('PaperBroker — Kontostand', () => {
  it('schweigt, wenn kein Kapital hinterlegt ist, statt 0 zu behaupten', async () => {
    // Lieber keine Zahl als eine erfundene: Eine leere Auskunft laesst
    // den CapitalService ablehnen. Eine gemeldete 0 taete das zwar auch,
    // waere aber eine Aussage ueber ein Konto, das es nicht gibt.
    const broker = createBroker(
      config({ nurUebungsbetrieb: true, uebungsKapital: 0 }), 'paper',
    );
    const bestand = await broker.getBalance!();
    expect(bestand.total).toEqual({});
    expect(bestand.free).toEqual({});
  });

  it('nennt den Stand, sobald Kapital hinterlegt ist', async () => {
    const broker = createBroker(
      config({ nurUebungsbetrieb: true, uebungsKapital: 7_500, uebungsWaehrung: 'USDT' }), 'paper',
    );
    const bestand = await broker.getBalance!();
    expect(bestand.total.USDT).toBe(7_500);
    expect(bestand.free.USDT).toBe(7_500);
    expect(bestand.used.USDT).toBe(0);
  });
});
