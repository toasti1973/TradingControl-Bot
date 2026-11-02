// ============================================================
// Typen fuer externe Handelssignale (TradingView und Verwandte)
//
// Ein Signal beschreibt einen Handelsplan so, wie ihn TradingControl
// kennt — mit einem Unterschied: Alle Mengenangaben beziehen sich auf ein
// vereinbartes Referenzkapital (ueblich 10.000 USDT). Der Bot rechnet sie
// auf das tatsaechlich vorhandene Kapital um.
//
// Umgerechnet wird ausschliesslich die Groesse. Hebel, Stop-Loss,
// Take-Profits und Trailing-Einstellungen bleiben Zeichen fuer Zeichen so,
// wie der Signalgeber sie bestimmt hat — er kennt den Aufbau des Trades,
// der Bot kennt nur den Kontostand.
// ============================================================

import type {
  ActivationCondition, Direction, EntryOrder, EntryZone, EntryStrategy,
  ExecutionMode, MarketType, StopLossType, TakeProfit,
} from '@tradingcontrol/core';

/**
 * Was das Signal auszuloesen wuenscht.
 *
 * `open`    — vollstaendiger Handelsplan, der angelegt und ausgefuehrt wird
 * `trigger` — Freigabe fuer bereits hinterlegte Plaene, die darauf warten
 * `close`   — offene Position zu diesem Symbol schliessen
 * `cancel`  — Plan abbrechen und offene Orders zuruecknehmen
 * `update`  — den Stop eines LAUFENDEN Plans verschieben
 *
 * ## Warum `update` eine eigene Absicht ist
 *
 * Es ist die einzige Absicht, die in einen Trade eingreift, der schon
 * im Markt steht. Entstanden aus einer konkreten Luecke: Ein Signal
 * rechnet seinen Break-Even-Stop auf die GEPLANTE Einstiegsstaffel.
 * Fuellt davon nur ein Teil — der Regelfall, denn nach dem ersten
 * Take-Profit werden die restlichen Einstiege zurueckgenommen —, liegt
 * der vorgegebene Stop unter dem tatsaechlichen Einstand, und der Plan
 * kann trotz mitgenommenem Gewinn im Minus enden.
 *
 * Mit dem Rueckkanal erfaehrt TC-Synaptrix den echten Einstand und
 * kann nachsteuern. Der Bot zieht den Stop allerdings schon von sich
 * aus auf den Einstand (siehe `TradePlanMonitor.zieheStopAufEinstand`);
 * ein `update` ist die genauere, spaetere Korrektur, nicht der einzige
 * Schutz.
 *
 * `update` verschiebt NUR den Stop. Hebel, Groesse und Take-Profits
 * bleiben unantastbar — sie zu aendern hiesse, mitten im Trade eine
 * andere Strategie zu handeln als die, fuer die er eroeffnet wurde.
 */
export type SignalAction = 'open' | 'trigger' | 'close' | 'cancel' | 'update';

/**
 * Rohform, wie sie aus dem Webhook eintrifft. Alles optional und von
 * unbekanntem Typ: Was hereinkommt, ist zunaechst nur eine Behauptung.
 */
export type RawSignalPayload = Record<string, unknown>;

/**
 * Geprueftes Signal. Jedes Feld hat hier den Typ, den es vorgibt zu haben.
 *
 * Die Mengenangaben (`total_size`, `total_margin`, Groessen in
 * `entry_orders`) gelten fuer `reference_capital` — nicht fuer das Konto.
 */
export interface TradeSignal {
  /** Schema-Fassung des Signalformats. Zurzeit 1. */
  version: number;

  /**
   * Kennung des Signals, vom Signalgeber vergeben. Zweimal dieselbe
   * Kennung heisst: dasselbe Signal, nicht zwei Trades. Der Bot verwirft
   * die Wiederholung.
   */
  signal_id: string;

  /** Name der Strategie oder des Indikators, der das Signal erzeugte. */
  strategy: string;

  /** Wann der Signalgeber es abschickte (ISO-8601). */
  emitted_at: string;

  action: SignalAction;

  /**
   * Kapital, auf das sich die Mengen im Signal beziehen. Fehlt die Angabe,
   * gilt die im Bot eingestellte Voreinstellung (ueblich 10.000).
   */
  reference_capital: number;

  // --- Markt ---
  exchange?: string;
  symbol: string;
  asset_symbol?: string;
  quote_currency: string;
  market_type: MarketType;
  direction: Direction;
  leverage: number;

  // --- Groesse (bezogen auf reference_capital) ---
  /** Positionsgroesse in Asset-Einheiten. */
  total_size: number;
  /** Eingesetzte Margin in Quote-Waehrung. Fehlt sie, wird sie berechnet. */
  total_margin: number | null;

  // --- Einstieg ---
  entry_strategy: EntryStrategy;
  entry_orders: EntryOrder[];
  entry_zones: EntryZone[] | null;
  execution_mode: ExecutionMode;

  // --- Ausstieg (wird NICHT skaliert) ---
  take_profits: TakeProfit[];
  stop_loss_price: number | null;
  stop_loss_type: StopLossType;
  trailing_stop_pct: number | null;
  trailing_stop_activation: number | null;
  trailing_stop_size_pct: number | null;

  // --- Aktivierung ---
  activation_conditions: ActivationCondition[];

  /**
   * Nur bei `action: 'trigger'`, `'close'`, `'cancel'`: an welche Plaene
   * sich das Signal richtet. Ohne Angabe gilt es fuer alle wartenden
   * Plaene derselben Strategie und desselben Symbols.
   */
  target_plan_id: string | null;
  /** Freie Marke, ueber die ein Plan ein Signal zuordnen kann. */
  tag: string | null;

