// ============================================================
// Die Kennzahlen des Dashboards
//
// Sie beantworten die Frage, die man beim ersten Blick stellt: Wieviel
// Kapital ist gerade gebunden? Eine Zahl, die stattdessen die geplante
// Margin nennt, laesst das Risiko um ein Vielfaches zu hoch erscheinen —
// bei einem gestaffelten Einstieg, von dem erst ein Viertel gefuellt
// ist, um das Vierfache.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../store/sqlite-store.js';
import { ErgebnisService } from '../../services/ergebnis-service.js';
import { AKTIVE_STATUS, BEENDETE_STATUS } from './dashboard.js';

/**
 * Bildet die Margin-Rechnung des Dashboards nach.
 *
 * Die Formel selbst steht seit dem 26.10. im ErgebnisService
 * (`einsatzOffen`); hier bleibt nur das Aufsummieren und der Rueckfall
 * auf die geplante Margin fuer Plaene ohne Ergebnisrechnung. Dass der
 * Test die Formel nicht mehr nachbaut, ist der Punkt: Eine Kopie bliebe
 * gruen, auch wenn die echte Rechnung daneben liefe.
 */
function gebundeneMargin(
  plaene: Array<{ ergebnis: ReturnType<ErgebnisService['fuerPlan']> | null; leverage: number; margin?: number }>,
): number {
  return plaene.reduce((s, p) => {
    const e = p.ergebnis;
    if (e && e.einsatzOffen != null) return s + e.einsatzOffen;
    if (e) return s;
    return s + (p.margin ?? 0);
  }, 0);
}

describe('Dashboard — gebundene Margin', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;

  const PLAN = 'plan-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'dashkpi-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BNBUSDT', market_type: 'futures',
      direction: 'long', leverage: 22, total_size: 30.71817556,
      total_margin: 1028.41,
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
    rolle: string, seite: string, menge: number, preis: number, gefuellt = menge,
  ): void {
    const id = `o-${Math.random().toString(36).slice(2)}`;
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'BNBUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, { filled_quantity: gefuellt, avg_fill_price: preis });
  }

  it('bindet nichts, solange kein Einstieg gefuellt ist', () => {
    const e = ergebnis.fuerPlan(PLAN, 'long', 22, 738);
    expect(gebundeneMargin([{ ergebnis: e, leverage: 22 }])).toBe(0);
  });

  it('nennt den Einsatz der tatsaechlich offenen Menge, nicht die geplante Margin', () => {
    // Einer von vier Einstiegen: 7,68 von 30,72 geplanten BNB
    order('entry', 'buy', 7.67954389, 737.81);

    const e = ergebnis.fuerPlan(PLAN, 'long', 22, 738.83);
    const gebunden = gebundeneMargin([{ ergebnis: e, leverage: 22 }]);

    // 7,67954389 * 737,81 / 22 = 257,5…
    expect(gebunden).toBeCloseTo(257.55, 1);
    // Und eben NICHT die geplanten 1.028,41 — das Vierfache.
    expect(gebunden).toBeLessThan(300);
  });

  // Auf Cent geprueft, nicht auf 1/100 Cent: `einsatzOffen` kommt wie
  // jeder Betrag des ErgebnisService gerundet aus dem Dienst. Eine
  // feinere Forderung behauptete eine Genauigkeit, die weder die
  // Anzeige noch die Boerse hat.
  it('gibt Margin frei, wenn ein Take-Profit einen Teil geschlossen hat', () => {
    order('entry', 'buy', 10, 700);
    let gebunden = gebundeneMargin([{ ergebnis: ergebnis.fuerPlan(PLAN, 'long', 22, 710), leverage: 22 }]);
    expect(gebunden).toBeCloseTo(7000 / 22, 2);

    // Die Haelfte schliessen
    order('take_profit', 'sell', 5, 720);
    gebunden = gebundeneMargin([{ ergebnis: ergebnis.fuerPlan(PLAN, 'long', 22, 720), leverage: 22 }]);

    // Jetzt sind nur noch 5 offen — die Haelfte der Margin ist frei.
    expect(gebunden).toBeCloseTo(3500 / 22, 2);
  });

  it('bindet nichts mehr, wenn die Position vollstaendig zu ist', () => {
    order('entry', 'buy', 10, 700);
    order('take_profit', 'sell', 10, 720);

    const e = ergebnis.fuerPlan(PLAN, 'long', 22, 720);
    expect(gebundeneMargin([{ ergebnis: e, leverage: 22 }])).toBe(0);
  });

  it('faellt fuer Plaene ohne Ergebnisrechnung auf die geplante Margin zurueck', () => {
    // Engine- und local_plans fuehren keine — dort bleibt es beim Plan.
    expect(gebundeneMargin([{ ergebnis: null, leverage: 10, margin: 500 }])).toBe(500);
  });

  it('summiert ueber mehrere Plaene', () => {
    order('entry', 'buy', 10, 700);
    const e = ergebnis.fuerPlan(PLAN, 'long', 22, 710);

    const summe = gebundeneMargin([
      { ergebnis: e, leverage: 22 },
      { ergebnis: null, leverage: 10, margin: 100 },
    ]);
    expect(summe).toBeCloseTo(7000 / 22 + 100, 2);
  });
});

