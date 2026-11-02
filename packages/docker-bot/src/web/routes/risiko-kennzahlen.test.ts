// ============================================================
// Die Risiko-Kennzahlen des Dashboards
//
// Sie standen auf 0,0 %, waehrend 92,80 USDT verloren waren. Der Grund
// lag in der Trennung der Ausfuehrungspfade (CLAUDE.md, Regel 3): Der
// RiskGuard der TradingEngine kennt nur, was ueber IHREN Pfad lief —
// die Signal-Plaene laufen ueber den TradePlanMonitor und wurden ihm
// nie gemeldet.
//
// Eine Risikoanzeige, die den gerade laufenden Handel nicht sieht, ist
// schlimmer als gar keine: Sie beruhigt.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../store/sqlite-store.js';
import { ErgebnisService } from '../../services/ergebnis-service.js';
import { risikoKennzahlen, verwendetesKapital, hoechstes } from './dashboard.js';

describe('Risiko-Kennzahlen', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;

  const PLAN = 'plan-risiko';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'risiko-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BNBUSDT', market_type: 'futures',
      direction: 'long', leverage: 22, total_size: 10,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'completed', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /**
   * Eine gefuellte Order mit einem bestimmten Zeitpunkt.
   *
   * `updated_at` zu setzen ist der Kern: Daran haengt, in welchen
   * Zeitraum ein Abschluss faellt.
   */
  function order(
    rolle: string, seite: string, menge: number, preis: number,
    vorStunden: number, gebuehr = 0,
  ): void {
    const id = `o-${rolle}-${preis}-${vorStunden}`;
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'market', role: rolle,
      symbol: 'BNBUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, {
      filled_quantity: menge, avg_fill_price: preis, fees: gebuehr,
    });

    // Den Zeitstempel setzen — die Spalte traegt sonst "jetzt".
    const zeit = new Date(Date.now() - vorStunden * 3_600_000)
      .toISOString().replace('T', ' ').slice(0, 19);
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
      .db.prepare('UPDATE bot_trade_plan_orders SET updated_at = ?, placed_at = ? WHERE id = ?')
      .run(zeit, zeit, id);
  }

  it('weist einen Verlust von heute aus', () => {
    // Einstieg bei 700, Stop bei 650 — 10 Stueck, also 500 Verlust.
    order('entry', 'buy', 10, 700, 3);
    order('stop_loss', 'sell', 10, 650, 1);

    const k = risikoKennzahlen(store, ergebnis, 10_000);

    expect(k.realisiertHeute).toBeCloseTo(-500, 2);
    // 500 von 10.000 sind 5 %.
    expect(k.tagesverlustPct).toBeCloseTo(5, 2);
  });

  it('zaehlt die Gebuehren zum Verlust', () => {
    order('entry', 'buy', 10, 700, 3, 4.2);
    order('stop_loss', 'sell', 10, 650, 1, 3.9);

    const k = risikoKennzahlen(store, ergebnis, 10_000);

    // 500 Kursverlust plus 8,10 Gebuehren.
    expect(k.realisiertHeute).toBeCloseTo(-508.1, 2);
  });

  it('laesst den Tagesverlust bei einem Gewinntag auf null', () => {
    order('entry', 'buy', 10, 700, 3);
    order('take_profit', 'sell', 10, 750, 1);

    const k = risikoKennzahlen(store, ergebnis, 10_000);

    expect(k.realisiertHeute).toBeCloseTo(500, 2);
    // Ein Gewinntag ist kein negativer Verlust — er ist gar keiner.
    expect(k.tagesverlustPct).toBe(0);
  });

  it('trennt Tag und Woche', () => {
    // Vor vier Tagen verloren, heute nichts.
    order('entry', 'buy', 10, 700, 100);
    order('stop_loss', 'sell', 10, 650, 98);

    const k = risikoKennzahlen(store, ergebnis, 10_000);

    expect(k.tagesverlustPct).toBe(0);
    expect(k.wochenverlustPct).toBeCloseTo(5, 2);
  });

  it('rechnet beim Short mit umgekehrtem Vorzeichen', () => {
    store.upsertBotTradePlan({
      id: 'plan-short', source: 'signal', symbol: 'HYPEUSDT', market_type: 'futures',
      direction: 'short', leverage: 16, total_size: 100,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'completed', bot_enabled: true,
    });

    // Short bei 75 eingestiegen, bei 76 gestoppt: 100 Stueck, 100 Verlust.
    store.insertPlanOrder({
      id: 's-e', trade_plan_id: 'plan-short', side: 'sell', order_type: 'market',
      role: 'entry', symbol: 'HYPEUSDT', price: 75, quantity: 100,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('s-e', { filled_quantity: 100, avg_fill_price: 75 });
    store.insertPlanOrder({
      id: 's-sl', trade_plan_id: 'plan-short', side: 'buy', order_type: 'market',
      role: 'stop_loss', symbol: 'HYPEUSDT', price: 76, quantity: 100,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('s-sl', { filled_quantity: 100, avg_fill_price: 76 });

    const k = risikoKennzahlen(store, ergebnis, 10_000);

    // Beim Short ist ein steigender Kurs der Verlust.
    expect(k.realisiertHeute).toBeCloseTo(-100, 2);
  });

  it('misst den Drawdown vom Hoechststand, nicht vom Startkapital', () => {
    // Erst 500 gewonnen, dann 300 verloren. Der aktuelle Stand liegt
    // ueber dem Start — der Drawdown ist trotzdem nicht null.
    order('entry', 'buy', 10, 700, 10);
    order('take_profit', 'sell', 10, 750, 8);

    store.upsertBotTradePlan({
      id: 'plan-2', source: 'signal', symbol: 'ETHUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 10,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'completed', bot_enabled: true,
    });
    store.insertPlanOrder({
      id: 'p2-e', trade_plan_id: 'plan-2', side: 'buy', order_type: 'market',
      role: 'entry', symbol: 'ETHUSDT', price: 100, quantity: 10,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('p2-e', { filled_quantity: 10, avg_fill_price: 100 });
    store.insertPlanOrder({
      id: 'p2-sl', trade_plan_id: 'plan-2', side: 'sell', order_type: 'market',
      role: 'stop_loss', symbol: 'ETHUSDT', price: 70, quantity: 10,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('p2-sl', { filled_quantity: 10, avg_fill_price: 70 });

    // Kapital jetzt: 10.200 (Start 10.000 + 500 − 300)
    const k = risikoKennzahlen(store, ergebnis, 10_200);

    // Hoechststand war 10.500, jetzt 10.200 → 2,86 % Drawdown.
    expect(k.drawdownPct).toBeCloseTo((300 / 10_500) * 100, 1);
    expect(k.drawdownPct).toBeGreaterThan(0);
  });

  it('bleibt bei null, solange nichts geschlossen wurde', () => {
    // Nur ein Einstieg — nichts realisiert.
    order('entry', 'buy', 10, 700, 2);

    const k = risikoKennzahlen(store, ergebnis, 10_000);

    expect(k.tagesverlustPct).toBe(0);
    expect(k.wochenverlustPct).toBe(0);
    expect(k.drawdownPct).toBe(0);
  });

  it('gibt Nullwerte zurueck, wenn kein Kapital bekannt ist', () => {
    order('entry', 'buy', 10, 700, 3);
    order('stop_loss', 'sell', 10, 650, 1);

    // Ohne Bezugsgroesse laesst sich kein Prozentsatz bilden — eine
    // erfundene waere schlimmer als keine.
    const k = risikoKennzahlen(store, ergebnis, 0);

    expect(k.tagesverlustPct).toBe(0);
    expect(k.drawdownPct).toBe(0);
  });
});

describe('verwendetesKapital', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'kapital-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('nimmt den Kontostand des Uebungskontos', () => {
    store.upsertPaperAccount({
      waehrung: 'USDT', startkapital: 10_000, realisiert: -80, gebuehren: 12.8,
      trades: 3, gewinne: 1, verluste: 2, taker_satz: 0.0006, maker_satz: 0.0001,
    });

    // 10.000 − 80 − 12,80
    expect(verwendetesKapital(store)).toBeCloseTo(9907.2, 2);
  });

  it('faellt auf das Startkapital zurueck, wenn das Konto leer gelaufen ist', () => {
    store.upsertPaperAccount({
      waehrung: 'USDT', startkapital: 10_000, realisiert: -10_000, gebuehren: 50,
      trades: 9, gewinne: 0, verluste: 9, taker_satz: 0.0006, maker_satz: 0.0001,
    });

    // Ein Equity von −50 ergaebe negative Prozentsaetze.
    expect(verwendetesKapital(store)).toBe(10_000);
  });

  it('liefert 0 ohne Uebungskonto', () => {
    expect(verwendetesKapital(store)).toBe(0);
  });
});

describe('hoechstes — die vorsichtigere Auskunft', () => {
  it('nimmt die eigene Rechnung, wenn der RiskGuard nichts sieht', () => {
    // Genau der Fall vom 25.10.: eigene Rechnung 0,93 %, Guard 0.
    expect(hoechstes(0.93, 0)).toBeCloseTo(0.93, 4);
  });

  it('nimmt den RiskGuard, wenn er mehr sieht', () => {
    // Er kennt Verluste, die nicht ueber Plaene liefen.
    expect(hoechstes(1, 0.05)).toBeCloseTo(5, 4);
  });

  it('kommt ohne RiskGuard aus', () => {
    expect(hoechstes(2.5, undefined)).toBeCloseTo(2.5, 4);
  });
});
