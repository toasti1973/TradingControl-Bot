// ============================================================
// KursStrom — Tests
//
// Geprueft werden vorrangig die Faelle, in denen der Strom **nicht**
// traegt: eine Boerse ohne WebSocket, eine abgerissene Verbindung, ein
// Symbol ohne Tick. In jedem davon muss der Strom `null` sagen, damit
// der Aufrufer per REST fragt. Ein alter Wert, als aktueller
// ausgegeben, waere der gefaehrlichste Ausgang — er sieht aus wie eine
// Tatsache.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { KursStrom, STROM_HOECHSTALTER_MS, type StromFaehigeBoerse } from './kurs-strom.js';

/**
 * Eine Boerse, die genau die vorgegebenen Handel liefert und danach
 * haengt.
 *
 * Das Haengen ist Absicht: So verhaelt sich `watchTrades` wirklich —
 * es kehrt beim naechsten Handel zurueck, und wenn keiner kommt,
 * wartet es.
 */
function boerseMitTicks(ticks: (number | Error)[]): StromFaehigeBoerse & { aufrufe: number } {
  let i = 0;
  let ts = Date.now() + 1;
  const b = {
    aufrufe: 0,
    has: { watchTrades: true },
    async watchTrades() {
      b.aufrufe++;
      if (i >= ticks.length) return new Promise<never>(() => { /* haengt, wie die echte */ });
      const t = ticks[i++];
      if (t instanceof Error) throw t;
      return [{ price: t as number, timestamp: ts++ }];
    },
    async close() { return undefined; },
  };
  return b;
}

/** Eine Boerse, die nur den Ticker kann — der Rueckfall. */
function boerseNurTicker(ticks: number[]): StromFaehigeBoerse {
  let i = 0;
  return {
    has: { watchTicker: true },
    async watchTicker() {
      if (i >= ticks.length) return new Promise<never>(() => {});
      return { last: ticks[i++] };
    },
    async close() { return undefined; },
  };
}

/** Wartet, bis die Schleife die Handel durchgearbeitet hat. */
const kurzWarten = () => new Promise((r) => setTimeout(r, 15));

describe('KursStrom — eine Boerse ohne WebSocket', () => {
  it('meldet sich als nicht moeglich, wenn beide Kanaele fehlen', () => {
    const strom = new KursStrom({ has: {} }, 'ohne-ws');
    expect(strom.moeglich).toBe(false);
    expect(strom.kanaele).toEqual([]);
  });

  // `has.watchTrades` ist die Auskunft der Boerse selbst. Eine
  // vorhandene Methode heisst nicht, dass die Boerse sie beherrscht —
  // ccxt bringt sie an der Basisklasse mit und wirft dort "not
  // supported".
  it('meldet sich als nicht moeglich, wenn die Boerse es verneint', () => {
    const strom = new KursStrom({
      has: { watchTrades: false, watchTicker: false },
      async watchTrades() { throw new Error('not supported'); },
      async watchTicker() { throw new Error('not supported'); },
    }, 'verneint');
    expect(strom.moeglich).toBe(false);
  });

  it('abonniert nichts und antwortet null', async () => {
    const strom = new KursStrom({ has: {} }, 'ohne-ws');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.letzterKurs('BTC/USDT:USDT')).toBeNull();
    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')).toBeNull();
    expect(strom.uebersicht()).toEqual([]);
  });
});

