// ============================================================
// Die Marken im Chart
//
// Zwei Dinge liegen dort uebereinander, und sie sagen Verschiedenes:
//
//   Preismarken  wo etwas GEPLANT war — waagerechte Linien
//   Fuellungen   wo und WANN wirklich gehandelt wurde — Pfeile
//
// Erst zusammen ergibt sich die Geschichte eines Trades: ein
// Einstieg, der ueber seinem Limit fuellte; ein Stop, den ein Docht
// ausloeste.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../store/sqlite-store.js';
import { planFuellungen, planMarken, signalLage } from './trade-plans.js';

describe('planFuellungen — die Pfeile im Chart', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  const PLAN = 'plan-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'marken-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'HYPEUSDT', market_type: 'futures',
      direction: 'short', leverage: 10, total_size: 100,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function order(
    id: string, rolle: string, seite: string,
    menge: number, preis: number, gefuellt = menge,
  ): void {
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'HYPEUSDT', price: preis, quantity: menge,
      status: gefuellt > 0 ? 'filled' : 'new', broker: 'paper',
    });
    if (gefuellt > 0) {
      store.updatePlanOrder(id, { filled_quantity: gefuellt, avg_fill_price: preis });
    }
  }

  it('meldet nur tatsaechlich gefuellte Orders', () => {
    order('e1', 'entry', 'sell', 50, 77.34);
    order('e2', 'entry', 'sell', 50, 77.56, 0);    // liegt noch

    const f = planFuellungen(store, PLAN);

    expect(f).toHaveLength(1);
    expect(f[0]!.preis).toBeCloseTo(77.34, 4);
  });

  it('nummeriert je Rolle getrennt durch', () => {
    order('e1', 'entry', 'sell', 50, 77.34);
    order('e2', 'entry', 'sell', 50, 77.56);
    order('t1', 'take_profit', 'buy', 25, 76.99);

    const f = planFuellungen(store, PLAN);
    const texte = f.map(x => x.beschriftung);

    // Nicht E1, E2, E3 — der Take-Profit beginnt seine eigene Zaehlung.
    expect(texte).toContain('E1');
    expect(texte).toContain('E2');
    expect(texte).toContain('TP1');
  });

  it('haengt der Zeitangabe das Z an', () => {
    // SQLite liefert "YYYY-MM-DD HH:MM:SS" in UTC OHNE Zonenangabe.
    // Ohne das Z laese der Browser sie als Ortszeit — die Marke saesse
    // im Chart um den Zonenversatz daneben, bei uns um zwei Stunden.
    order('e1', 'entry', 'sell', 50, 77.34);

    const f = planFuellungen(store, PLAN);

    expect(f[0]!.zeitpunkt).toMatch(/Z$/);
    expect(f[0]!.zeitpunkt).toContain('T');
    // Und sie laesst sich lesen.
    expect(Number.isFinite(Date.parse(f[0]!.zeitpunkt))).toBe(true);
  });

  it('ordnet die Rollen den Markenarten zu', () => {
    order('e1', 'entry', 'sell', 50, 77.34);
    order('t1', 'take_profit', 'buy', 25, 76.99);
    order('s1', 'stop_loss', 'buy', 25, 78.40);

    const arten = planFuellungen(store, PLAN).map(f => f.art).sort();

    expect(arten).toEqual(['einstieg', 'sl', 'tp']);
  });

  it('meldet den FUELLPREIS, nicht den geplanten', () => {
    // Genau darum geht es: Die waagerechte Linie zeigt das Limit, der
    // Pfeil zeigt, wo wirklich gefuellt wurde.
    store.insertPlanOrder({
      id: 'e1', trade_plan_id: PLAN, side: 'sell', order_type: 'limit',
      role: 'entry', symbol: 'HYPEUSDT', price: 77.50, quantity: 50,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('e1', { filled_quantity: 50, avg_fill_price: 77.62 });

    expect(planFuellungen(store, PLAN)[0]!.preis).toBeCloseTo(77.62, 4);
  });

  it('gibt eine leere Liste zurueck, wenn nichts gefuellt ist', () => {
    order('e1', 'entry', 'sell', 50, 77.34, 0);
    expect(planFuellungen(store, PLAN)).toEqual([]);
  });

  it('traegt die Menge mit', () => {
    order('e1', 'entry', 'sell', 34.60745918, 77.339);
    expect(planFuellungen(store, PLAN)[0]!.menge).toBeCloseTo(34.60745918, 8);
  });
});

