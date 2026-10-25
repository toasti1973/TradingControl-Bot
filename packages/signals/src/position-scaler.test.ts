import { describe, it, expect } from 'vitest';
import { PositionScaler, pruefeUnveraendert } from './position-scaler.js';
import { STANDARD_RISIKOPROFIL } from './types.js';
import type { CapitalSnapshot, RiskProfile, TradeSignal } from './types.js';

// ============================================================
// Ein Signal, wie es der Indikator schickt: ausgelegt auf 10.000 USDT
//
//   BTC-Long, Hebel 10
//   Einstieg: 0.1 BTC zu 50.000  → 5.000 Notional, 500 Margin
//   Stop-Loss 48.000             → Risiko 0.1 * 2.000 = 200 (2 % von 10.000)
// ============================================================
function signal(aenderungen: Partial<TradeSignal> = {}): TradeSignal {
  return {
    version: 1,
    signal_id: 'test-1',
    strategy: 'Pruefstrategie',
    emitted_at: '2026-10-24T08:00:00.000Z',
    action: 'open',
    reference_capital: 10_000,
    exchange: 'bybit',
    symbol: 'BTCUSDT',
    asset_symbol: 'BTC',
    quote_currency: 'USDT',
    market_type: 'futures',
    direction: 'long',
    leverage: 10,
    total_size: 0.1,
    total_margin: 500,
    entry_strategy: 'single',
    entry_orders: [
      { id: 'e1', price: 50_000, size: 0.1, order_type: 'limit', status: 'pending' },
    ],
    entry_zones: null,
    execution_mode: 'all_limit',
    take_profits: [
      { price: 52_000, percentage: 50, order_type: 'limit', status: 'pending' },
      { price: 55_000, percentage: 50, order_type: 'limit', status: 'pending' },
    ],
    stop_loss_price: 48_000,
    stop_loss_type: 'fixed',
    trailing_stop_pct: null,
    trailing_stop_activation: null,
    trailing_stop_size_pct: null,
    activation_conditions: [],
    target_plan_id: null,
    tag: null,
    notes: null,
    extra: {},
    ...aenderungen,
  };
}

function kapital(equity: number, free = equity): CapitalSnapshot {
  return {
    equity, free, quoteCurrency: 'USDT', source: 'exchange',
    at: '2026-10-24T08:00:00.000Z',
  };
}

/** Grenzen abgeschaltet — isoliert die reine Kapitalrechnung. */
const OHNE_GRENZEN: Partial<RiskProfile> = {
  maxRiskPerTradePct: 0,
  maxMarginPerTradePct: 0,
  usableFreeMarginPct: 1,
};

describe('PositionScaler — Umrechnung auf das vorhandene Kapital', () => {
  const scaler = new PositionScaler();

  it('viertelt die Groesse bei einem Viertel des Referenzkapitals', () => {
    const { decision, signal: s } = scaler.scale({
      signal: signal(), capital: kapital(2_500), profile: OHNE_GRENZEN,
    });

    expect(decision.accepted).toBe(true);
    expect(decision.factor).toBeCloseTo(0.25, 10);
    expect(s!.total_size).toBeCloseTo(0.025, 10);
    expect(s!.entry_orders[0]!.size).toBeCloseTo(0.025, 10);
    expect(s!.total_margin).toBeCloseTo(125, 6);
  });

  it('verdoppelt bei doppeltem Kapital', () => {
    const { decision, signal: s } = scaler.scale({
      signal: signal(), capital: kapital(20_000), profile: OHNE_GRENZEN,
    });

    expect(decision.factor).toBeCloseTo(2, 10);
    expect(s!.entry_orders[0]!.size).toBeCloseTo(0.2, 10);
    expect(s!.total_margin).toBeCloseTo(1_000, 6);
  });

  it('laesst bei genau dem Referenzkapital alles, wie es ist', () => {
    const vorher = signal();
    const { decision, signal: s } = scaler.scale({
      signal: vorher, capital: kapital(10_000), profile: OHNE_GRENZEN,
    });

    expect(decision.factor).toBeCloseTo(1, 10);
    expect(s!.total_size).toBeCloseTo(vorher.total_size, 10);
    expect(s!.total_margin).toBeCloseTo(500, 6);
  });
});

