// ============================================================
// Kerzen fuer die Chart-Ansicht
//
// Zwei Fehler, die hier festgehalten sind, lieferten beide still das
// Falsche — ohne Absturz, ohne Fehlermeldung:
//
//   1. Die Anzahl 200 (und 300) weist Phemex ab. Der Chart blieb leer,
//      die Meldung sprach von "input arguments" und nicht von der
//      Anzahl.
//   2. "sOLUSDT" (Kasse auf OL) und "SOLUSDT" (Kontrakt auf SOL) sind
//      gross geschrieben identisch. Ein Vergleich ueber toUpperCase
//      zeigte im Chart eines SOL-Trades den Verlauf von OL.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KerzenService, ERLAUBTE_INTERVALLE } from './kerzen-service.js';
import type { Logger } from './log-service.js';

const stilleAusgabe = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger;

/**
 * Vorgetaeuschte Boerse.
 *
 * Haelt fest, mit welchem Markt und welcher Anzahl gefragt wurde — denn
 * genau daran lagen die Fehler.
 */
function boersenAttrappe(optionen: {
  maerkte?: Record<string, { id: string; symbol: string; type: string }>;
  erlaubteAnzahlen?: number[];
} = {}) {
  const anfragen: Array<{ markt: string; intervall: string; anzahl?: number }> = [];

  const maerkte = optionen.maerkte ?? {
    // Die echte Kollision bei Phemex
    'OL/USDT': { id: 'sOLUSDT', symbol: 'OL/USDT', type: 'spot' },
    'SOL/USDT': { id: 'sSOLUSDT', symbol: 'SOL/USDT', type: 'spot' },
    'SOL/USDT:USDT': { id: 'SOLUSDT', symbol: 'SOL/USDT:USDT', type: 'swap' },
    'BTC/USDT:USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT:USDT', type: 'swap' },
  };

  const zugang = {
    markets: maerkte,
    loadMarkets: async () => maerkte,
    fetchOHLCV: async (markt: string, intervall: string, _since?: number, anzahl?: number) => {
      anfragen.push({ markt, intervall, anzahl });

      if (optionen.erlaubteAnzahlen && anzahl != null &&
          !optionen.erlaubteAnzahlen.includes(anzahl)) {
        throw new Error('phemex {"code":30000,"msg":"Please double check input arguments"}');
      }

      // Der Schlusskurs verraet, welcher Markt geliefert wurde.
      const kurs = markt === 'SOL/USDT:USDT' ? 101.47
        : markt === 'OL/USDT' ? 0.005244
        : markt === 'BTC/USDT:USDT' ? 80590 : 1;

      const menge = Math.min(anzahl ?? 100, 1000);
      return Array.from({ length: menge }, (_, i) => [
        1700000000000 + i * 900000, kurs, kurs * 1.001, kurs * 0.999, kurs, 100,
      ]);
    },
  };

  return { zugang, anfragen };
}

/** Haengt die Attrappe anstelle des echten ccxt-Zugangs ein. */
function mitAttrappe(dienst: KerzenService, attrappe: ReturnType<typeof boersenAttrappe>) {
  const intern = dienst as unknown as { zugang: (b: string) => unknown };
  intern.zugang = () => attrappe.zugang;
  return dienst;
}

