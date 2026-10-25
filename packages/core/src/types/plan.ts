// ============================================================
// Trade Plan Types — kompatibel mit TradingControl Schema
// (Migrationen 030, 044, 046, 057, 074, 075, 077)
// ============================================================

export type Direction = 'long' | 'short';
export type MarketType = 'spot' | 'futures';
export type StopLossType = 'fixed' | 'trailing';
export type EntryStrategy = 'single' | 'equal' | 'ascending' | 'descending' | 'custom';
export type ExecutionMode = 'all_limit' | 'first_market_rest_limit';

export type PlanStatus =
  | 'planned'
  | 'active'
  | 'monitoring'
  | 'executing'
  | 'completed'
  | 'cancelled'
  | 'error';

// ============================================================
// Indicator Trigger Types (Migration 077)
// ============================================================

export type TimeframeInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export type TriggerLogic = 'AND' | 'OR';

export type IndicatorKind =
  | 'rsi'
  | 'macd'
  | 'wavetrend'
  | 'ema'
  | 'sma'
  | 'bollinger'
  | 'stochastic'
  | 'atr'
  | 'adx'
  | 'volume';

export type IndicatorOperator =
  // Comparison
  | 'lt' | 'gt' | 'in_range'
  // Crossovers
  | 'cross_above' | 'cross_below'
  | 'cross_above_signal' | 'cross_below_signal'
  | 'cross_above_zero' | 'cross_below_zero'
  | 'price_cross_above' | 'price_cross_below'
  | 'price_above' | 'price_below'
  // Histogram
  | 'histogram_first_positive' | 'histogram_first_negative'
  // WaveTrend
  | 'cross_up' | 'cross_down'
  | 'oversold_cross_up' | 'overbought_cross_down'
  // Bollinger
  | 'price_below_lower' | 'price_above_upper'
  | 'price_cross_above_middle' | 'price_cross_below_middle'
  | 'squeeze'
  // Stochastic
  | 'k_cross_above_d' | 'k_cross_below_d'
  // Volume
  | 'gt_avg_x' | 'spike';

export interface TriggerCondition {
  id: string;                              // UUID
  indicator: IndicatorKind;
  params: Record<string, number>;          // z.B. { period: 14 } oder { fast: 12, slow: 26, signal: 9 }
  operator: IndicatorOperator;
  value?: number;                          // fuer arity=1 Operatoren
  value_to?: number;                       // fuer arity=2 (in_range)
  lookback?: number;                       // 1-50 Bars (default 1)
}

export interface TriggerBlock {
  interval: TimeframeInterval;
  logic: TriggerLogic;
  conditions: TriggerCondition[];          // 1-5 Bedingungen
  enabled?: boolean;                       // Optional, default true
}

// ============================================================
// Entry Orders + Zones
// ============================================================

export interface EntryOrder {
  id?: string;                              // UUID (Migration 077: backend-assigned)
  zone_id?: string;                         // Link zur Zone (falls aus Multi-Zone DCA)
  price: number;
  percentage?: number;                      // % des total_size (optional fuer Backwards-Compat)
  size: number;                             // Absolute Asset-Menge
  order_type?: 'limit' | 'market';
  status?: 'pending' | 'placed' | 'filled' | 'cancelled';
  trigger?: TriggerBlock | null;            // Optional: Indicator-Trigger pro Order
}

export interface EntryZone {
  id: string;                                // UUID (required, Migration 075)
  label?: string;                            // z.B. "Initial", "ReBuy 1"
  priceFrom: number;
  priceTo?: number;                          // optional fuer 'single'
  strategy: EntryStrategy;
  steps: number;                             // Anzahl Sub-Orders innerhalb der Zone
  percentageOfTotal: number;                 // % der Gesamt-Position (Sum aller Zonen = 100)
  customOrders?: EntryOrder[];               // nur bei strategy='custom'
  trigger?: TriggerBlock | null;             // Zone-Level Trigger (kopiert auf alle Orders)
}

// ============================================================
// Take Profits (per-TP Features)
// ============================================================

export interface TakeProfit {
  price: number;
  percentage?: number;                       // % der Position zum Schliessen (TC-Stil)
  size_pct?: number;                         // Alias fuer percentage (alter Bot-Code)
  size?: number;                             // optional absolute Groesse
  order_type?: 'limit' | 'market';
  status?: 'pending' | 'placed' | 'filled' | 'cancelled';

  // Per-TP SL-Adjustment
  sl_adjust?: boolean;                       // SL nach diesem TP-Hit verschieben?
  sl_new_price?: number | null;              // Neuer SL-Preis

  // Per-TP Trailing-Stop-Activation
  activate_trailing?: boolean;               // Nach diesem TP zu Trailing wechseln?
  trailing_pct?: number;                     // Trailing-Distanz in %

  // Optional: per-TP Trigger (analog Entries)
  trigger?: TriggerBlock | null;
}

/** Hilfsfunktion: TP-Prozentsatz lesen (unterstuetzt percentage und size_pct) */
export function getTpPercentage(tp: TakeProfit): number {
  return tp.percentage ?? tp.size_pct ?? 0;
}

// ============================================================
// Freigabe durch ein externes Signal (TradingView o. ae.)
// ============================================================

/**
 * Bedingung, die ein Plan an ein eingehendes Signal knuepft.
 *
 * Der Plan liegt fertig im Bot — Groesse, Hebel, Stops stehen fest. Er
 * wartet nur darauf, dass der Signalgeber ihn freigibt. Erst danach
 * werden seine Einstiege platziert, und auch dann zu den im Plan
 * vorgesehenen Preisen, nicht zum Marktpreis des Signalzeitpunkts.
 *
 * Alle Felder sind Filter. Was nicht gesetzt ist, wird nicht geprueft —
 * eine leere Bedingung passt auf jedes Signal.
 */