describe('PositionScaler — was unangetastet bleiben muss', () => {
  const scaler = new PositionScaler();

  it('ruehrt Hebel, Stop-Loss, Take-Profits und Trailing nicht an', () => {
    const vorher = signal({
      stop_loss_type: 'trailing',
      trailing_stop_pct: 1.5,
      trailing_stop_activation: 51_000,
      trailing_stop_size_pct: 75,
      take_profits: [
        {
          price: 52_000, percentage: 40, order_type: 'limit', status: 'pending',
          sl_adjust: true, sl_new_price: 50_000,
        },
        {
          price: 55_000, percentage: 60, order_type: 'limit', status: 'pending',
          activate_trailing: true, trailing_pct: 2,
        },
      ],
      activation_conditions: [{ price: 49_500 }],
    });

    const { signal: s } = scaler.scale({
      signal: vorher, capital: kapital(1_234.56), profile: OHNE_GRENZEN,
    });

    expect(pruefeUnveraendert(vorher, s!)).toEqual([]);

    // Ausdruecklich noch einmal die Felder, um die es dem Nutzer geht
    expect(s!.leverage).toBe(10);
    expect(s!.stop_loss_price).toBe(48_000);
    expect(s!.stop_loss_type).toBe('trailing');
    expect(s!.trailing_stop_pct).toBe(1.5);
    expect(s!.trailing_stop_activation).toBe(51_000);
    expect(s!.trailing_stop_size_pct).toBe(75);
    expect(s!.take_profits.map(t => t.price)).toEqual([52_000, 55_000]);
    expect(s!.take_profits.map(t => t.percentage)).toEqual([40, 60]);
    expect(s!.take_profits[0]!.sl_new_price).toBe(50_000);
    expect(s!.take_profits[1]!.trailing_pct).toBe(2);
    expect(s!.entry_orders[0]!.price).toBe(50_000);
    expect(s!.activation_conditions).toEqual([{ price: 49_500 }]);
  });

  it('rechnet absolute Groessen in Take-Profits mit, Anteile dagegen nicht', () => {
    const vorher = signal({
      take_profits: [
        { price: 52_000, percentage: 50, size: 0.05, order_type: 'limit', status: 'pending' },
      ],
    });

    const { signal: s } = scaler.scale({
      signal: vorher, capital: kapital(5_000), profile: OHNE_GRENZEN,
    });

    expect(s!.take_profits[0]!.size).toBeCloseTo(0.025, 10);  // halbiert
    expect(s!.take_profits[0]!.percentage).toBe(50);          // unveraendert
    expect(s!.take_profits[0]!.price).toBe(52_000);           // unveraendert
  });

  it('haelt das Risiko im selben Verhaeltnis zum Kapital', () => {
    // 2 % Risiko bei 10.000 muessen 2 % Risiko bei 3.700 bleiben.
    const { decision } = scaler.scale({
      signal: signal(), capital: kapital(3_700), profile: OHNE_GRENZEN,
    });

    const anteilVorher = decision.referenceRisk! / decision.referenceCapital;
    const anteilNachher = decision.scaledRisk! / decision.capital.equity;
    expect(anteilNachher).toBeCloseTo(anteilVorher, 6);
    expect(anteilNachher).toBeCloseTo(0.02, 6);
  });
});