describe('KursStrom — der laufende Kurs', () => {
  it('nimmt den letzten Handel', async () => {
    const strom = new KursStrom(boerseMitTicks([100, 101, 102]), 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.letzterKurs('BTC/USDT:USDT')?.preis).toBe(102);
    await strom.stoppe();
  });

  it('antwortet null, solange kein Handel kam', async () => {
    const strom = new KursStrom(boerseMitTicks([]), 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.letzterKurs('BTC/USDT:USDT')).toBeNull();
    await strom.stoppe();
  });

  // Der wichtigste Test dieser Datei.
  it('gibt einen zu alten Kurs NICHT als aktuellen aus', async () => {
    const strom = new KursStrom(boerseMitTicks([100]), 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    const jetzt = Date.now();
    expect(strom.letzterKurs('BTC/USDT:USDT', jetzt)?.preis).toBe(100);

    // Eine Sekunde ueber der Grenze — ab hier traegt REST.
    expect(strom.letzterKurs('BTC/USDT:USDT', jetzt + STROM_HOECHSTALTER_MS + 1_000)).toBeNull();
    await strom.stoppe();
  });

  it('verwirft unbrauchbare Handel, ohne den letzten guten zu verlieren', async () => {
    const basis = Date.now() + 1;
    let gegeben = false, zweites = false;
    const b: StromFaehigeBoerse = {
      has: { watchTrades: true },
      async watchTrades() {
        if (!gegeben) { gegeben = true; return [{ price: 100, timestamp: basis }]; }
        if (!zweites) { zweites = true; return [{ price: 0, timestamp: basis + 1 }]; }
        return new Promise<never>(() => {});
      },
      async close() { return undefined; },
    };

    const strom = new KursStrom(b, 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    // Die Null hat den guten Wert nicht ueberschrieben.
    expect(strom.letzterKurs('BTC/USDT:USDT')?.preis).toBe(100);
    await strom.stoppe();
  });

  it('startet die Schleife je Symbol nur einmal', async () => {
    const b = boerseMitTicks([100]);
    const strom = new KursStrom(b, 'test');

    // Der Aufrufer ruft das bei jeder Kursabfrage auf, alle zwei
    // Sekunden. Ohne diese Sperre liefen nach einer Minute dreissig
    // Schleifen auf demselben Symbol.
    for (let i = 0; i < 10; i++) strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    // Ein Aufruf fuer den Handel, einer fuer das Warten auf den
    // naechsten — nicht zehn Schleifen.
    expect(b.aufrufe).toBeLessThanOrEqual(2);
    await strom.stoppe();
  });
});

describe('KursStrom — Hoch und Tief seit der letzten Abfrage', () => {
  // Das ist der Grund, warum es diese Klasse gibt.
  it('sieht den Docht zwischen zwei Abfragen', async () => {
    // HYPEUSDT am 25.10.2026: Lauf auf 77,034, Schluss bei 76,957.
    const strom = new KursStrom(boerseMitTicks([76.95, 77.034, 76.957]), 'test');
    strom.abonniere('HYPE/USDT:USDT');
    await kurzWarten();

    const spanne = strom.spanneSeitAbfrage('HYPE/USDT:USDT');
    expect(spanne?.hoch).toBe(77.034);
    expect(spanne?.tief).toBe(76.95);
    expect(spanne?.ticks).toBe(3);

    // Der Punktwert allein haette den Docht nie gezeigt — und er
    // bleibt lesbar, obwohl die Spanne gerade zurueckgesetzt wurde.
    expect(strom.letzterKurs('HYPE/USDT:USDT')?.preis).toBe(76.957);
    await strom.stoppe();
  });

  it('setzt die Spanne beim Lesen auf den letzten Preis zurueck', async () => {
    const strom = new KursStrom(boerseMitTicks([100, 110, 105]), 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')?.hoch).toBe(110);

    // Zweite Abfrage ohne neuen Handel: Die Spanne ist leer, aber sie
    // beginnt beim letzten Preis — nicht bei null. Sonst klaffte
    // zwischen zwei Abfragen eine Luecke.
    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')).toBeNull();

    // Und das alte Hoch ist nicht hinuebergeschleppt.
    expect(strom.uebersicht()[0]?.preis).toBe(105);
    await strom.stoppe();
  });

  it('nimmt beim Short das Tief mit', async () => {
    const strom = new KursStrom(boerseMitTicks([200, 190, 195]), 'test');
    strom.abonniere('ETH/USDT:USDT');
    await kurzWarten();

    expect(strom.spanneSeitAbfrage('ETH/USDT:USDT')?.tief).toBe(190);
    await strom.stoppe();
  });
});

describe('KursStrom — beide Kanaele', () => {
  // Gemessen an Phemex ueber 60 Sekunden: Der Trade-Strom sah auf
  // BTC eine Spanne von 28,10, der Ticker 48,90 — bei SOL 0,02 gegen
  // 0,05. Keiner der beiden ist verlaesslich der feinere, deshalb
  // laufen beide. Siehe Kopfkommentar.
  it('liest beide, wenn die Boerse beide kann', () => {
    const strom = new KursStrom({
      has: { watchTrades: true, watchTicker: true },
      async watchTrades() { return []; },
      async watchTicker() { return { last: 1 }; },
    }, 'test');
    expect(strom.kanaele).toEqual(['trades', 'ticker']);
  });

  it('kommt mit dem Ticker allein aus', async () => {
    const strom = new KursStrom(boerseNurTicker([100, 105]), 'test');
    expect(strom.kanaele).toEqual(['ticker']);

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.letzterKurs('BTC/USDT:USDT')?.preis).toBe(105);
    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')?.hoch).toBe(105);
    await strom.stoppe();
  });

  // DAS ist der Fall, der die Zeitgrenze rechtfertigt.
  it('verwirft die Historie aus dem ersten Schwung', async () => {
    const jetzt = Date.now();
    let gegeben = false;
    const strom = new KursStrom({
      has: { watchTrades: true },
      async watchTrades() {
        if (gegeben) return new Promise<never>(() => {});
        gegeben = true;
        return [
          // 45 Minuten Historie — die Boerse schickt beim ersten
          // Aufruf ihren ganzen Zwischenspeicher.
          { price: 95_000, timestamp: jetzt - 45 * 60_000 },
          { price: 70_000, timestamp: jetzt - 30 * 60_000 },
          // Und jetzt das Aktuelle.
          { price: 79_700, timestamp: jetzt + 10 },
          { price: 79_750, timestamp: jetzt + 20 },
        ];
      },
      async close() { return undefined; },
    }, 'test');

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    const spanne = strom.spanneSeitAbfrage('BTC/USDT:USDT');
    // Das Stundenhoch von 95.000 darf nicht in die Spanne der letzten
    // zwei Sekunden geraten — der Trailing-Stop spraenge sonst auf
    // 93.575 und damit weit in den Markt hinein.
    expect(spanne?.hoch).toBe(79_750);
    expect(spanne?.tief).toBe(79_700);
    expect(spanne?.ticks).toBe(2);
    await strom.stoppe();
  });

  it('zaehlt denselben Handel nicht zweimal', async () => {
    const jetzt = Date.now();
    let runde = 0;
    const strom = new KursStrom({
      has: { watchTrades: true },
      async watchTrades() {
        runde++;
        if (runde === 1) return [{ price: 100, timestamp: jetzt + 10 }];
        // Die Boerse schickt den alten Handel noch einmal mit, dazu
        // einen neuen.
        if (runde === 2) return [
          { price: 100, timestamp: jetzt + 10 },
          { price: 102, timestamp: jetzt + 20 },
        ];
        return new Promise<never>(() => {});
      },
      async close() { return undefined; },
    }, 'test');

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    // Drei Meldungen, aber nur zwei Handel: 100 und 102.
    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')?.ticks).toBe(2);
    await strom.stoppe();
  });

  // Mehrere Handel in derselben Millisekunde sind an einer Boerse die
  // Regel. Mit einem echten Groesser-als statt Groesser-gleich fiele
  // von ihnen alles bis auf den ersten weg — und das waere genau der
  // Ausbruch, der gesehen werden soll.
  it('behaelt mehrere Handel in derselben Millisekunde', async () => {
    const jetzt = Date.now();
    let runde = 0;
    const strom = new KursStrom({
      has: { watchTrades: true },
      async watchTrades() {
        runde++;
        if (runde === 1) return [{ price: 100, timestamp: jetzt + 10 }];
        if (runde === 2) return [
          { price: 110, timestamp: jetzt + 10 },
          { price: 120, timestamp: jetzt + 10 },
        ];
        return new Promise<never>(() => {});
      },
      async close() { return undefined; },
    }, 'test');

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')?.hoch).toBe(120);
    await strom.stoppe();
  });

  it('verwirft Handel ohne Zeitstempel', async () => {
    const jetzt = Date.now();
    let gegeben = false;
    const strom = new KursStrom({
      has: { watchTrades: true },
      async watchTrades() {
        if (gegeben) return new Promise<never>(() => {});
        gegeben = true;
        // Ohne Zeit greift kein Sieb — ein solcher Handel kaeme bei
        // jedem Aufruf erneut durch.
        return [
          { price: 999_999, timestamp: undefined },
          { price: 79_700, timestamp: jetzt + 10 },
        ];
      },
      async close() { return undefined; },
    }, 'test');

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.spanneSeitAbfrage('BTC/USDT:USDT')?.hoch).toBe(79_700);
    await strom.stoppe();
  });
});

describe('KursStrom — die Kanaele speisen dieselbe Spanne', () => {
  /**
   * Eine Boerse, bei der jeder Kanal einen anderen Ausschlag sieht —
   * genau die Lage, die zwei Kanaele rechtfertigt.
   */
  function zweiKanaele() {
    const ts = Date.now() + 1;
    let tradeRunde = 0, tickRunde = 0;
    return {
      has: { watchTrades: true, watchTicker: true },
      async watchTrades() {
        tradeRunde++;
        // Der Trade-Strom sieht die Spitze nach oben.
        if (tradeRunde === 1) return [{ price: 81.0, timestamp: ts }];
        return new Promise<never>(() => {});
      },
      async watchTicker() {
        tickRunde++;
        // Der Ticker sieht das Tief, das kein Handel zeigte.
        if (tickRunde === 1) return { last: 79.0 };
        if (tickRunde === 2) return { last: 80.0 };
        return new Promise<never>(() => {});
      },
      async close() { return undefined; },
    };
  }

  it('nimmt das Aeusserste aus beiden', async () => {
    const strom = new KursStrom(zweiKanaele(), 'test');
    strom.abonniere('HYPE/USDT:USDT');
    await kurzWarten();

    const spanne = strom.spanneSeitAbfrage('HYPE/USDT:USDT');
    // Das Hoch kam aus den Handeln, das Tief aus dem Ticker. Haette
    // nur einer gelaufen, fehlte eines von beiden.
    expect(spanne?.hoch).toBe(81.0);
    expect(spanne?.tief).toBe(79.0);
    expect(spanne?.ticks).toBe(3);
    await strom.stoppe();
  });

  // Faellt ein Kanal aus, traegt der andere weiter — sonst waere das
  // zweite Abo nur doppelter Aufwand ohne Gewinn.
  it('laeuft weiter, wenn ein Kanal abreisst', async () => {
    const melde = vi.fn();
    let tickRunde = 0;
    const strom = new KursStrom({
      has: { watchTrades: true, watchTicker: true },
      async watchTrades() { throw new Error('Trade-Socket zu'); },
      async watchTicker() {
        tickRunde++;
        if (tickRunde === 1) return { last: 100 };
        return new Promise<never>(() => {});
      },
      async close() { return undefined; },
    }, 'test', melde);

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(strom.letzterKurs('BTC/USDT:USDT')?.preis).toBe(100);
    expect(melde).toHaveBeenCalledWith(
      'warn', expect.stringContaining('(trades)'), expect.anything(),
    );
    await strom.stoppe();
  });

  // Der Zaehler `schleifen` haelt das Abo am Leben, solange ein Kanal
  // laeuft. Ohne ihn gaebe es nach dem naechsten `abonniere()` zwei
  // Schleifen auf demselben Symbol.
  it('startet nicht neu, solange ein Kanal noch laeuft', async () => {
    let tradeAufrufe = 0;
    const strom = new KursStrom({
      has: { watchTrades: true, watchTicker: true },
      async watchTrades() {
        tradeAufrufe++;
        return new Promise<never>(() => {});
      },
      async watchTicker() { throw new Error('Ticker weg'); },
      async close() { return undefined; },
    }, 'test');

    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    expect(tradeAufrufe).toBe(1);
    await strom.stoppe();
  });
});

describe('KursStrom — wenn die Verbindung abreisst', () => {
  it('versucht es erneut und meldet den Abriss', async () => {
    const melde = vi.fn();
    const strom = new KursStrom(boerseMitTicks([new Error('socket zu'), 100]), 'test', melde);
    strom.abonniere('BTC/USDT:USDT');

    // Die erste Wartezeit ist eine Sekunde.
    await new Promise((r) => setTimeout(r, 1_200));

    expect(melde).toHaveBeenCalledWith('warn', expect.stringContaining('abgerissen'), expect.anything());
    expect(strom.letzterKurs('BTC/USDT:USDT')?.preis).toBe(100);
    await strom.stoppe();
  }, 10_000);

  it('meldet, wenn der Strom wieder laeuft', async () => {
    const melde = vi.fn();
    const strom = new KursStrom(boerseMitTicks([new Error('weg'), 100]), 'test', melde);
    strom.abonniere('BTC/USDT:USDT');
    await new Promise((r) => setTimeout(r, 1_200));

    // Ein stiller Wiederanlauf liesse offen, ob der Strom noch
    // traegt oder REST die ganze Zeit einspringt.
    expect(melde).toHaveBeenCalledWith('info', expect.stringContaining('wieder verbunden'), expect.anything());
    await strom.stoppe();
  }, 10_000);

  it('liefert waehrend des Abrisses null, nicht den alten Wert', async () => {
    const strom = new KursStrom(boerseMitTicks([100, new Error('weg')]), 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    const jetzt = Date.now();
    // Der Abriss macht den alten Wert nicht juenger.
    expect(strom.letzterKurs('BTC/USDT:USDT', jetzt + STROM_HOECHSTALTER_MS + 1)).toBeNull();
    await strom.stoppe();
  });
});

describe('KursStrom — Beenden', () => {
  it('stoppt die Schleifen und schliesst die Verbindung', async () => {
    const b = boerseMitTicks([100]);
    const close = vi.spyOn(b, 'close');
    const strom = new KursStrom(b, 'test');
    strom.abonniere('BTC/USDT:USDT');
    await kurzWarten();

    await strom.stoppe();

    expect(close).toHaveBeenCalled();
    expect(strom.uebersicht()[0]?.aktiv).toBe(false);
  });

  it('abonniert nach dem Stoppen nichts mehr', async () => {
    const b = boerseMitTicks([100]);
    const strom = new KursStrom(b, 'test');
    await strom.stoppe();

    strom.abonniere('ETH/USDT:USDT');
    await kurzWarten();

    expect(strom.uebersicht().find((u) => u.symbol === 'ETH/USDT:USDT')).toBeUndefined();
  });

  it('wirft nicht, wenn das Schliessen scheitert', async () => {
    const strom = new KursStrom({
      has: { watchTrades: true },
      async watchTrades() { return new Promise<never>(() => {}); },
      async close() { throw new Error('Socket schon tot'); },
    }, 'test');
    strom.abonniere('BTC/USDT:USDT');

    // Beim Herunterfahren ist ein nicht schliessbarer Socket
    // gleichgueltig — ein Wurf hier hielte den Bot am Beenden auf.
    await expect(strom.stoppe()).resolves.toBeUndefined();
  });
});