  notes: string | null;

  /** Felder, die das Schema nicht kennt — unveraendert aufbewahrt. */
  extra: Record<string, unknown>;
}

// ============================================================
// Risikoprofil
// ============================================================

/**
 * Wie weit der Bot einem Signal folgen darf.
 *
 * Die Grenzen wirken nur nach unten: Sie koennen eine Position
 * verkleinern, niemals vergroessern. Der `multiplier` ist die einzige
 * Ausnahme und deshalb ausdruecklich zu setzen.
 */
export interface RiskProfile {
  /**
   * Anteil des Kontostands, der ueberhaupt fuer Signal-Handel zur
   * Verfuegung steht. 1 = das ganze Konto, 0.5 = die Haelfte.
   */
  capitalFraction: number;

  /**
   * Bewusste Verstaerkung oder Daempfung gegenueber dem Signalgeber.
   * 1 = massstabsgetreu, 0.5 = halb so gross, 2 = doppelt.
   */
  multiplier: number;

  /**
   * Hoechstverlust je Trade als Anteil des Kontostands, gemessen am
   * Stop-Loss des Signals. 0.01 = 1 %. 0 schaltet die Grenze ab.
   *
   * Greift nur, wenn das Signal einen Stop-Loss nennt.
   */
  maxRiskPerTradePct: number;

  /**
   * Hoechste Margin je Trade als Anteil des Kontostands. 0 schaltet ab.
   */
  maxMarginPerTradePct: number;

  /**
   * Anteil der freien Margin, der hoechstens gebunden werden darf.
   * Haelt einen Rest fuer Nachschuss und Gebuehren frei.
   */
  usableFreeMarginPct: number;

  /**
   * Was geschieht, wenn eine Teil-Order nach der Umrechnung unter die
   * Mindestgroesse der Boerse faellt.
   *
   * `drop`   — die Teil-Order entfaellt, der Rest wird gehandelt
   * `reject` — das ganze Signal wird abgelehnt
   */
  belowMinimum: 'drop' | 'reject';

  /**
   * Wieviel von der geplanten Gesamtgroesse nach allen Streichungen
   * mindestens uebrig bleiben muss, damit der Trade noch Sinn ergibt.
   * 0.5 = die Haelfte.
   */
  minRemainingFraction: number;
}

export const STANDARD_RISIKOPROFIL: RiskProfile = {
  capitalFraction: 1,
  multiplier: 1,
  maxRiskPerTradePct: 0.02,
  maxMarginPerTradePct: 0.2,
  usableFreeMarginPct: 0.9,
  belowMinimum: 'drop',
  minRemainingFraction: 0.5,
};

// ============================================================
// Kontostand und Marktgrenzen
// ============================================================

/** Was der Bot ueber das Konto weiss, in Quote-Waehrung. */
export interface CapitalSnapshot {
  /** Gesamtes Kapital, Grundlage aller Prozentgrenzen. */
  equity: number;
  /** Frei verfuegbar fuer neue Positionen. */
  free: number;
  quoteCurrency: string;
  /** Woher die Zahlen stammen — fuer das Protokoll. */
  source: 'exchange' | 'configured' | 'fallback';
  at: string;
}

/**
 * Grenzen der Boerse fuer ein Symbol. Alles optional: Was die Boerse
 * nicht nennt, wird nicht geprueft.
 */
export interface MarketLimits {
  /** Kleinste handelbare Menge in Asset-Einheiten. */
  minAmount?: number;
  /** Kleinster Auftragswert in Quote-Waehrung. */
  minCost?: number;
  /** Schrittweite der Menge. */
  amountStep?: number;
  /** Nachkommastellen der Menge, falls keine Schrittweite genannt ist. */
  amountPrecision?: number;
}

// ============================================================
// Ergebnis der Umrechnung
// ============================================================

/** Welche Grenze den Ausschlag gab. */
export type LimitingFactor =
  | 'capital'            // reine Kapitalproportion, keine Grenze griff
  | 'risk_per_trade'
  | 'max_margin'
  | 'free_margin';

export interface ScalingDecision {
  /** Darf der Trade ueberhaupt gehandelt werden? */
  accepted: boolean;
  /** Bei Ablehnung: der Grund, in Worten. */
  reason?: string;

  /** Der angewandte Faktor auf alle Mengen. */
  factor: number;
  /** Welche Grenze ihn bestimmte. */
  limitedBy: LimitingFactor;

  /** Die einzelnen Obergrenzen, zur Nachvollziehbarkeit. */
  candidates: {
    capital: number;
    riskPerTrade: number | null;
    maxMargin: number | null;
    freeMargin: number | null;
  };

  /** Kapital, auf das umgerechnet wurde. */
  capital: CapitalSnapshot;
  referenceCapital: number;

  // --- Vorher/Nachher in Zahlen ---
  referenceMargin: number;
  scaledMargin: number;
  referenceRisk: number | null;
  scaledRisk: number | null;
  referenceSize: number;
  scaledSize: number;

  /** Teil-Orders, die wegen der Mindestgroesse entfielen. */
  droppedOrders: Array<{ id: string; price: number; size: number; reason: string }>;

  /** Hinweise, die den Trade nicht verhindern, aber festgehalten gehoeren. */
  warnings: string[];
}

export interface ScalingResult {
  decision: ScalingDecision;
  /** Das umgerechnete Signal. Nur gesetzt, wenn `decision.accepted`. */
  signal: TradeSignal | null;
}

// ============================================================
// Pruefung des Payloads
// ============================================================

export interface ValidationResult {
  valid: boolean;
  signal: TradeSignal | null;
  errors: string[];
  warnings: string[];
}
