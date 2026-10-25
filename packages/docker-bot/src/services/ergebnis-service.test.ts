// ============================================================
// Was hat ein Plan eingebracht?
//
// Eine falsche Zahl hier ist schlimmer als gar keine: Wer glaubt, ein
// Trade sei im Gewinn, laesst ihn laufen. Besonderes Augenmerk liegt
// deshalb auf dem Vorzeichen beim Short und auf der Trennung von
// realisiert und nicht realisiert.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { ErgebnisService } from './ergebnis-service.js';

describe('ErgebnisService', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;

  const PLAN = 'plan-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'ergebnis-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BTCUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 0.2, entry_strategy: 'equal',
      entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Eine abgeschickte und gefuellte Order. */
  function order(
    rolle: 'entry' | 'take_profit' | 'stop_loss',
    seite: 'buy' | 'sell',
    menge: number,
    preis: number,
    extra: { gefuellt?: number; gebuehr?: number } = {},
  ) {
    const id = `${rolle}-${seite}-${menge}-${preis}`;
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'BTCUSDT', price: preis, quantity: menge,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, {
      filled_quantity: extra.gefuellt ?? menge,
      avg_fill_price: preis,
      fees: extra.gebuehr,
      fee_currency: extra.gebuehr ? 'USDT' : undefined,
    });
  }

  it('meldet nichts, solange kein Einstieg gefuellt wurde', () => {
    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

    expect(e.eingestiegen).toBe(0);
    expect(e.realisiert).toBe(0);
    expect(e.unrealisiert).toBeNull();
    expect(e.einstiegsPreis).toBeNull();
  });

  it('rechnet einen Long mit vollstaendigem Ausstieg', () => {
    order('entry', 'buy', 0.2, 50_000);
    order('take_profit', 'sell', 0.2, 52_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 52_000);

    // 0.2 * (52000 - 50000) = 400
    expect(e.realisiertBrutto).toBe(400);
    expect(e.realisiert).toBe(400);
    expect(e.offen).toBe(0);
    expect(e.unrealisiert).toBeNull();
    // Einsatz: 0.2 * 50000 / 10 = 1000 → 40 %
    expect(e.einsatz).toBe(1000);
    expect(e.renditePct).toBe(40);
  });

  it('dreht das Vorzeichen beim Short', () => {
    // Short: Einstieg ist der Verkauf, der Rueckkauf tiefer ist Gewinn.
    order('entry', 'sell', 0.2, 50_000);
    order('take_profit', 'buy', 0.2, 48_000);

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 48_000);

    expect(e.realisiert).toBe(400);
    expect(e.renditePct).toBe(40);
  });

  it('weist einen Verlust als solchen aus', () => {
    order('entry', 'buy', 0.2, 50_000);
    order('stop_loss', 'sell', 0.2, 49_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 49_000);

    expect(e.realisiert).toBe(-200);
    expect(e.renditePct).toBe(-20);
  });

  it('trennt realisiert und nicht realisiert bei einer Teilschliessung', () => {
    order('entry', 'buy', 0.2, 50_000);
    order('take_profit', 'sell', 0.1, 52_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 51_000);

    // Realisiert: 0.1 * (52000 - 50000) = 200
    expect(e.realisiert).toBe(200);
    // Offen: 0.1 zum Kurs 51000 → 0.1 * (51000 - 50000) = 100
    expect(e.offen).toBeCloseTo(0.1, 10);
    expect(e.unrealisiert).toBe(100);
    expect(e.gesamt).toBe(300);
  });

  it('mittelt mehrere Einstiege zu unterschiedlichen Preisen', () => {
    order('entry', 'buy', 0.1, 50_000);
    order('entry', 'buy', 0.1, 48_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 49_000);

    expect(e.einstiegsPreis).toBe(49_000);
    // Zum Durchschnitt selbst ist nichts gewonnen.
    expect(e.unrealisiert).toBe(0);
  });

  it('zieht die Gebuehren vom Ergebnis ab und weist sie getrennt aus', () => {
    order('entry', 'buy', 0.2, 50_000, { gebuehr: 6 });
    order('take_profit', 'sell', 0.2, 52_000, { gebuehr: 6.24 });

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 52_000);

    expect(e.realisiertBrutto).toBe(400);
    expect(e.gebuehren).toBe(12.24);
    expect(e.realisiert).toBe(387.76);
  });

  it('laesst das nicht realisierte Ergebnis offen, wenn kein Kurs vorliegt', () => {
    order('entry', 'buy', 0.2, 50_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, null);

    // Lieber eine Luecke als eine erfundene Zahl.
    expect(e.unrealisiert).toBeNull();
    expect(e.kurs).toBeNull();
    expect(e.offen).toBeCloseTo(0.2, 10);
  });

  it('uebergeht Orders ohne Fuellpreis, statt den Durchschnitt zu verfaelschen', () => {
    order('entry', 'buy', 0.1, 50_000);

    // Platziert, aber nie gefuellt: keine Menge, kein Preis.
    store.insertPlanOrder({
      id: 'offen-1', trade_plan_id: PLAN, side: 'buy', order_type: 'limit',
      role: 'entry', symbol: 'BTCUSDT', price: 48_000, quantity: 0.1,
      status: 'placed', broker: 'paper',
    });

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

    expect(e.eingestiegen).toBeCloseTo(0.1, 10);
    expect(e.einstiegsPreis).toBe(50_000);
  });
});
