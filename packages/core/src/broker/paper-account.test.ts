import { describe, it, expect } from 'vitest';
import { PaperAccount, PHEMEX_FUTURES_GEBUEHREN } from './paper-account.js';
import type { Buchung } from './paper-account.js';

/** Konto ohne Gebuehren — isoliert die Ergebnisrechnung. */
function ohneGebuehren(start = 10_000) {
  return new PaperAccount(start, 'USDT', { taker: 0, maker: 0 });
}

describe('PaperAccount — Ergebnisrechnung', () => {
  it('beginnt mit dem Startkapital', () => {
    const k = ohneGebuehren(10_000);
    const s = k.stand();
    expect(s.equity).toBe(10_000);
    expect(s.frei).toBe(10_000);
    expect(s.realisiert).toBe(0);
    expect(s.trades).toBe(0);
  });

  it('bucht bei einer Eroeffnung noch kein Ergebnis', () => {
    const k = ohneGebuehren();
    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10,
    });

    expect(r.realisiert).toBe(0);
    expect(k.stand().equity).toBe(10_000);
    expect(k.stand().trades).toBe(0);
  });

  it('rechnet den Gewinn eines Long richtig ab', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    const r = k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 52_000, orderArt: 'market' });

    // 0.1 * (52.000 − 50.000) = 200
    expect(r.realisiert).toBeCloseTo(200, 6);
    expect(k.stand().equity).toBeCloseTo(10_200, 6);
    expect(k.stand().trades).toBe(1);
    expect(k.stand().gewinne).toBe(1);
  });

  it('rechnet den Verlust eines Long richtig ab', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 48_000, orderArt: 'market' });

    expect(k.stand().realisiert).toBeCloseTo(-200, 6);
    expect(k.stand().equity).toBeCloseTo(9_800, 6);
    expect(k.stand().verluste).toBe(1);
  });

  it('rechnet einen Short gegenlaeufig ab', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'ETHUSDT', seite: 'sell', menge: 2, preis: 3_000, orderArt: 'limit', hebel: 5 });
    k.ordnungAusgefuehrt({ symbol: 'ETHUSDT', seite: 'buy', menge: 2, preis: 2_900, orderArt: 'market' });

    // Short gewinnt, wenn der Preis faellt: 2 * (3.000 − 2.900) = 200
    expect(k.stand().realisiert).toBeCloseTo(200, 6);
  });

  it('mittelt den Einstieg bei einem gestaffelten Einstieg', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 48_000, orderArt: 'limit', hebel: 10 });

    const pos = k.offenePositionen()[0]!;
    expect(pos.menge).toBeCloseTo(0.2, 10);
    expect(pos.einstiegspreis).toBeCloseTo(49_000, 6);

    // Schliessen bei 50.000: 0.2 * (50.000 − 49.000) = 200
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.2, preis: 50_000, orderArt: 'market' });
    expect(k.stand().realisiert).toBeCloseTo(200, 6);
  });

  it('rechnet Teilschliessungen einzeln ab', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.2, preis: 50_000, orderArt: 'limit', hebel: 10 });

    // TP1: 40 % bei 52.000 → 0.08 * 2.000 = 160
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.08, preis: 52_000, orderArt: 'market' });
    expect(k.stand().realisiert).toBeCloseTo(160, 6);
    expect(k.offenePositionen()[0]!.menge).toBeCloseTo(0.12, 10);

    // TP2: Rest bei 55.000 → 0.12 * 5.000 = 600
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.12, preis: 55_000, orderArt: 'market' });
    expect(k.stand().realisiert).toBeCloseTo(760, 6);
    expect(k.offenePositionen()).toHaveLength(0);
    expect(k.stand().trades).toBe(2);
  });

  it('dreht die Position, wenn die Gegenorder groesser ist', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.3, preis: 51_000, orderArt: 'market' });

    expect(k.stand().realisiert).toBeCloseTo(100, 6);   // nur der geschlossene Teil
    const pos = k.offenePositionen()[0]!;
    expect(pos.seite).toBe('sell');
    expect(pos.menge).toBeCloseTo(0.2, 10);
  });
});

describe('PaperAccount — Gebuehren', () => {
  it('nimmt den Taker-Satz bei Market-Orders', () => {
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'market', hebel: 10,
    });

    // 5.000 Notional * 0,06 % = 3
    expect(r.gebuehr).toBeCloseTo(3, 6);
    expect(k.stand().gebuehren).toBeCloseTo(3, 6);
    expect(k.stand().equity).toBeCloseTo(9_997, 6);
  });

  it('nimmt den Maker-Satz bei Limit-Orders', () => {
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10,
    });

    // 5.000 * 0,01 % = 0,5
    expect(r.gebuehr).toBeCloseTo(0.5, 6);
  });

  it('behandelt Stop-Orders als Taker — sie loesen zum Marktpreis aus', () => {
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 48_000, orderArt: 'stop', hebel: 10,
    });
    expect(r.gebuehr).toBeCloseTo(4_800 * 0.0006, 6);
  });

  it('zieht Gebuehren vom Ergebnis ab — ein knapper Gewinn kann dadurch kippen', () => {
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    // Einstieg per Limit, Ausstieg per Market, winziger Kursgewinn
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 1, preis: 50_020, orderArt: 'market' });

    const s = k.stand();
    expect(s.realisiert).toBeCloseTo(20, 6);
    // Gebuehren: 50.000*0,0001 + 50.020*0,0006 = 5 + 30,012 = 35,012
    expect(s.gebuehren).toBeCloseTo(35.012, 3);
    // Unterm Strich ein Verlust, obwohl der Kurs stieg
    expect(s.equity).toBeLessThan(10_000);
  });
});