// ============================================================
// Der Stop im Chart muss der GELTENDE sein
//
// Er wandert: nach einem Take-Profit nachgezogen, als Trailing
// mitlaufend. Gezeichnet wurde lange `plan.stop_loss_price` — der
// urspruengliche Wert aus dem Signal.
//
// Am 26.10. zeigte die Kachel 737,61 und der Chart 733,03. Zwei
// Zahlen fuer dieselbe Sache, und die im Chart war die laengst
// ueberholte. Wer daran abliest, ob ein Docht den Stop beruehrt
// haette, liest am falschen Strich.
// ============================================================

describe('planMarken — der Stop', () => {
  /** Ein Plan mit Stop bei 733,03. */
  const plan = {
    entry_orders: JSON.stringify([{ price: 739.96 }]),
    take_profits: JSON.stringify([{ price: 743.86 }, { price: 747.42 }]),
    stop_loss_price: 733.0287,
  };

  function sl(marken: Array<{ art: string; preis: number; beschriftung: string }>) {
    return marken.find(m => m.art === 'sl');
  }
  function slAlt(marken: Array<{ art: string; preis: number; beschriftung: string }>) {
    return marken.find(m => m.art === 'sl_alt');
  }

  it('zeichnet den geplanten Stop, solange er nicht gewandert ist', () => {
    const m = planMarken(plan, { slCurrent: 733.0287 });

    expect(sl(m)!.preis).toBeCloseTo(733.0287, 4);
    // Kein zweiter Strich, wenn beide gleich sind.
    expect(slAlt(m)).toBeUndefined();
  });

  it('zeichnet den NACHGEZOGENEN Stop, nicht den geplanten', () => {
    // Genau der Fall vom 26.10.
    const m = planMarken(plan, { slCurrent: 737.6105 });

    expect(sl(m)!.preis).toBeCloseTo(737.6105, 4);
  });

  it('behaelt den urspruenglichen als blasse Marke', () => {
    const m = planMarken(plan, { slCurrent: 737.6105 });

    // Erst der Vergleich zeigt, wieviel Luft der Trade gewonnen hat.
    expect(slAlt(m)!.preis).toBeCloseTo(733.0287, 4);
    expect(slAlt(m)!.beschriftung).toContain('urspr');
  });

  it('kennzeichnet einen laufenden Trailing-Stop', () => {
    const m = planMarken(plan, { slCurrent: 741.0, trailingActive: true });

    expect(sl(m)!.beschriftung).toContain('↗');
  });

  it('faellt auf den geplanten zurueck, wenn kein Monitor laeuft', () => {
    // Ein beendeter Plan hat keinen Zustand mehr — dann ist der
    // geplante Stop die einzige Angabe, die es gibt.
    const m = planMarken(plan, null);

    expect(sl(m)!.preis).toBeCloseTo(733.0287, 4);
    expect(slAlt(m)).toBeUndefined();
  });

  it('zeichnet Einstiege und Ziele unveraendert', () => {
    const m = planMarken(plan, { slCurrent: 737.6105 });

    expect(m.filter(x => x.art === 'einstieg')).toHaveLength(1);
    expect(m.filter(x => x.art === 'tp')).toHaveLength(2);
    expect(m.find(x => x.art === 'tp')!.beschriftung).toBe('TP1');
  });

  it('kommt ohne Stop aus', () => {
    const ohne = { ...plan, stop_loss_price: null };
    const m = planMarken(ohne, null);

    expect(sl(m)).toBeUndefined();
    expect(slAlt(m)).toBeUndefined();
  });
});