describe('PositionScaler — die Grenzen des Risikoprofils', () => {
  const scaler = new PositionScaler();

  it('deckelt, wenn der Hoechstverlust je Trade ueberschritten wuerde', () => {
    // Das Signal riskiert 2 % des Referenzkapitals. Wer nur 1 % zulaesst,
    // handelt die halbe Groesse.
    const { decision, signal: s } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, maxRiskPerTradePct: 0.01 },
    });

    expect(decision.accepted).toBe(true);
    expect(decision.limitedBy).toBe('risk_per_trade');
    expect(decision.factor).toBeCloseTo(0.5, 10);
    expect(s!.entry_orders[0]!.size).toBeCloseTo(0.05, 10);
    expect(decision.scaledRisk! / decision.capital.equity).toBeCloseTo(0.01, 6);
    // Der Stop bleibt trotzdem, wo er war
    expect(s!.stop_loss_price).toBe(48_000);
  });

  it('deckelt an der Margin-Grenze je Trade', () => {
    // 500 Margin waeren 5 % von 10.000; erlaubt sind 2 %.
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, maxMarginPerTradePct: 0.02 },
    });

    expect(decision.limitedBy).toBe('max_margin');
    expect(decision.factor).toBeCloseTo(0.4, 10);
    expect(decision.scaledMargin).toBeCloseTo(200, 6);
  });

  it('deckelt an der frei verfuegbaren Margin', () => {
    // Kontostand 10.000, aber nur 100 davon frei; 90 % davon nutzbar.
    const { decision } = scaler.scale({
      signal: signal(),
      capital: { ...kapital(10_000, 100) },
      profile: { ...OHNE_GRENZEN, usableFreeMarginPct: 0.9 },
    });

    expect(decision.limitedBy).toBe('free_margin');
    expect(decision.scaledMargin).toBeLessThanOrEqual(90.000001);
  });

  it('nimmt immer die schaerfste der Grenzen', () => {
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: {
        maxRiskPerTradePct: 0.015,     // → Faktor 0.75
        maxMarginPerTradePct: 0.01,    // → Faktor 0.20  (schaerfste)
        usableFreeMarginPct: 0.9,      // → Faktor 18
        capitalFraction: 1,
        multiplier: 1,
      },
    });

    expect(decision.limitedBy).toBe('max_margin');
    expect(decision.factor).toBeCloseTo(0.2, 10);
  });

  it('beachtet den Anteil des Kapitals, der ueberhaupt gehandelt wird', () => {
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, capitalFraction: 0.5 },
    });

    expect(decision.factor).toBeCloseTo(0.5, 10);
  });

  it('beachtet den Multiplikator', () => {
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, multiplier: 1.5 },
    });

    expect(decision.factor).toBeCloseTo(1.5, 10);
  });

  it('haelt die Risikogrenze auch gegen einen hohen Multiplikator', () => {
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: { ...STANDARD_RISIKOPROFIL, multiplier: 10, maxMarginPerTradePct: 0 },
    });

    // Das Standardprofil erlaubt 2 % Risiko — genau das Signal selbst.
    expect(decision.limitedBy).toBe('risk_per_trade');
    expect(decision.factor).toBeCloseTo(1, 6);
  });

  it('merkt an, wenn ohne Stop-Loss keine Risikogrenze greifen kann', () => {
    const { decision } = scaler.scale({
      signal: signal({ stop_loss_price: null }),
      capital: kapital(10_000),
    });

    expect(decision.accepted).toBe(true);
    expect(decision.referenceRisk).toBeNull();
    expect(decision.candidates.riskPerTrade).toBeNull();
    expect(decision.warnings.join(' ')).toContain('Stop-Loss');
  });
});