describe('KerzenService — Anzahl der Kerzen', () => {
  let dienst: KerzenService;

  beforeEach(() => { dienst = new KerzenService(stilleAusgabe); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('fragt Phemex nur mit Anzahlen, die es annimmt', async () => {
    // Phemex nimmt 5, 10, 50, 100, 500, 1000 — dazwischen nichts.
    const a = boersenAttrappe({ erlaubteAnzahlen: [5, 10, 50, 100, 500, 1000] });
    mitAttrappe(dienst, a);

    const r = await dienst.hole('phemex', 'BTCUSDT', '15m', 300);

    expect(r.fehler).toBeUndefined();
    expect(r.kerzen).toHaveLength(300);
    // Gefragt wurde mit 500 — der naechstgroesseren Stufe.
    expect(a.anfragen[0]!.anzahl).toBe(500);
  });

  it.each([
    [200, 500],
    [300, 500],
    [150, 500],
    [75, 100],
    [30, 50],
    [600, 1000],
  ])('rundet %i auf die Stufe %i auf', async (gewuenscht, erwartet) => {
    const a = boersenAttrappe({ erlaubteAnzahlen: [5, 10, 50, 100, 500, 1000] });
    mitAttrappe(dienst, a);

    await dienst.hole('phemex', 'BTCUSDT', '15m', gewuenscht);
    expect(a.anfragen[0]!.anzahl).toBe(erwartet);
  });

  it('schneidet auf die gewuenschte Anzahl zu, nicht auf die angefragte', async () => {
    const a = boersenAttrappe({ erlaubteAnzahlen: [5, 10, 50, 100, 500, 1000] });
    mitAttrappe(dienst, a);

    const r = await dienst.hole('phemex', 'BTCUSDT', '15m', 120);
    expect(r.kerzen).toHaveLength(120);
  });

  it('laesst andere Boersen in Ruhe — sie nehmen beliebige Anzahlen', async () => {
    const a = boersenAttrappe();
    mitAttrappe(dienst, a);

    await dienst.hole('bybit', 'BTCUSDT', '15m', 300);
    expect(a.anfragen[0]!.anzahl).toBe(300);
  });
});

describe('KerzenService — der richtige Markt', () => {
  let dienst: KerzenService;

  beforeEach(() => { dienst = new KerzenService(stilleAusgabe); });

  it('nimmt bei SOLUSDT den SOL-Kontrakt, nicht die OL-Kasse', async () => {
    // Der eigentliche Fund: "sOLUSDT" (OL, Kasse) und "SOLUSDT"
    // (SOL, Kontrakt) sind gross geschrieben gleich.
    const a = boersenAttrappe();
    mitAttrappe(dienst, a);

    const r = await dienst.hole('phemex', 'SOLUSDT', '15m', 100, 'futures');

    expect(r.markt).toBe('SOL/USDT:USDT');
    // Der Schlusskurs beweist es: SOL steht bei ~101, OL bei ~0,005.
    expect(r.kerzen[0]!.close).toBeCloseTo(101.47, 2);
  });

  it('nimmt bei Spot-Plaenen den Kassamarkt', async () => {
    const a = boersenAttrappe();
    mitAttrappe(dienst, a);

    const r = await dienst.hole('phemex', 'SOLUSDT', '15m', 100, 'spot');
    expect(r.markt).toBe('SOL/USDT');
  });

  it('loest einen gewoehnlichen Kontrakt auf', async () => {
    const a = boersenAttrappe();
    mitAttrappe(dienst, a);

    const r = await dienst.hole('phemex', 'BTCUSDT', '15m', 100, 'futures');
    expect(r.markt).toBe('BTC/USDT:USDT');
    expect(r.kerzen[0]!.close).toBe(80590);
  });

  it('weicht auf die Kasse aus, wenn es keinen Kontrakt gibt', async () => {
    const a = boersenAttrappe({
      maerkte: {
        'FOO/USDT': { id: 'sFOOUSDT', symbol: 'FOO/USDT', type: 'spot' },
      },
    });
    mitAttrappe(dienst, a);

    const r = await dienst.hole('phemex', 'FOOUSDT', '15m', 100, 'futures');
    expect(r.markt).toBe('FOO/USDT');
  });
});

describe('KerzenService — Verhalten im Fehlerfall', () => {
  let dienst: KerzenService;

  beforeEach(() => { dienst = new KerzenService(stilleAusgabe); });

  it('liefert eine leere Liste statt zu werfen', async () => {
    const intern = dienst as unknown as { zugang: (b: string) => unknown };
    intern.zugang = () => ({
      markets: {},
      loadMarkets: async () => ({}),
      fetchOHLCV: async () => { throw new Error('Boerse nicht erreichbar'); },
    });

    const r = await dienst.hole('phemex', 'BTCUSDT', '15m', 100);
    expect(r.kerzen).toEqual([]);
    expect(r.fehler).toContain('nicht erreichbar');
  });

  it('leitet den Uebungsbetrieb auf Phemex um', async () => {
    const a = boersenAttrappe();
    mitAttrappe(dienst, a);

    const r = await dienst.hole('paper', 'BTCUSDT', '15m', 100);
    expect(r.quelle).toBe('phemex');
  });

  it('bietet die ueblichen Zeitraster an', () => {
    expect(ERLAUBTE_INTERVALLE).toContain('15m');
    expect(ERLAUBTE_INTERVALLE).toContain('1h');
    expect(ERLAUBTE_INTERVALLE).toContain('1d');
  });
});
