// ============================================================
// Auswertung der Signale
//
// Die Frage, auf die alles hinauslaeuft: Taugt der Signalgeber? Dafuer
// zaehlt vor allem eine Gruppe — die Trades, die in den Stop liefen,
// OHNE vorher einen Take-Profit mitgenommen zu haben. Sie sind der
// volle Verlust.
//
// Die Abgrenzung ist der Kern dieser Datei: Wer TP1 mitnahm und dann
// gestoppt wurde, gehoert NICHT dazu. Dort hat die Strategie
// funktioniert, nur nicht bis zum Ende — und wer beides in einen Topf
// wirft, verwirft einen brauchbaren Signalgeber.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../store/sqlite-store.js';
import { VerlaufService } from '../../services/verlauf-service.js';
import { auswertungsZeilen, csvFeld } from './signals.js';

describe('Signal-Auswertung — Fehlschlaege', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let verlauf: VerlaufService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'auswertung-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    verlauf = new VerlaufService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Ein Signal-Plan mit Herkunftsangabe. */
  function plan(id: string, symbol = 'BNBUSDT', richtung: 'long' | 'short' = 'long'): void {
    store.upsertBotTradePlan({
      id, source: 'signal', symbol, market_type: 'futures',
      direction: richtung, leverage: 10, total_size: 1,
      entry_strategy: 'equal',
      entry_orders: JSON.stringify([{ id: 'e1', price: 100, size: 1 }]),
      take_profits: JSON.stringify([{ price: 110 }, { price: 120 }]),
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'completed', bot_enabled: true,
      signal_origin: JSON.stringify({
        strategy: 'MBCMA-f23', signal_id: `sig-${id}`,
        received_at: '2026-10-25T10:00:00.000Z',
      }),
    });
  }

  function order(
    planId: string, rolle: string, seite: string, menge: number, preis: number,
  ): void {
    const id = `${planId}-${rolle}-${preis}`;
    store.insertPlanOrder({
      id, trade_plan_id: planId, side: seite, order_type: 'market', role: rolle,
      symbol: 'BNBUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, { filled_quantity: menge, avg_fill_price: preis });
  }

  it('erkennt den Stop ohne Take-Profit als Fehlschlag', () => {
    plan('p1');
    order('p1', 'entry', 'buy', 1, 100);
    order('p1', 'stop_loss', 'sell', 1, 90);

    const zeilen = auswertungsZeilen(store, verlauf, false);

    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]!.istFehlschlag).toBe(true);
    expect(zeilen[0]!.realisiert).toBeCloseTo(-10, 2);
  });

  it('zaehlt einen Stop NACH einem Take-Profit nicht als Fehlschlag', () => {
    // Der entscheidende Unterschied: Hier hat die Strategie gegriffen.
    plan('p2');
    order('p2', 'entry', 'buy', 1, 100);
    order('p2', 'take_profit', 'sell', 0.5, 110);
    order('p2', 'stop_loss', 'sell', 0.5, 95);

    const zeilen = auswertungsZeilen(store, verlauf, false);

    expect(zeilen[0]!.istFehlschlag).toBe(false);
    expect(zeilen[0]!.tpsErreicht).toBeGreaterThan(0);
  });

  it('zaehlt einen Abschluss im Plus nicht als Fehlschlag', () => {
    // Der Fall BNBUSDT vom 25.10.: Der Take-Profit wurde abgewiesen,
    // das Schliessen von Hand als `stop_loss` verbucht — und der Trade
    // endete mit +17,43. Nach Rollen allein waere das ein Fehlschlag;
    // nach dem Ergebnis ist es keiner.
    plan('p-plus');
    order('p-plus', 'entry', 'buy', 1, 100);
    order('p-plus', 'stop_loss', 'sell', 1, 117);

    const z = auswertungsZeilen(store, verlauf, false)[0]!;

    expect(z.realisiert).toBeGreaterThan(0);
    expect(z.istFehlschlag).toBe(false);
  });

  it('zaehlt einen Plan ohne Einstieg nicht als Fehlschlag', () => {
    // Nie im Markt gewesen — da kann nichts fehlgeschlagen sein.
    plan('p3');

    const zeilen = auswertungsZeilen(store, verlauf, false);

    expect(zeilen[0]!.istFehlschlag).toBe(false);
    expect(zeilen[0]!.eingestiegen).toBe(0);
  });

  it('filtert auf Wunsch nur die Fehlschlaege', () => {
    plan('p1');
    order('p1', 'entry', 'buy', 1, 100);
    order('p1', 'stop_loss', 'sell', 1, 90);

    plan('p2');
    order('p2', 'entry', 'buy', 1, 100);
    order('p2', 'take_profit', 'sell', 1, 110);

    expect(auswertungsZeilen(store, verlauf, false)).toHaveLength(2);
    const nurFehler = auswertungsZeilen(store, verlauf, true);
    expect(nurFehler).toHaveLength(1);
    expect(nurFehler[0]!.planId).toBe('p1');
  });

  it('uebergeht Plaene, die nicht aus einem Signal stammen', () => {
    store.upsertBotTradePlan({
      id: 'lokal-1', source: 'local', symbol: 'ETHUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 1, entry_strategy: 'equal',
      entry_orders: '[]', take_profits: '[]', activation_conditions: '[]',
      executed_orders: '[]', execution_mode: 'all_limit',
      status: 'completed', bot_enabled: true,
    });

    expect(auswertungsZeilen(store, verlauf, false)).toHaveLength(0);
  });

  it('traegt Strategie und Signal-Kennung mit', () => {
    plan('p1');
    order('p1', 'entry', 'buy', 1, 100);
    order('p1', 'stop_loss', 'sell', 1, 90);

    const z = auswertungsZeilen(store, verlauf, true)[0]!;

    expect(z.strategie).toBe('MBCMA-f23');
    expect(z.signalId).toBe('sig-p1');
    // Ohne diese beiden liesse sich nicht sagen, WELCHER Signalgeber
    // die Fehlschlaege erzeugt.
  });

  it('rechnet beim Short mit umgekehrtem Vorzeichen', () => {
    plan('s1', 'HYPEUSDT', 'short');
    order('s1', 'entry', 'sell', 100, 75);
    order('s1', 'stop_loss', 'buy', 100, 76);

    const z = auswertungsZeilen(store, verlauf, false)[0]!;

    expect(z.istFehlschlag).toBe(true);
    // Short bei 75 eroeffnet, bei 76 gestoppt: 100 Verlust.
    expect(z.realisiert).toBeCloseTo(-100, 2);
  });
});