describe('PaperAccount — gebundene Margin', () => {
  it('bindet Margin nach Einstieg und Hebel', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });

    const s = k.stand();
    // 0.1 * 50.000 / 10 = 500
    expect(s.gebunden).toBeCloseTo(500, 6);
    expect(s.frei).toBeCloseTo(9_500, 6);
    expect(s.equity).toBeCloseTo(10_000, 6);
  });

  it('gibt die Margin beim Schliessen wieder frei', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 51_000, orderArt: 'market' });

    const s = k.stand();
    expect(s.gebunden).toBe(0);
    expect(s.frei).toBeCloseTo(10_100, 6);
  });

  it('haelt frei bei 0, statt negativ zu werden', () => {
    const k = ohneGebuehren(100);
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    expect(k.stand().frei).toBe(0);
  });
});

describe('PaperAccount — Kontofuehrung', () => {
  it('haelt jede Buchung fuer das Kontoblatt fest', () => {
    const buchungen: Buchung[] = [];
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    k.onBuchung(b => buchungen.push(b));

    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 52_000, orderArt: 'market' });

    // Beim Schliessen kommt der Gewinn vor der Gebuehr: Die Position
    // wird fortgeschrieben, bevor gebucht wird — nur so ist der an
    // jeder Buchung gespeicherte Zustand stimmig.
    const arten = buchungen.map(b => b.art);
    expect(arten).toEqual(['gebuehr', 'gewinn', 'gebuehr']);

    const gewinn = buchungen.find(b => b.art === 'gewinn')!;
    expect(gewinn.betrag).toBeCloseTo(200, 6);
    expect(gewinn.notiz).toContain('Long geschlossen');
  });

  it('meldet die neue Position bereits bei der Gebuehrenbuchung', () => {
    // An jeder Buchung haengt das Wegschreiben des Zustands. Kaeme die
    // Gebuehr vor dem Fortschreiben der Position, wuerde bei einer
    // Eroeffnung der Stand OHNE sie gespeichert — nach einem Neustart
    // faellt die gebundene Margin dann auf 0.
    const staende: number[] = [];
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    k.onBuchung(() => staende.push(k.stand().gebunden));

    k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10,
    });

    // Genau eine Buchung (die Gebuehr) — und zu dem Zeitpunkt muss die
    // Position bereits gebunden sein.
    expect(staende).toHaveLength(1);
    expect(staende[0]).toBeCloseTo(500, 6);
  });

  it('meldet beim Schliessen einen Stand ohne gebundene Margin', () => {
    const staende: number[] = [];
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);
    k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10,
    });

    k.onBuchung(() => staende.push(k.stand().gebunden));
    k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 52_000, orderArt: 'market',
    });

    // Gewinn und Gebuehr — bei beiden ist die Position schon zu.
    expect(staende.length).toBeGreaterThanOrEqual(1);
    expect(staende[staende.length - 1]).toBe(0);
  });

  it('setzt das Konto zurueck', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 48_000, orderArt: 'market' });
    expect(k.stand().equity).toBeCloseTo(9_800, 6);

    k.zuruecksetzen(5_000);
    const s = k.stand();
    expect(s.startkapital).toBe(5_000);
    expect(s.equity).toBe(5_000);
    expect(s.realisiert).toBe(0);
    expect(s.trades).toBe(0);
    expect(k.offenePositionen()).toHaveLength(0);
  });

  it('stellt einen gespeicherten Stand wieder her', () => {
    const k = ohneGebuehren(0);
    k.wiederherstellen({
      startkapital: 10_000, realisiert: 450, gebuehren: 12.5,
      trades: 7, gewinne: 5, verluste: 2,
    });

    const s = k.stand();
    expect(s.equity).toBeCloseTo(10_437.5, 6);
    expect(s.trades).toBe(7);
    expect(s.gewinne).toBe(5);
  });

  it('stellt offene Positionen mit her — sonst gilt alles wieder als frei', () => {
    // Aus der Gegenpruefung: Ohne die Positionen faellt die gebundene
    // Margin nach einem Neustart auf 0, und der naechste Trade wuerde
    // bemessen, als sei nichts gebunden.
    const k = ohneGebuehren(0);
    k.wiederherstellen({
      startkapital: 10_000, realisiert: 0, gebuehren: 0,
      trades: 0, gewinne: 0, verluste: 0,
      positionen: [
        { symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, einstiegspreis: 50_000, hebel: 10 },
      ],
    });

    const s = k.stand();
    expect(s.gebunden).toBeCloseTo(500, 6);
    expect(s.frei).toBeCloseTo(9_500, 6);
    expect(k.offenePositionen()).toHaveLength(1);
  });

  it('fuehrt eine wiederhergestellte Position korrekt zu Ende', () => {
    const k = ohneGebuehren(0);
    k.wiederherstellen({
      startkapital: 10_000, realisiert: 0, gebuehren: 0,
      trades: 0, gewinne: 0, verluste: 0,
      positionen: [
        { symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, einstiegspreis: 50_000, hebel: 10 },
      ],
    });

    k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 52_000, orderArt: 'market' });

    expect(k.stand().realisiert).toBeCloseTo(200, 6);
    expect(k.stand().gebunden).toBe(0);
    expect(k.offenePositionen()).toHaveLength(0);
  });

  it('verwirft Altbestand beim Wiederherstellen, statt ihn zu ergaenzen', () => {
    const k = ohneGebuehren();
    k.ordnungAusgefuehrt({ symbol: 'ETHUSDT', seite: 'buy', menge: 1, preis: 3_000, orderArt: 'limit', hebel: 5 });
    expect(k.offenePositionen()).toHaveLength(1);

    k.wiederherstellen({
      startkapital: 10_000, realisiert: 0, gebuehren: 0,
      trades: 0, gewinne: 0, verluste: 0, positionen: [],
    });

    expect(k.offenePositionen()).toHaveLength(0);
    expect(k.stand().gebunden).toBe(0);
  });

  it('bucht Ein- und Auszahlungen', () => {
    const k = ohneGebuehren(10_000);
    k.einzahlen(2_500, 'Nachschuss');
    expect(k.stand().equity).toBeCloseTo(12_500, 6);
    k.einzahlen(-500);
    expect(k.stand().equity).toBeCloseTo(12_000, 6);
  });
});