export interface SignalTrigger {
  /** Nur Signale dieser Strategie. */
  strategy?: string;
  /** Nur Signale zu diesem Markt. Ohne Angabe gilt das Symbol des Plans. */
  symbol?: string;
  /** Freie Marke, die Plan und Signal gemeinsam tragen. */
  tag?: string;
  /** Hoechstalter des Signals in Sekunden. Ohne Angabe gilt die Voreinstellung. */
  max_age_sec?: number;
  /**
   * Muss die Richtung des Signals zu der des Plans passen?
   * Voreingestellt ja — ein Short-Signal soll keinen Long freigeben.
   */
  match_direction?: boolean;
}

// ============================================================
// Activation Conditions (Sequential Price Levels)
// ============================================================

/** TC-Style: nur Preis (Migration 044). Bot-Legacy: type + value */
export interface ActivationCondition {
  price?: number;                            // TC-Style (sequential)
  type?: 'price_above' | 'price_below' | 'immediate';  // Legacy
  value?: number | null;                     // Legacy
  met?: boolean;                             // Legacy
}

// ============================================================
// Haupt-TradePlan (kompatibel zu TC API)
// ============================================================

export interface TradePlan {
  id: string;
  user_id?: string;
  exchange_account_id?: string | null;
  exchange?: string;                         // 'phemex' | 'binance' | etc.

  // Symbol
  symbol: string;                            // BTCUSDT
  asset_symbol?: string;                     // BTC
  quote_currency?: string;                   // USDT

  // Market
  market_type: MarketType;
  direction: Direction;
  leverage: number;
  total_size: number;
  total_margin?: number | null;

  // Entry
  entry_strategy: EntryStrategy;
  entry_orders: EntryOrder[];                // Flach (auto-berechnet aus zones, falls vorhanden)
  entry_zones?: EntryZone[] | null;          // Multi-Zone DCA (Migration 075)

  // Take Profits
  take_profits: TakeProfit[];

  // Stop-Loss
  stop_loss_price: number | null;
  stop_loss_type: StopLossType;
  trailing_stop_pct: number | null;
  trailing_stop_activation: number | null;
  trailing_stop_size_pct?: number | null;    // % der Position fuer TS (Migration 074)

  // Activation
  activation_conditions?: ActivationCondition[] | null;

  /**
   * Freigabe durch ein externes Signal. Ist sie gesetzt, bleiben die
   * Einstiege gesperrt, bis ein passendes Signal eintrifft — zusaetzlich
   * zu allen uebrigen Bedingungen, nicht an ihrer Stelle.
   */
  signal_trigger?: SignalTrigger | null;

  // Status
  status: PlanStatus;
  bot_enabled: boolean;
  notes?: string | null;

  // Bot-Tracking (Migration 077)
  executed_orders?: string[];                // UUIDs der bereits ausgefuellten Entry-Orders

  // Source
  //   'tc'     — aus dem Journal gespiegelt
  //   'local'  — hier im Bot von Hand angelegt
  //   'signal' — aus einem externen Handelssignal (TradingView o. ae.)
  // Die drei Bestaende ueberschneiden sich nicht; jeder hat genau einen
  // Ausfuehrer. Nur so kann keine Order zweimal an die Boerse gehen.
  source?: 'tc' | 'local' | 'signal';        // Woher der Plan kommt

  // Timestamps
  created_at: string;
  updated_at: string;
}

// ============================================================
// Bot-interne Monitor-State (Migration 046)
// ============================================================

export interface TpState {
  index: number;
  price: number;
  percentage: number;
  triggered: boolean;
  filled_at?: string;
  filled_price?: number;
  filled_size?: number;
}

export interface TradePlanMonitor {
  trade_plan_id: string;
  status: 'waiting_activation' | 'monitoring' | 'completed' | 'cancelled' | 'error';
  activation_step: number;                   // Bitmask der erreichten Conditions
  tp_state: TpState[];
  sl_current: number | null;
  sl_type_current: StopLossType;
  trailing_active: boolean;
  trailing_best_price: number | null;
  trailing_size_pct: number | null;          // Aktuelles trailing-stop_size_pct
  remaining_size: number;                    // Noch offene Position
  last_price: number | null;
  last_checked_at: string | null;
  error_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Bot-Order-Tracking (Migration 037)
// ============================================================

export interface TradePlanOrder {
  id: string;
  trade_plan_id: string;
  entry_order_id?: string | null;            // UUID der Entry-Order (Migration 077)
  side: 'buy' | 'sell';
  order_type: 'limit' | 'market' | 'stop' | 'stop_limit';
  role: 'entry' | 'take_profit' | 'stop_loss' | 'trailing_stop';
  symbol: string;
  price: number | null;
  stop_price: number | null;
  quantity: number;
  filled_quantity: number;
  avg_fill_price: number | null;
  status: 'new' | 'placed' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';
  broker: string;                            // 'paper' | 'phemex'
  broker_order_id?: string | null;
  client_order_id?: string | null;
  fees?: number;
  fee_currency?: string;
  raw_response?: string | null;              // JSON
  placed_at: string;
  updated_at: string;
}

// ============================================================
// Indicator-Cache (Klines pro Symbol+Interval)
// ============================================================

export interface CachedKline {
  open_time: number;                         // ms timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: number;
}

// ============================================================
// Backwards-Compat Alias (alter TcPlan-Name)
// ============================================================

export type TcPlan = TradePlan;
