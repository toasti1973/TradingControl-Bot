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
    // Rueckkanal aus: Diese Tests pruefen die Broker-Wahl, und ein
    // eingerichteter Meldeweg hat damit nichts zu tun.
    tcRueckkanalUrl: '',
    tcRueckkanalToken: '',
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

describe('Echthandel — jede Boerse entscheidet fuer sich', () => {
  // Der globale Riegel ist entfallen; jede Boerse traegt ihre eigene
  // Einstellung. Damit wird die Vorgabe zur tragenden Sicherung —
  // deshalb steht sie hier an erster Stelle.
  it('uebt, solange niemand ausdruecklich etwas anderes sagt', () => {
    // Zugangsdaten sind hinterlegt. Trotzdem Uebungsbroker: Die
    // Auskunft, ob diese Boerse echt handeln darf, fehlt.
    const broker = createBroker(config({ nurUebungsbetrieb: false }), 'phemex');
    expect(broker.name).toBe('paper');
  });

  it('baut einen echten Zugang nur bei ausdruecklicher Freigabe', () => {
    const broker = createBroker(
      config({ nurUebungsbetrieb: false }), 'phemex', undefined, undefined, false,
    );
    expect(broker.name).not.toBe('paper');
  });

  it('verweigert ohne Zugangsdaten den Dienst, statt stillschweigend zu ueben', () => {
    // Freigegeben, aber keine Zugangsdaten: Das ist ein Fehler in der
    // Einrichtung und gehoert gesagt. Still zu ueben hiesse, einen
    // Plan laufen zu lassen, von dem der Nutzer annimmt, er handle.
    expect(() => createBroker(
      config({ nurUebungsbetrieb: false }), 'kraken', undefined, undefined, false,
    )).toThrow(/keine Zugangsdaten/i);
  });

  it('liefert fuer "paper" weiterhin den Uebungsbroker', () => {
    expect(createBroker(
      config({ nurUebungsbetrieb: false }), 'paper', undefined, undefined, false,
    ).name).toBe('paper');
  });

  // Der alte Schalter bleibt als Rueckfall: Eine bestehende
  // Einrichtung, die ihn gesetzt hat, soll durch das Update nicht
  // ploetzlich echt handeln.
  it('laesst den globalen Schalter alles uebersteuern', () => {
    const broker = createBroker(
      config({ nurUebungsbetrieb: true }), 'phemex', undefined, undefined, false,
    );
    expect(broker.name).toBe('paper');
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

// ============================================================
// Zugangsdaten, die nach dem Start hinzukommen
//
// Die Registry hält die Konfiguration, mit der der Server startete.
// Wer danach einen Börsen-Schlüssel hinterlegt, ändert den KeyStore
// — nicht aber das, womit die Registry arbeitet.
//
// Am 04.11.2026 führte das dazu, dass das Umstellen auf echten
// Handel mit „keine Zugangsdaten hinterlegt" abgelehnt wurde,
// obwohl Schlüssel und Secret im KeyStore lagen. Erst ein Neustart
// half.
//
// `reconfigure()` gab es bereits — sie wurde nur nirgends gerufen.
// ============================================================

describe('BrokerRegistry — Zugangsdaten nach dem Start', () => {
  it('kennt ohne Zugangsdaten keine', () => {
    const r = new BrokerRegistry(config({ nurUebungsbetrieb: false }));
    expect(r.hatZugangsdaten('kraken')).toBe(false);
  });

  it('erkennt hinterlegte Zugangsdaten', () => {
    const r = new BrokerRegistry(config({ nurUebungsbetrieb: false }));
    // `config()` legt Phemex mit Schlüssel an.
    expect(r.hatZugangsdaten('phemex')).toBe(true);
  });

  it('nimmt neue Zugangsdaten über reconfigure an', async () => {
    const r = new BrokerRegistry(config({ nurUebungsbetrieb: false }));
    expect(r.hatZugangsdaten('kraken')).toBe(false);

    // So kommt ein eben erst eingegebener Schlüssel an.
    const mitKraken = config({ nurUebungsbetrieb: false });
    mitKraken.exchanges.kraken = { apiKey: 'k', apiSecret: 's' };
    await r.reconfigure(mitKraken);

    expect(r.hatZugangsdaten('kraken')).toBe(true);
  });

  it('hält "paper" immer für einsatzbereit', () => {
    const r = new BrokerRegistry(config({}));
    expect(r.hatZugangsdaten('paper')).toBe(true);
  });
});