describe('PositionScaler — Mindestgroessen der Boerse', () => {
  const scaler = new PositionScaler();

  const dreiEinstiege = signal({
    total_size: 0.3,
    total_margin: 1_500,
    entry_strategy: 'equal',
    entry_orders: [
      { id: 'e1', price: 50_000, size: 0.1, order_type: 'limit', status: 'pending' },
      { id: 'e2', price: 49_000, size: 0.1, order_type: 'limit', status: 'pending' },
      { id: 'e3', price: 48_500, size: 0.1, order_type: 'limit', status: 'pending' },
    ],
  });

  it('rundet die Menge nach unten auf die Schrittweite', () => {
    const { signal: s } = scaler.scale({
      signal: signal(),
      capital: kapital(3_333),
      profile: OHNE_GRENZEN,
      limits: { amountStep: 0.001 },
    });

    // 0.1 * 0.3333 = 0.03333 → abgerundet 0.033
    expect(s!.entry_orders[0]!.size).toBeCloseTo(0.033, 10);
  });

  it('rundet nie auf — die Grenze darf nicht gerissen werden', () => {
    const { signal: s } = scaler.scale({
      signal: signal(),
      capital: kapital(9_990),
      profile: OHNE_GRENZEN,
      limits: { amountStep: 0.01 },
    });

    // 0.1 * 0.999 = 0.0999 → 0.09, nicht 0.10
    expect(s!.entry_orders[0]!.size).toBeCloseTo(0.09, 10);
  });

  it('streicht zu kleine Teil-Einstiege und handelt den Rest', () => {
    const { decision, signal: s } = scaler.scale({
      signal: dreiEinstiege,
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, belowMinimum: 'drop', minRemainingFraction: 0.1 },
      // Nur der erste Einstieg kommt mit 0.1 * 50.000 = 5.000 ueber den
      // Mindestwert; die beiden tieferen liegen mit 4.900 und 4.850 darunter.
      limits: { minCost: 4_950 },
    });

    expect(decision.accepted).toBe(true);
    expect(s!.entry_orders).toHaveLength(1);
    expect(s!.entry_orders[0]!.id).toBe('e1');
    expect(decision.droppedOrders).toHaveLength(2);
  });

  it('lehnt das ganze Signal ab, wenn das Profil es so verlangt', () => {
    const { decision, signal: s } = scaler.scale({
      signal: dreiEinstiege,
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, belowMinimum: 'reject' },
      limits: { minCost: 4_950 },
    });

    expect(decision.accepted).toBe(false);
    expect(s).toBeNull();
    expect(decision.reason).toContain('Mindestgroesse');
  });

  it('lehnt ab, wenn nach dem Streichen zu wenig uebrig bleibt', () => {
    const { decision } = scaler.scale({
      signal: dreiEinstiege,
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, belowMinimum: 'drop', minRemainingFraction: 0.9 },
      limits: { minCost: 4_950 },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('uebrig');
  });

  it('lehnt ab, wenn das Kapital fuer die kleinste Order nicht reicht', () => {
    const { decision, signal: s } = scaler.scale({
      signal: signal(),
      capital: kapital(50),
      profile: OHNE_GRENZEN,
      limits: { minAmount: 0.001 },
    });

    // 0.1 * 0.005 = 0.0005 — unter der Mindestmenge
    expect(decision.accepted).toBe(false);
    expect(s).toBeNull();
  });

  it('kuerzt absolute Take-Profit-Groessen mit, wenn Einstiege entfielen', () => {
    // Aus der Gegenpruefung: Werden Teil-Einstiege gestrichen, ist die
    // Position kleiner als faktor x total_size. Absolute Ausstiegsmengen
    // duerfen dann nicht mit dem rohen Faktor gerechnet werden — sonst
    // summieren die TPs auf mehr, als ueberhaupt offen ist.
    const mitAbsolutenTps = {
      ...dreiEinstiege,
      take_profits: [
        { price: 52_000, percentage: 50, size: 0.15, order_type: 'limit' as const, status: 'pending' as const },
        { price: 55_000, percentage: 50, size: 0.15, order_type: 'limit' as const, status: 'pending' as const },
      ],
    };

    const { decision, signal: s } = scaler.scale({
      signal: mitAbsolutenTps,
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, belowMinimum: 'drop', minRemainingFraction: 0.1 },
      limits: { minCost: 4_950 },     // nur der erste Einstieg ueberlebt
    });

    expect(decision.accepted).toBe(true);
    expect(s!.entry_orders).toHaveLength(1);

    const offenePosition = s!.entry_orders.reduce((sum, e) => sum + e.size, 0);
    const summeAusstiege = s!.take_profits.reduce((sum, t) => sum + (t.size ?? 0), 0);

    // Entscheidend: Es wird nie mehr geschlossen, als offen ist.
    expect(summeAusstiege).toBeLessThanOrEqual(offenePosition + 1e-9);
    // Preise und Anteile bleiben trotzdem unangetastet
    expect(s!.take_profits.map(t => t.price)).toEqual([52_000, 55_000]);
    expect(s!.take_profits.map(t => t.percentage)).toEqual([50, 50]);
  });

  it('laesst absolute TP-Groessen unveraendert, wenn nichts gestrichen wurde', () => {
    const mitAbsolutenTps = {
      ...signal(),
      take_profits: [
        { price: 52_000, percentage: 100, size: 0.1, order_type: 'limit' as const, status: 'pending' as const },
      ],
    };

    const { signal: s } = scaler.scale({
      signal: mitAbsolutenTps, capital: kapital(5_000), profile: OHNE_GRENZEN,
    });

    // Halbes Kapital, keine Streichung → genau die Haelfte
    expect(s!.take_profits[0]!.size).toBeCloseTo(0.05, 10);
  });

  it('rechnet Margin und Risiko aus dem, was uebrig blieb', () => {
    const { decision } = scaler.scale({
      signal: dreiEinstiege,
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, belowMinimum: 'drop', minRemainingFraction: 0.1 },
      limits: { minCost: 4_950 },
    });

    // Nur e1 blieb: 0.1 BTC zu 50.000 → 5.000 Notional / Hebel 10 = 500
    expect(decision.scaledMargin).toBeCloseTo(500, 6);
    // Risiko: 0.1 * (50.000 − 48.000) = 200
    expect(decision.scaledRisk).toBeCloseTo(200, 6);
    // und nicht etwa der hochgerechnete Wert der drei Einstiege
    expect(decision.scaledMargin).toBeLessThan(decision.referenceMargin);
  });
});