// ============================================================
// Wann kam das Signal, und wie stand der Markt da?
//
// Die Frage, die ein Signal beurteilt, BEVOR es gehandelt wurde.
//
// Am 26.10. kam ein BTCUSDT-Short mit Einstiegen ab 80.659. Der Kurs
// stand bei 80.406 — und war 13 Minuten zuvor noch bei 80.812
// gewesen. Die Orders lagen binnen einer Sekunde im Orderbuch und
// wurden trotzdem nie gefuellt.
//
// Im Chart sah es aus, als haette der Bot vier Einstiege uebergangen:
// Die Kerzen standen weit ueber dem ersten Limit. Erst die senkrechte
// Marke zeigt, dass sie VOR dem Signal lagen.
// ============================================================

describe('signalLage — die Marke im Chart', () => {
  const mitLage = {
    signal_origin: JSON.stringify({
      strategy: 'MBCMA-f23',
      signal_id: 'mbcma-f23-11863192',
      emitted_at: '2026-10-26T16:02:19.522Z',
      received_at: '2026-10-26T16:02:19.904Z',
      marktlage: {
        kurs: 80406.7,
        naechsterEinstieg: 80659.4,
        abstand: 252.7,
        abstandPct: 0.3143,
        ausserhalb: false,
      },
    }),
  };

  it('nennt den Empfangszeitpunkt', () => {
    const l = signalLage(mitLage);

    // Empfangen, nicht gesendet: Der Chart zeigt, wann der BOT es
    // wusste — vorher konnte er nichts tun.
    expect(l!.zeitpunkt).toBe('2026-10-26T16:02:19.904Z');
  });

  it('reicht Kurs und Abstand mit', () => {
    const l = signalLage(mitLage);

    expect(l!.kurs).toBeCloseTo(80406.7, 2);
    expect(l!.abstandPct).toBeCloseTo(0.3143, 4);
    expect(l!.ausserhalb).toBe(false);
  });

  it('faellt auf den Sendezeitpunkt zurueck', () => {
    const ohneEmpfang = {
      signal_origin: JSON.stringify({ emitted_at: '2026-10-26T16:02:19.522Z' }),
    };

    expect(signalLage(ohneEmpfang)!.zeitpunkt).toBe('2026-10-26T16:02:19.522Z');
  });

  it('kommt ohne Marktlage aus', () => {
    // Aeltere Plaene tragen sie nicht — die Marke gehoert trotzdem
    // gesetzt.
    const alt = { signal_origin: JSON.stringify({ received_at: '2026-10-26T16:02:19.904Z' }) };
    const l = signalLage(alt);

    expect(l!.zeitpunkt).toBe('2026-10-26T16:02:19.904Z');
    expect(l!.kurs).toBeNull();
    expect(l!.abstandPct).toBeNull();
  });

  it('meldet nichts bei einem Plan ohne Signal', () => {
    expect(signalLage({ signal_origin: null })).toBeNull();
    expect(signalLage({})).toBeNull();
  });

  it('uebersteht unlesbare Herkunftsdaten', () => {
    // Ein kaputtes JSON darf den Chart nicht zu Fall bringen.
    expect(signalLage({ signal_origin: '{kaputt' })).toBeNull();
  });

  it('erkennt ein Signal, das ausserhalb aller Einstiege eintraf', () => {
    const ausserhalb = {
      signal_origin: JSON.stringify({
        received_at: '2026-10-26T16:02:19.904Z',
        marktlage: { kurs: 81500, abstandPct: -0.61, ausserhalb: true },
      }),
    };

    // Ohne Umkehr kommt dieser Trade nicht zustande — und das steht
    // schon beim Eingang fest, nicht erst am Ende.
    expect(signalLage(ausserhalb)!.ausserhalb).toBe(true);
  });
});