describe('PaperAccount — unbrauchbare Orders', () => {
  it('verwirft eine Order mit Menge 0 hoerbar, nicht stillschweigend', () => {
    // Aus der Gegenpruefung: Frueher kam dasselbe Ergebnis zurueck wie
    // bei einer wirkungslosen Order. Reichte der Broker versehentlich
    // eine 0 durch, bliebe eine Position offen, die geschlossen sein
    // sollte — und jede folgende Margin-Rechnung waere falsch.
    const buchungen: Buchung[] = [];
    const k = ohneGebuehren();
    k.onBuchung(b => buchungen.push(b));

    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0, preis: 50_000, orderArt: 'market',
    });

    expect(r.verworfen).toBeDefined();
    expect(r.verworfen).toContain('Menge 0');
    expect(buchungen.map(b => b.art)).toEqual(['verworfen']);
    expect(k.offenePositionen()).toHaveLength(0);
  });

  it.each([
    ['Menge negativ', { menge: -1, preis: 50_000 }],
    ['Preis 0', { menge: 0.1, preis: 0 }],
    ['Menge NaN', { menge: NaN, preis: 50_000 }],
    ['Preis unendlich', { menge: 0.1, preis: Infinity }],
  ])('verwirft: %s', (_name, werte) => {
    const k = ohneGebuehren();
    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', orderArt: 'market', ...werte,
    });
    expect(r.verworfen).toBeDefined();
    expect(k.stand().equity).toBe(10_000);
  });

  it('laesst eine gueltige Order unberuehrt durch', () => {
    const k = ohneGebuehren();
    const r = k.ordnungAusgefuehrt({
      symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10,
    });
    expect(r.verworfen).toBeUndefined();
    expect(k.offenePositionen()).toHaveLength(1);
  });
});

describe('PaperAccount — das Konto treibt die Positionsgroesse', () => {
  it('schrumpft nach Verlusten und laesst den Bot kleiner handeln', () => {
    const k = new PaperAccount(10_000, 'USDT', PHEMEX_FUTURES_GEBUEHREN);

    // Drei Verlusttrades zu je rund 2 % des Kontos
    for (let i = 0; i < 3; i++) {
      k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'buy', menge: 0.1, preis: 50_000, orderArt: 'limit', hebel: 10 });
      k.ordnungAusgefuehrt({ symbol: 'BTCUSDT', seite: 'sell', menge: 0.1, preis: 48_000, orderArt: 'market' });
    }

    const s = k.stand();
    expect(s.verluste).toBe(3);
    expect(s.realisiert).toBeCloseTo(-600, 6);
    expect(s.equity).toBeLessThan(9_400);          // plus Gebuehren
    // Genau darum geht es: Der naechste Trade faellt kleiner aus.
    expect(s.equity).toBeLessThan(10_000);
  });
});