// ============================================================
// Aktiv oder erledigt?
//
// Die Einteilung entscheidet, in welcher der beiden Listen ein Plan
// landet. Ein laufender Plan unter den erledigten wird uebersehen —
// und ein uebersehener Plan wird nicht geprueft.
// ============================================================

describe('Dashboard — Einteilung der Plaene', () => {
  it('zaehlt wartende Plaene zu den aktiven', () => {
    // 'planned' ist der heikle Fall: Ein Plan, der auf seine
    // Aktivierungsbedingung wartet, wird sehr wohl ueberwacht.
    expect(AKTIVE_STATUS.has('planned')).toBe(true);
    expect(AKTIVE_STATUS.has('active')).toBe(true);
    expect(AKTIVE_STATUS.has('monitoring')).toBe(true);
    expect(AKTIVE_STATUS.has('executing')).toBe(true);
  });

  it('zaehlt abgeschlossene, stornierte und fehlgeschlagene zu den erledigten', () => {
    expect(BEENDETE_STATUS.has('completed')).toBe(true);
    expect(BEENDETE_STATUS.has('cancelled')).toBe(true);
    expect(BEENDETE_STATUS.has('error')).toBe(true);
  });

  it('haelt die beiden Mengen ueberschneidungsfrei', () => {
    // Ueberschnitten sie sich, stuende derselbe Plan in beiden Listen —
    // und seine Margin zaehlte doppelt in die Kennzahl.
    const doppelt = [...AKTIVE_STATUS].filter(s => BEENDETE_STATUS.has(s));
    expect(doppelt).toEqual([]);
  });
});

describe('ErgebnisService — offene Menge', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;
  const PLAN = 'plan-2';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'dashkpi2-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);
    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'HYPEUSDT', market_type: 'futures',
      direction: 'short', leverage: 16, total_size: 217.32615352,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('unterscheidet die offene von der geplanten Menge', () => {
    const id = 'o1';
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: 'sell', order_type: 'limit', role: 'entry',
      symbol: 'HYPEUSDT', price: 75.64, quantity: 108.66307676,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, { filled_quantity: 108.66307676, avg_fill_price: 75.64 });

    const e = ergebnis.fuerPlan(PLAN, 'short', 16, 75.0);

    // Offen ist die Haelfte der geplanten 217,33
    expect(e.offen).toBeCloseTo(108.66307676, 6);
    expect(e.offen).toBeLessThan(217.32615352);

    // Short im Gewinn, weil der Kurs faellt
    expect(e.unrealisiert).toBeGreaterThan(0);
  });
});