describe('csvFeld — Daten, die eine Tabellenkalkulation lesen kann', () => {
  it('setzt das deutsche Dezimalkomma', () => {
    expect(csvFeld(17.43)).toBe('17,43');
    expect(csvFeld(-110.23)).toBe('-110,23');
  });

  it('fasst Text mit Semikolon ein', () => {
    // Ohne das zerfiele die Zelle in zwei Spalten.
    expect(csvFeld('a;b')).toBe('"a;b"');
  });

  it('verdoppelt Anfuehrungszeichen im Text', () => {
    expect(csvFeld('er sagte "ja"')).toBe('"er sagte ""ja"""');
  });

  it('laesst eine Verlaufskette unversehrt', () => {
    // Pfeile und Pluszeichen sind unbedenklich — sie trennen nichts.
    expect(csvFeld('E1+E2 → TP1 → SL')).toBe('E1+E2 → TP1 → SL');
  });

  it('macht aus null ein leeres Feld', () => {
    expect(csvFeld(null)).toBe('');
    expect(csvFeld(undefined)).toBe('');
  });

  it('laesst unendliche Zahlen leer, statt "Infinity" zu schreiben', () => {
    expect(csvFeld(Infinity)).toBe('');
    expect(csvFeld(NaN)).toBe('');
  });
});