describe('PositionScaler — Ablehnungen', () => {
  const scaler = new PositionScaler();

  it('lehnt ohne Kapital ab', () => {
    const { decision } = scaler.scale({ signal: signal(), capital: kapital(0) });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('Kapital');
  });

  it('lehnt ohne Einstieg ab', () => {
    const { decision } = scaler.scale({
      signal: signal({ entry_orders: [] }), capital: kapital(10_000),
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('Einstieg');
  });

  it('lehnt bei unbrauchbarem Referenzkapital ab', () => {
    const { decision } = scaler.scale({
      signal: signal({ reference_capital: 0 }), capital: kapital(10_000),
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('Referenzkapital');
  });
});

describe('PositionScaler — Nachvollziehbarkeit', () => {
  const scaler = new PositionScaler();

  it('legt alle Obergrenzen offen, nicht nur die wirksame', () => {
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000, 5_000),
      profile: STANDARD_RISIKOPROFIL,
    });

    expect(decision.candidates.capital).toBeCloseTo(1, 10);
    expect(decision.candidates.riskPerTrade).toBeCloseTo(1, 10);     // 2 % / 2 %
    expect(decision.candidates.maxMargin).toBeCloseTo(4, 10);        // 2.000 / 500
    expect(decision.candidates.freeMargin).toBeCloseTo(9, 10);       // 4.500 / 500
    expect(decision.referenceCapital).toBe(10_000);
    expect(decision.capital.source).toBe('exchange');
  });

  it('begruendet, wenn eine Grenze die Kapitalproportion unterbot', () => {
    const { decision } = scaler.scale({
      signal: signal(),
      capital: kapital(10_000),
      profile: { ...OHNE_GRENZEN, maxRiskPerTradePct: 0.005 },
    });

    expect(decision.warnings.join(' ')).toContain('Hoechstverlust');
  });
});
