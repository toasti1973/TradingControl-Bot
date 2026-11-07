// ============================================================
// Ein Plan zu speichern darf seine Orders nicht löschen
//
// `INSERT OR REPLACE` ist in SQLite ein DELETE gefolgt von einem
// INSERT. Mit eingeschalteten Fremdschlüsseln und
//
//     FOREIGN KEY (trade_plan_id) REFERENCES bot_trade_plans(id)
//       ON DELETE CASCADE
//
// löscht jedes Speichern eines Plans damit sämtliche Orders dieses
// Plans.
//
// Der TcPlanSyncService speichert bei jedem Abgleich — alle 30
// Sekunden. Daraus wurde eine Schleife:
//
//     Abgleich → REPLACE → Orders weg → der Monitor sieht nichts
//     Platziertes → legt alle Einstiege neu → 30 s → von vorn
//
// Am 04.11.2026 stand ein BTCUSDT-Plan deshalb dreimal mit
// „Einstieg 1/2/3 platziert" im Verlauf, während die Order-Tabelle
// leer blieb. Einen Tag zuvor war es gefährlicher: `offenePosition()`
// rechnet aus den Orders, und weil die gelöscht waren, hielt der
// Storno-Pfad eine offene Position für geschlossen — sie blieb
// ungesichert stehen.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.js';

describe('upsertBotTradePlan — Orders überleben das Speichern', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  const PLAN = 'plan-1';

  function plan(aenderungen: Record<string, unknown> = {}) {
    return {
      id: PLAN, source: 'tc' as const, symbol: 'BTCUSDT', market_type: 'futures',
      direction: 'long', leverage: 3, total_size: 0.0176,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
      exchange: 'phemex',
      ...aenderungen,
    };
  }

  function order(id: string, rolle = 'entry') {
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: 'buy', order_type: 'limit', role: rolle,
      symbol: 'BTCUSDT', price: 50_000, quantity: 0.00588235,
      status: 'new', broker: 'phemex', broker_order_id: 'b-' + id,
    });
  }

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'upsert-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    store.upsertBotTradePlan(plan() as never);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('behält die Orders, wenn der Plan erneut gespeichert wird', () => {
    order('o1'); order('o2'); order('o3');
    expect(store.getPlanOrders(PLAN)).toHaveLength(3);

    // Genau das tut der TC-Abgleich alle 30 Sekunden.
    store.upsertBotTradePlan(plan() as never);

    expect(store.getPlanOrders(PLAN), 'Die Orders wurden gelöscht').toHaveLength(3);
  });

  it('übersteht viele Abgleiche hintereinander', () => {
    order('o1');
    for (let i = 0; i < 20; i++) store.upsertBotTradePlan(plan() as never);
    expect(store.getPlanOrders(PLAN)).toHaveLength(1);
  });

  it('aktualisiert die Felder trotzdem', () => {
    store.upsertBotTradePlan(plan({ status: 'cancelled', leverage: 7 }) as never);

    const p = store.getBotTradePlan(PLAN)!;
    expect(p.status).toBe('cancelled');
    expect(p.leverage).toBe(7);
  });

  it('behält auch gefüllte Mengen', () => {
    order('o1');
    store.updatePlanOrder('o1', { filled_quantity: 0.005, avg_fill_price: 50_000 });

    store.upsertBotTradePlan(plan() as never);

    const o = store.getPlanOrders(PLAN)[0]!;
    // Ginge das verloren, hielte `offenePosition()` eine offene
    // Position für geschlossen — der Fall vom 03.11.
    expect(Number(o.filled_quantity)).toBeCloseTo(0.005, 8);
    expect(Number(o.avg_fill_price)).toBe(50_000);
  });

  it('legt einen neuen Plan weiterhin an', () => {
    store.upsertBotTradePlan(plan({ id: 'plan-2' }) as never);
    expect(store.getBotTradePlan('plan-2')).toBeTruthy();
  });

  // Die Kaskade selbst ist richtig und soll bleiben: Wer einen Plan
  // wirklich löscht, will seine Orders nicht behalten.
  it('löscht die Orders sehr wohl, wenn der Plan gelöscht wird', () => {
    order('o1');
    const db = (store as unknown as {
      db: { prepare(s: string): { run(...a: unknown[]): void } };
    }).db;
    db.prepare('DELETE FROM bot_trade_plans WHERE id = ?').run(PLAN);

    expect(store.getPlanOrders(PLAN)).toHaveLength(0);
  });
});
