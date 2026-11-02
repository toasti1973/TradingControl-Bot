// ============================================================
// Wie weit stand der Markt von den Einstiegen entfernt?
//
// Die Frage, die ein Signal beurteilt, BEVOR es gehandelt wurde — und
// die einzige, die einen Indikator entlarvt, der zu spaet sendet.
//
// Am 26.10. kam ein BTCUSDT-Short mit Einstiegen ab 80.659. Der Kurs
// stand bei 80.406 und war 13 Minuten zuvor noch bei 80.812 gewesen.
// Die Orders lagen binnen einer Sekunde im Orderbuch — gefuellt wurde
// nie eine.
//
// Aus den Trades allein waere das nie aufgefallen: Der Plan steht als
// "nicht gehandelt" da, ohne Gewinn und ohne Verlust. Ein Indikator,
// der regelmaessig so sendet, erzeugt gar keine Trades — und bliebe
// in jeder Trade-Statistik unsichtbar.
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { SignalService } from './signal-service.js';
import type { TradePlanMonitor } from './trade-plan-monitor.js';
import type { CapitalService } from './capital-service.js';
import type { Logger } from './log-service.js';

const still = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
} as unknown as Logger;

describe('SignalService — Marktlage beim Eingang', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'marktlage-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    vi.useRealTimers();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /**
   * Greift auf die private Messung zu.
   *
   * Sie laeuft tief im Annahmepfad, der eine gueltige Signatur, ein
   * Risikoprofil und einen Monitor braucht. Fuer die Rechnung selbst
   * ist nichts davon von Belang — gemessen wird sie deshalb
   * unmittelbar.
   */
  function dienstMit(kurs: number | null) {
    const monitor = { registerPlan() {} } as unknown as TradePlanMonitor;
    const kapital = { getConfig: () => ({}) } as unknown as CapitalService;

    const dienst = new SignalService(
      store, monitor, kapital, still, undefined,
      async () => kurs,
    ) as unknown as {
      marktlage(plan: {
        symbol: string; direction: string; exchange?: string;
        entry_orders: Array<{ price: number }>;
      }): Promise<{
        kurs: number; naechsterEinstieg: number; abstand: number;
        abstandPct: number; ausserhalb: boolean;
      } | null>;
    };

    return dienst;
  }

  /** Der BTCUSDT-Short vom 26.10. */
  const btcShort = {
    symbol: 'BTCUSDT',
    direction: 'short',
    exchange: 'paper',
    entry_orders: [
      { price: 80659.4 }, { price: 80774.09663291203 },
      { price: 80888.79326582406 }, { price: 81003.4898987361 },
    ],
  };

  it('misst den Abstand zum naechstgelegenen Einstieg', async () => {
    // Kurs 80.406,70, naechster Einstieg 80.659,40
    const l = await dienstMit(80406.7).marktlage(btcShort);

    expect(l!.naechsterEinstieg).toBeCloseTo(80659.4, 2);
    expect(l!.abstand).toBeCloseTo(252.7, 2);
    expect(l!.abstandPct).toBeCloseTo(0.314, 2);
  });

  it('zaehlt beim SHORT positiv, wenn der Kurs noch steigen muss', async () => {
    // Die Verkaufs-Limits liegen ueber dem Markt — der Kurs muss sich
    // auf sie zubewegen. Positiv heisst: noch nicht erreicht.
    const l = await dienstMit(80406.7).marktlage(btcShort);
    expect(l!.abstandPct).toBeGreaterThan(0);
  });

  it('zaehlt beim LONG ebenso positiv, wenn der Kurs noch fallen muss', async () => {
    // Beim Long liegen die Kauf-Limits unter dem Markt. "Noch 0,3 %
    // entfernt" muss sich in beiden Richtungen gleich lesen.
    const long = {
      symbol: 'BNBUSDT', direction: 'long', exchange: 'paper',
      entry_orders: [{ price: 739.96 }, { price: 738.39 }],
    };

    const l = await dienstMit(742.0).marktlage(long);

    expect(l!.naechsterEinstieg).toBeCloseTo(739.96, 2);
    expect(l!.abstandPct).toBeGreaterThan(0);
  });

  it('zaehlt negativ, wenn der Kurs den Einstieg schon erreicht hat', async () => {
    // Kurs ueber dem ersten Verkaufs-Limit: Der Short kann sofort
    // einsteigen.
    const l = await dienstMit(80700).marktlage(btcShort);
    expect(l!.abstandPct).toBeLessThan(0);
  });

  it('erkennt einen Kurs jenseits ALLER Einstiege', async () => {
    // Ueber dem hoechsten Limit (81.003,49): Die ganze Staffel ist
    // durchlaufen, ohne Umkehr kommt der Trade nicht mehr zustande.
    const l = await dienstMit(81500).marktlage(btcShort);
    expect(l!.ausserhalb).toBe(true);
  });

  it('erkennt beim LONG das Gegenstueck', async () => {
    const long = {
      symbol: 'BNBUSDT', direction: 'long', exchange: 'paper',
      entry_orders: [{ price: 739.96 }, { price: 735.26 }],
    };

    // Unter dem tiefsten Kauf-Limit.
    expect((await dienstMit(730).marktlage(long))!.ausserhalb).toBe(true);
    // Mittendrin ist nicht ausserhalb.
    expect((await dienstMit(737).marktlage(long))!.ausserhalb).toBe(false);
  });

  it('meldet nichts, wenn kein Kurs zu haben ist', async () => {
    // Lieber keine Angabe als eine erfundene — und gehandelt wird
    // trotzdem.
    expect(await dienstMit(null).marktlage(btcShort)).toBeNull();
  });

  it('meldet nichts ohne Einstiege', async () => {
    const ohne = { symbol: 'BTCUSDT', direction: 'short', entry_orders: [] };
    expect(await dienstMit(80000).marktlage(ohne)).toBeNull();
  });

  it('uebersteht einen Kursgeber, der wirft', async () => {
    const monitor = { registerPlan() {} } as unknown as TradePlanMonitor;
    const kapital = { getConfig: () => ({}) } as unknown as CapitalService;

    const dienst = new SignalService(
      store, monitor, kapital, still, undefined,
      async () => { throw new Error('Boerse weg'); },
    ) as unknown as { marktlage(p: unknown): Promise<unknown> };

    // Eine Messung darf kein Signal verhindern.
    await expect(dienst.marktlage(btcShort)).resolves.toBeNull();
  });
});
