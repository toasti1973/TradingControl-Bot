// ============================================================
// Der Verlauf eines Trades
//
// Hieran wird die Guete eines Signalgebers abgelesen. Ein falsch
// zusammengesetzter Verlauf — etwa einer, der einen Stop als Gewinn
// ausweist — liesse einen schlechten Signalgeber gut aussehen.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { VerlaufService } from './verlauf-service.js';

describe('VerlaufService', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let verlauf: VerlaufService;

  const PLAN = 'plan-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'verlauf-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    verlauf = new VerlaufService(store);

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BTCUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 0.2, entry_strategy: 'equal',
      entry_orders: '[]',
      take_profits: JSON.stringify([{ price: 52000, percentage: 40 }, { price: 55000, percentage: 60 }]),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Kurzschreibweise fuer einen Protokolleintrag. */
  function eintrag(
    status: string, meta: Record<string, unknown>,
    extra: { fill_price?: number; fill_quantity?: number; entry_order_id?: string } = {},
  ) {
    store.insertExecutionReport({
      plan_id: PLAN,
      entry_order_id: extra.entry_order_id ?? null,
      symbol: 'BTCUSDT', side: 'buy', order_type: 'limit',
      status,
      fill_price: extra.fill_price ?? null,
      fill_quantity: extra.fill_quantity ?? null,
      broker: 'paper',
      metadata: meta,
      executed_at: new Date().toISOString(),
    });
  }

  it('ergibt bei leerem Protokoll keinen Verlauf', () => {
    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('–');
    expect(v.ausgang).toBe('laeuft');
    expect(v.einstiege).toBe(0);
  });

  it('setzt zwei Einstiege zu einem Block zusammen', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('filled', { role: 'entry', entry_index: 1 }, { fill_price: 49000, entry_order_id: 'e2' });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1+E2');
    expect(v.einstiege).toBe(2);
    expect(v.ausgang).toBe('laeuft');
  });

  it('zaehlt denselben Einstieg nicht doppelt (erst platziert, dann gefuellt)', () => {
    eintrag('placed', { role: 'entry', entry_index: 0, limit_price: 50000 }, { entry_order_id: 'e1' });
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.einstiege).toBe(1);
    expect(v.kette).toBe('E1');
  });

  it('bildet den vom Nutzer beschriebenen Fall: E1+E2 zu TP1 zu neuem SL', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('filled', { role: 'entry', entry_index: 1 }, { fill_price: 49000, entry_order_id: 'e2' });
    eintrag('filled', { role: 'take_profit', tp_index: 0 }, { fill_price: 52000, fill_quantity: 0.08 });
    eintrag('cancelled', { role: 'entry', reason: 'kein_nachkauf_nach_tp' });
    eintrag('event', { role: 'sl_adjusted', tp_index: 0, sl_vorher: 47000, sl_neu: 49500 });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1+E2 → TP1 → SL↑');
    expect(v.tpsErreicht).toBe(1);
    expect(v.slNachgezogen).toBe(true);
    expect(v.slAktuell).toBe(49500);
    expect(v.slGetroffen).toBe(false);
    expect(v.ausgang).toBe('laeuft');
  });

  it('bildet den zweiten Fall: vier Einstiege, dann Stop', () => {
    for (let i = 0; i < 4; i++) {
      eintrag('filled', { role: 'entry', entry_index: i }, { fill_price: 50000 - i * 500, entry_order_id: `e${i}` });
    }
    eintrag('filled', { role: 'stop_loss' }, { fill_price: 47000, fill_quantity: 0.4 });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1+E2+E3+E4 → SL');
    expect(v.einstiege).toBe(4);
    expect(v.slGetroffen).toBe(true);
    // Stop ohne vorherigen Take-Profit — das ist der schlechte Ausgang.
    expect(v.ausgang).toBe('im_verlust_beendet');
  });

  it('unterscheidet den Stop nach einem Take-Profit vom Stop ohne', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('filled', { role: 'take_profit', tp_index: 0 }, { fill_price: 52000 });
    eintrag('event', { role: 'sl_adjusted', sl_vorher: 47000, sl_neu: 50000 });
    eintrag('filled', { role: 'stop_loss' }, { fill_price: 50000 });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1 → TP1 → SL↑ → SL');
    // Gewinn mitgenommen, dann am nachgezogenen Stop beendet — gut.
    expect(v.ausgang).toBe('im_gewinn_beendet');
  });

  it('erkennt den vollstaendig gelaufenen Trade', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('filled', { role: 'take_profit', tp_index: 0 }, { fill_price: 52000 });
    eintrag('filled', { role: 'take_profit', tp_index: 1 }, { fill_price: 55000 });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1 → TP1 → TP2');
    expect(v.tpsErreicht).toBe(2);
    expect(v.ausgang).toBe('vollstaendig');
  });

  it('nimmt den Trailing-Stop in die Kette auf', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('filled', { role: 'take_profit', tp_index: 0 }, { fill_price: 52000 });
    eintrag('event', { role: 'trailing_activated', tp_index: 0, trailing_pct: 2, ab_preis: 52000 });
    eintrag('filled', { role: 'trailing_stop' }, { fill_price: 51000 });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1 → TP1 → TS → SL');
    expect(v.ausgang).toBe('im_gewinn_beendet');
  });

  it('haelt Stornierung und Ablehnung aus der Kurzfassung heraus', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('rejected', { role: 'entry', reason: 'trigger_not_met' });
    eintrag('filled', { role: 'take_profit', tp_index: 0 }, { fill_price: 52000 });
    eintrag('cancelled', { role: 'entry', reason: 'kein_nachkauf_nach_tp' });

    const v = verlauf.fuerPlan(PLAN);
    // Die Kette bleibt lesbar …
    expect(v.kette).toBe('E1 → TP1');
    // … die Einzelheiten stehen trotzdem in der Zeitleiste.
    const arten = v.ereignisse.map(e => e.art);
    expect(arten).toContain('abgelehnt');
    expect(arten).toContain('storniert');
  });

  it('meldet einen stornierten Plan als storniert', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    store.updateBotTradePlanStatus(PLAN, 'cancelled');

    expect(verlauf.fuerPlan(PLAN).ausgang).toBe('storniert');
  });

  it('meldet einen abgeschlossenen Plan ohne Einstieg als folgenlos', () => {
    eintrag('rejected', { role: 'entry', reason: 'trigger_not_met' });
    store.updateBotTradePlanStatus(PLAN, 'completed');

    const v = verlauf.fuerPlan(PLAN);
    expect(v.einstiege).toBe(0);
    expect(v.ausgang).toBe('nichts_geschehen');
  });

  it('haelt die Zeitleiste in der Reihenfolge des Geschehens', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    eintrag('filled', { role: 'take_profit', tp_index: 0 }, { fill_price: 52000 });
    eintrag('filled', { role: 'stop_loss' }, { fill_price: 50000 });

    const arten = verlauf.fuerPlan(PLAN).ereignisse.map(e => e.art);
    expect(arten).toEqual(['einstieg', 'tp', 'sl']);
  });

  it('kommt mit unlesbaren Protokolldaten zurecht', () => {
    eintrag('filled', { role: 'entry', entry_index: 0 }, { fill_price: 50000, entry_order_id: 'e1' });
    // Eintrag mit kaputtem metadata_json direkt einschleusen
    store.insertExecutionReport({
      plan_id: PLAN, symbol: 'BTCUSDT', side: 'buy', order_type: 'limit',
      status: 'filled', broker: 'paper', executed_at: new Date().toISOString(),
    });

    const v = verlauf.fuerPlan(PLAN);
    expect(v.kette).toBe('E1');
    expect(v.einstiege).toBe(1);
  });
});
