// ============================================================
// Das Vorzeichen — die Richtung muss stimmen
//
// Die eine Regel, an der alles haengt:
//
//   LONG:  Kurs steigt = Gewinn,  Kurs faellt = Verlust
//   SHORT: Kurs steigt = VERLUST, Kurs faellt = Gewinn
//
// Ein Vorzeichenfehler hier waere der teuerste denkbare: Der Bot
// haelte einen laufenden Verlust fuer Gewinn, zoege den Stop in die
// falsche Richtung nach und liesse die Position laufen, bis sie
// jemand von Hand findet.
//
// Geprueft wird deshalb nicht nur "irgendeine Zahl kommt heraus",
// sondern die RICHTUNG ueber eine ganze Kursreihe.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { ErgebnisService } from './ergebnis-service.js';

describe('ErgebnisService — Vorzeichen beim SHORT', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;

  const PLAN = 'short-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'vorzeichen-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'HYPEUSDT', market_type: 'futures',
      direction: 'short', leverage: 10, total_size: 138.42983672,
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
    id: string, rolle: string, seite: string, menge: number, preis: number,
  ): void {
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'HYPEUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, { filled_quantity: menge, avg_fill_price: preis });
  }

  it('macht bei steigendem Kurs Verlust', () => {
    // Short bei 77,45 eroeffnet.
    order('e1', 'entry', 'sell', 69.21491836, 77.45);

    const bei = (kurs: number) => ergebnis.fuerPlan(PLAN, 'short', 10, kurs).unrealisiert!;

    expect(bei(77.50)).toBeLessThan(0);
    expect(bei(78.00)).toBeLessThan(0);
    expect(bei(80.00)).toBeLessThan(0);
  });

  it('macht bei fallendem Kurs Gewinn', () => {
    order('e1', 'entry', 'sell', 69.21491836, 77.45);

    const bei = (kurs: number) => ergebnis.fuerPlan(PLAN, 'short', 10, kurs).unrealisiert!;

    expect(bei(77.40)).toBeGreaterThan(0);
    expect(bei(76.00)).toBeGreaterThan(0);
    expect(bei(70.00)).toBeGreaterThan(0);
  });

  it('verschlechtert sich mit JEDEM Schritt nach oben', () => {
    // Die eigentliche Pruefung: nicht nur das Vorzeichen an einem
    // Punkt, sondern die Richtung ueber eine ganze Reihe.
    order('e1', 'entry', 'sell', 69.21491836, 77.45);

    const kurse = [77.00, 77.20, 77.45, 77.60, 77.80, 78.50];
    const werte = kurse.map(k => ergebnis.fuerPlan(PLAN, 'short', 10, k).unrealisiert!);

    for (let i = 1; i < werte.length; i++) {
      expect(werte[i]!).toBeLessThan(werte[i - 1]!);
    }
  });

  it('trifft den Betrag aus dem Betrieb genau', () => {
    // Der Fall vom 26.10.: 69,21491836 zu ø 77,45043, Kurs 77,477.
    order('e1', 'entry', 'sell', 34.60745918, 77.339);
    order('e2', 'entry', 'sell', 34.60745918, 77.5619);

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 77.477);

    expect(e.einstiegsPreis).toBeCloseTo(77.45043, 4);
    expect(e.eingestiegen).toBeCloseTo(69.21491836, 8);
    // (77,45043 − 77,477) × 69,21491836 = −1,84
    expect(e.unrealisiert).toBeCloseTo(-1.84, 2);
  });

  it('rechnet den realisierten Gewinn beim Short richtig herum', () => {
    order('e1', 'entry', 'sell', 100, 77.00);
    // Zurueckgekauft zu 76,00 — eine Mark unter dem Einstieg.
    order('tp1', 'take_profit', 'buy', 100, 76.00);

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 76.00);

    // Billiger zurueckgekauft als verkauft: 100 Gewinn.
    expect(e.realisiertBrutto).toBeCloseTo(100, 6);
  });

  it('rechnet den realisierten Verlust beim Short richtig herum', () => {
    order('e1', 'entry', 'sell', 100, 77.00);
    // Zum Stop zurueckgekauft, eine Mark ueber dem Einstieg.
    order('sl', 'stop_loss', 'buy', 100, 78.00);

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 78.00);

    expect(e.realisiertBrutto).toBeCloseTo(-100, 6);
  });

  it('zieht Gebuehren ab, statt sie gutzuschreiben', () => {
    store.insertPlanOrder({
      id: 'e1', trade_plan_id: PLAN, side: 'sell', order_type: 'limit',
      role: 'entry', symbol: 'HYPEUSDT', price: 77, quantity: 100,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('e1', { filled_quantity: 100, avg_fill_price: 77, fees: 4.62 });

    store.insertPlanOrder({
      id: 'tp1', trade_plan_id: PLAN, side: 'buy', order_type: 'market',
      role: 'take_profit', symbol: 'HYPEUSDT', price: 76, quantity: 100,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('tp1', { filled_quantity: 100, avg_fill_price: 76, fees: 4.56 });

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 76);

    expect(e.realisiertBrutto).toBeCloseTo(100, 6);
    expect(e.gebuehren).toBeCloseTo(9.18, 2);
    // Netto MUSS kleiner sein als brutto.
    expect(e.realisiert).toBeCloseTo(90.82, 2);
    expect(e.realisiert).toBeLessThan(e.realisiertBrutto);
  });

  it('gibt die Rendite beim Verlust negativ aus', () => {
    order('e1', 'entry', 'sell', 100, 77.00);
    order('sl', 'stop_loss', 'buy', 100, 78.00);

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 78.00);

    expect(e.renditePct).toBeLessThan(0);
    // 100 Verlust auf 770 Einsatz (7.700 / Hebel 10)
    expect(e.einsatz).toBeCloseTo(770, 2);
    expect(e.renditePct).toBeCloseTo(-12.99, 1);
  });
});

