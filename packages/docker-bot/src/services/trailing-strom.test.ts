// ============================================================
// Trailing-Stop am Kursstrom — Tests
//
// Der Trailing-Stop ist die einzige Groesse, die niemand ausser dem Bot
// kennt. Einstiege, Ziele und der Stop liegen als Orders an der Boerse
// (Regel 3aa) und werden dort bei jedem Tick geprueft; den Prozentsatz
// vom Hoechstkurs rechnet der Bot — und er sah alle zwei Sekunden hin.
//
// Geprueft wird hier genau das: Nimmt das Trailing das Extrem aus der
// Spanne mit, und bleibt es auch mit Spanne in der sicheren Richtung?
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TradePlanMonitor } from './trade-plan-monitor.js';

type Zustand = {
  plan: Record<string, unknown>;
  trailingBestPrice: number | null;
  slCurrent: number | null;
  trailingActive: boolean;
};

describe('Trailing-Stop mit Kursstrom', () => {
  let monitor: TradePlanMonitor;
  /** Greift auf die private Methode zu — nur hier, nur zum Pruefen. */
  let zieh: (state: Zustand, kurs: number, spanne?: { hoch: number; tief: number; ticks: number }) => void;

  beforeEach(() => {
    monitor = Object.create(TradePlanMonitor.prototype) as TradePlanMonitor;
    (monitor as unknown as { logger: unknown }).logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    zieh = (monitor as unknown as {
      updateTrailingStop: (s: Zustand, k: number, sp?: { hoch: number; tief: number; ticks: number }) => void;
    }).updateTrailingStop.bind(monitor);
  });

  const langPlan = (pct: number, aktivierung?: number) => ({
    id: 'p1', symbol: 'HYPEUSDT', direction: 'long',
    trailing_stop_pct: pct,
    ...(aktivierung != null ? { trailing_stop_activation: aktivierung } : {}),
  });

  // Der HYPEUSDT-Fall vom 25.10.2026, auf das Trailing uebertragen.
  it('hebt den Hoechstkurs auf den Docht zwischen zwei Abfragen', () => {
    const state: Zustand = {
      plan: langPlan(1.5), trailingBestPrice: 80.0, slCurrent: 78.8, trailingActive: true,
    };

    // Die Stichprobe sieht 80,1 — der Docht lief auf 80,497.
    zieh(state, 80.1, { hoch: 80.497, tief: 80.05, ticks: 42 });

    expect(state.trailingBestPrice).toBe(80.497);
    // 80,497 × 0,985 = 79,2896 — und nicht 80,1 × 0,985 = 78,8985.
    expect(state.slCurrent).toBeCloseTo(79.2896, 3);
  });

  it('nimmt beim Short das Tief der Spanne', () => {
    const state: Zustand = {
      plan: { id: 'p2', symbol: 'ETHUSDT', direction: 'short', trailing_stop_pct: 1.5 },
      trailingBestPrice: 200, slCurrent: 203, trailingActive: true,
    };

    zieh(state, 198, { hoch: 199, tief: 195.5, ticks: 30 });

    expect(state.trailingBestPrice).toBe(195.5);
    expect(state.slCurrent).toBeCloseTo(198.4325, 3);
  });

  // Das Gegen-Extrem darf das Trailing nicht verschlechtern: Ein Docht
  // nach unten ist beim Long kein Grund, den Stop zu senken — der
  // Hoechstkurs geht nie zurueck.
  it('laesst den Stop vom Gegen-Extrem unberuehrt', () => {
    const state: Zustand = {
      plan: langPlan(1.5), trailingBestPrice: 80.5, slCurrent: 79.29, trailingActive: true,
    };

    // Ein Einbruch auf 78 in der Zwischenzeit, Schluss wieder bei 80,2.
    zieh(state, 80.2, { hoch: 80.3, tief: 78.0, ticks: 55 });

    expect(state.trailingBestPrice).toBe(80.5);
    expect(state.slCurrent).toBe(79.29);
  });

  // Ohne Strom muss alles bleiben, wie es war — eine Boerse ohne
  // WebSocket darf nicht anders handeln.
  it('arbeitet ohne Spanne genau wie bisher', () => {
    const state: Zustand = {
      plan: langPlan(1.5), trailingBestPrice: 80.0, slCurrent: 78.8, trailingActive: true,
    };

    zieh(state, 80.1);

    expect(state.trailingBestPrice).toBe(80.1);
    expect(state.slCurrent).toBeCloseTo(78.8985, 3);
  });

  it('ignoriert eine Spanne ohne Ticks', () => {
    const state: Zustand = {
      plan: langPlan(1.5), trailingBestPrice: 80.0, slCurrent: 78.8, trailingActive: true,
    };

    // Kam kein Tick, steht in hoch/tief der alte Preis. Ihn zu nehmen
    // waere harmlos, ihn zu glauben nicht: `ticks: 0` heisst, dass der
    // Strom nichts gesehen hat.
    zieh(state, 80.1, { hoch: 999, tief: 1, ticks: 0 });

    expect(state.trailingBestPrice).toBe(80.1);
  });

  // Regel 3ac: Nach einem Take-Profit steht der Stop auf dem Einstand.
  // Die erste Trailing-Setzung darf ihn nicht darunter zurueckholen —
  // auch nicht, wenn die Spanne ins Spiel kommt.
  it('unterlaeuft den Einstands-Stop auch mit Spanne nicht', () => {
    const state: Zustand = {
      plan: langPlan(1.5), trailingBestPrice: null, slCurrent: 79.5, trailingActive: true,
    };

    // 80,0 × 0,985 = 78,8 — schlechter als der Einstands-Stop 79,5.
    zieh(state, 79.9, { hoch: 80.0, tief: 79.8, ticks: 12 });

    expect(state.trailingBestPrice).toBe(80.0);
    expect(state.slCurrent).toBe(79.5);
  });

  // Die Spanne darf die Aktivierungsschwelle nicht aushebeln — aber
  // sie soll sie aufloesen, wenn der Docht sie wirklich beruehrt hat.
  it('loest die Aktivierungsschwelle mit dem Docht aus', () => {
    const state: Zustand = {
      plan: langPlan(1.5, 80.4), trailingBestPrice: null, slCurrent: 78.0, trailingActive: true,
    };

    // Die Stichprobe liegt unter der Schwelle, der Docht darueber.
    zieh(state, 80.1, { hoch: 80.497, tief: 80.0, ticks: 20 });

    expect(state.trailingBestPrice).toBe(80.497);
    expect(state.slCurrent).toBeCloseTo(79.2896, 3);
  });

  it('laesst die Schwelle stehen, wenn auch der Docht sie nicht erreicht', () => {
    const state: Zustand = {
      plan: langPlan(1.5, 81.0), trailingBestPrice: null, slCurrent: 78.0, trailingActive: true,
    };

    zieh(state, 80.1, { hoch: 80.497, tief: 80.0, ticks: 20 });

    expect(state.trailingBestPrice).toBeNull();
    expect(state.slCurrent).toBe(78.0);
  });
});