describe('ErgebnisService — Vorzeichen beim LONG', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;
  const PLAN = 'long-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'vorzeichen-l-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);
    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BNBUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 100,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function order(id: string, rolle: string, seite: string, menge: number, preis: number): void {
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'BNBUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, { filled_quantity: menge, avg_fill_price: preis });
  }

  it('verbessert sich mit jedem Schritt nach oben', () => {
    order('e1', 'entry', 'buy', 100, 700);

    const kurse = [650, 690, 700, 710, 750, 800];
    const werte = kurse.map(k => ergebnis.fuerPlan(PLAN, 'long', 10, k).unrealisiert!);

    for (let i = 1; i < werte.length; i++) {
      expect(werte[i]!).toBeGreaterThan(werte[i - 1]!);
    }
    // Und das Vorzeichen stimmt an den Raendern.
    expect(werte[0]!).toBeLessThan(0);
    expect(werte[werte.length - 1]!).toBeGreaterThan(0);
  });

  it('spiegelt den Short exakt', () => {
    // Derselbe Kursverlauf, entgegengesetzte Richtung: Die Betraege
    // muessen sich zu null addieren.
    order('e1', 'entry', 'buy', 100, 700);

    const long = ergebnis.fuerPlan(PLAN, 'long', 10, 750).unrealisiert!;

    store.upsertBotTradePlan({
      id: 'spiegel', source: 'signal', symbol: 'BNBUSDT', market_type: 'futures',
      direction: 'short', leverage: 10, total_size: 100,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
    store.insertPlanOrder({
      id: 's-e1', trade_plan_id: 'spiegel', side: 'sell', order_type: 'limit',
      role: 'entry', symbol: 'BNBUSDT', price: 700, quantity: 100,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('s-e1', { filled_quantity: 100, avg_fill_price: 700 });

    const short = ergebnis.fuerPlan('spiegel', 'short', 10, 750).unrealisiert!;

    expect(long + short).toBeCloseTo(0, 6);
  });
});

// ============================================================
// Der gestaffelte Einstieg — warum ein sinkender Verlust bei
// steigendem Kurs RICHTIG sein kann
//
// Am 26.10. fiel auf: Bei einem HYPEUSDT-Short wurde der Verlust
// kleiner, obwohl der Kurs stieg. Das sieht nach einem
// Vorzeichenfehler aus, ist aber keiner.
//
// Beim Short ist ein HOEHERER Einstieg der bessere. Steigt der Kurs,
// fuellen sich die hoeher liegenden Verkaufs-Limits eines
// gestaffelten Einstiegs — und heben den Durchschnitt an. Der Abstand
// zwischen Durchschnittseinstieg und Kurs kann dadurch SCHRUMPFEN,
// obwohl der Kurs gestiegen ist.
//
// Diese Tests halten fest, dass beides gleichzeitig gilt: Bei
// unveraenderter Position verschlechtert sich der Short mit
// steigendem Kurs — kommt ein besserer Einstieg hinzu, kann sich das
// Gesamtbild trotzdem aufhellen.
// ============================================================

describe('Gestaffelter Short — der Fall vom 26.10.', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;
  const PLAN = 'staffel';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'staffel-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);
    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'HYPEUSDT', market_type: 'futures',
      direction: 'short', leverage: 10, total_size: 138.42983672,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function einstieg(id: string, menge: number, preis: number): void {
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: 'sell', order_type: 'limit', role: 'entry',
      symbol: 'HYPEUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, { filled_quantity: menge, avg_fill_price: preis });
  }

  it('hebt den Durchschnittseinstieg, wenn hoeher nachverkauft wird', () => {
    einstieg('e1', 34.60745918, 77.339);
    expect(ergebnis.fuerPlan(PLAN, 'short', 10, 77.48).einstiegsPreis)
      .toBeCloseTo(77.339, 4);

    einstieg('e2', 34.60745918, 77.5619);
    // Beim Short ist hoeher besser — der Durchschnitt steigt.
    expect(ergebnis.fuerPlan(PLAN, 'short', 10, 77.48).einstiegsPreis)
      .toBeCloseTo(77.45045, 4);
  });

  it('laesst den Verlust bei gleichem Kurs schrumpfen — und das ist richtig', () => {
    einstieg('e1', 34.60745918, 77.339);
    const nurE1 = ergebnis.fuerPlan(PLAN, 'short', 10, 77.48).unrealisiert!;

    einstieg('e2', 34.60745918, 77.5619);
    const mitE2 = ergebnis.fuerPlan(PLAN, 'short', 10, 77.48).unrealisiert!;

    // Beide im Minus ...
    expect(nurE1).toBeLessThan(0);
    expect(mitE2).toBeLessThan(0);
    // ... aber der zweite Einstieg hat die Lage verbessert.
    expect(mitE2).toBeGreaterThan(nurE1);

    // Der Kontrollblick: Die Position hat sich VERDOPPELT, der
    // Verlust ist trotzdem kleiner. Genau das sah aus wie ein Fehler.
    expect(nurE1).toBeCloseTo(-4.88, 2);
    expect(mitE2).toBeCloseTo(-2.05, 2);
  });

  it('verschlechtert sich danach wieder mit jedem Schritt nach oben', () => {
    einstieg('e1', 34.60745918, 77.339);
    einstieg('e2', 34.60745918, 77.5619);

    const bei = (k: number) => ergebnis.fuerPlan(PLAN, 'short', 10, k).unrealisiert!;

    // Ohne weiteren Einstieg gilt die Regel wieder ohne Ausnahme.
    expect(bei(77.60)).toBeLessThan(bei(77.48));
    expect(bei(77.80)).toBeLessThan(bei(77.60));
    expect(bei(78.00)).toBeLessThan(bei(77.80));
  });
});

// ============================================================
// Befunde der Gegenpruefung vom 26.10.
//
// Eine unabhaengige Pruefung aller Rechenwege fand KEINEN
// Vorzeichenfehler — aber mehrere andere. Diese Tests halten die
// Korrekturen fest.
// ============================================================

describe('Gegenpruefung — Richtung wird einheitlich normalisiert', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;
  const PLAN = 'norm';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'norm-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);
    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BNBUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 100,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
    store.insertPlanOrder({
      id: 'e1', trade_plan_id: PLAN, side: 'buy', order_type: 'limit', role: 'entry',
      symbol: 'BNBUSDT', price: 700, quantity: 100, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('e1', { filled_quantity: 100, avg_fill_price: 700 });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('behandelt alles, was nicht "short" heisst, als LONG', () => {
    // Hier stand `=== 'long' ? 1 : -1`: Ein abweichender Wert wurde
    // als SHORT gerechnet, waehrend alle uebrigen Stellen im Bot
    // umgekehrt normalisieren. Dieselbe Position haette im Dashboard
    // und in der Detailansicht entgegengesetzte Vorzeichen getragen.
    const alsLong = ergebnis.fuerPlan(PLAN, 'long', 10, 750).unrealisiert!;
    expect(alsLong).toBeGreaterThan(0);

    for (const seltsam of ['LONG', 'Long', '', 'buy'] as unknown as Array<'long' | 'short'>) {
      expect(ergebnis.fuerPlan(PLAN, seltsam, 10, 750).unrealisiert!).toBeCloseTo(alsLong, 6);
    }
  });

  it('rechnet nur bei genau "short" gegenlaeufig', () => {
    expect(ergebnis.fuerPlan(PLAN, 'short', 10, 750).unrealisiert!).toBeLessThan(0);
  });
});
