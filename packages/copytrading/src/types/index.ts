// ============================================================
// CopyTrading Type Definitions
// ============================================================

// --- Wallet Types ---

export type WalletTier = 'tier1' | 'tier2' | 'tier3' | 'watchlist' | 'blacklist';

export interface TrackedWallet {
  address: string;
  label?: string;
  tier: WalletTier;
  score: number;
  added_by: 'auto' | 'manual';  // User kann manuell hinzufuegen
  active: boolean;

  // Score-Komponenten
  sharpe_ratio: number;
  max_drawdown_pct: number;
  win_rate: number;
  profit_factor: number;
  total_trades: number;
  track_record_days: number;
  avg_leverage: number;

  // Dynamische Anpassungen
  streak: number;             // positive = Gewinne, negative = Verluste
  paused_until?: string;      // ISO-Date wenn pausiert (3 Verluste -> 48h)
  last_signal_at?: string;
  last_score_update?: string;
  created_at: string;
  updated_at: string;
}

// --- Signal Types ---

export type SignalType = 'open' | 'close' | 'increase' | 'decrease';

export interface WalletSignal {
  id: string;
  wallet_address: string;
  wallet_tier: WalletTier;
  wallet_score: number;

  // Signal-Details
  signal_type: SignalType;
  symbol: string;
  direction: 'long' | 'short';
  size: number;              // Positionsgroesse in Asset
  leverage: number;
  entry_price: number;

  // Zeitstempel
  detected_at: string;       // Wann Signal erkannt
  processed_at?: string;     // Wann verarbeitet

  // Verarbeitung
  status: 'pending' | 'validated' | 'rejected' | 'analyzed' | 'executed' | 'skipped';
  rejection_reason?: string;

  // Claude-Analyse Ergebnis (nach Conviction Engine)
  conviction?: ConvictionResult;

  // Trade-Ergebnis (nach Execution)
  trade_id?: string;
  trade_pnl?: number;
}

// --- Conviction Engine Types ---

export type MarketRegime = 'bull_strong' | 'bull_early' | 'sideways' | 'bear_early' | 'bear_strong';
export type ConfidenceLevel = 'very_high' | 'high' | 'medium' | 'low' | 'very_low';

export interface ConvictionResult {
  conviction_score: number;   // 0-100
  direction: 'long' | 'short';
  confidence: ConfidenceLevel;
  regime: MarketRegime;
  signal_quality: 'strong' | 'medium' | 'weak' | 'contradictory';

  reasoning: string;
  recommended_size_pct: number;    // % des Portfolios
  recommended_leverage: number;
  stop_loss_pct: number;           // ATR-basiert
  take_profit_levels: number[];    // Mehrere TP-Preise
  execute: boolean;
  flags: string[];
}

export interface ConvictionInput {
  signal: WalletSignal;
  wallet: TrackedWallet;
  market_data: MarketData;
  sentiment: SentimentData;
  open_positions: OpenPositionSummary[];
}

// --- Market Data ---

export interface MarketData {
  symbol: string;
  price: number;
  rsi_14: number;
  ema_200: number;
  macd: { value: number; signal: number; histogram: number };
  atr_14: number;
  bollinger: { upper: number; middle: number; lower: number };
  volume_24h: number;
  price_change_24h_pct: number;
}

export interface SentimentData {
  fear_greed_index: number;          // 0-100
  fear_greed_label: string;          // "Extreme Fear" .. "Extreme Greed"
  btc_funding_rate: number;
  eth_funding_rate: number;
  total_oi_change_24h_pct: number;   // Open Interest Aenderung
  btc_dominance: number;
}

export interface OpenPositionSummary {
  symbol: string;
  direction: 'long' | 'short';
  size_usd: number;
  pnl_pct: number;
  correlation_to_btc: number;
}

// --- Hyperliquid API Types ---

export interface HLPosition {
  coin: string;
  szi: string;       // Signed size (negative = short)
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage: { type: string; value: number };
  liquidationPx: string | null;
}

export interface HLUserFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';   // Buy / Ask(Sell)
  time: number;       // ms timestamp
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  crossed: boolean;   // Market order
}

export interface HLLeaderboardEntry {
  ethAddress: string;
  accountValue: string;
  windowPerformances: Array<{
    window: string;   // "day", "week", "month", "allTime"
    pnl: string;
    roi: string;
    vlm: string;
  }>;
}

// --- Scoring Types ---

export interface ScoreComponents {
  sharpe_weighted: number;
  drawdown_weighted: number;
  consistency_weighted: number;
  replicability_weighted: number;
  recency_weighted: number;
  track_record_weighted: number;
  total: number;
  // Rohwerte fuer die DB
  raw_sharpe: number;
  raw_max_drawdown: number;
  raw_win_rate: number;
  raw_profit_factor: number;
}

// --- Decision Gate ---

export interface CombinedScore {
  signal_score: number;      // Wallet-Score
  conviction_score: number;  // Claude-Score
  combined: number;          // Gewichteter Gesamtscore
  action: 'full_size' | 'standard' | 'reduced' | 'skip' | 'reject';
  size_pct: number;          // Empfohlene Positionsgroesse
  max_leverage: number;
}

// --- Config ---

export interface CopyTradingConfig {
  enabled: boolean;
  claude_model: 'claude-sonnet-4-20250514' | 'claude-opus-4-20250514' | 'claude-haiku-4-5-20251001';
  claude_api_key: string;
  portfolio_size_usd: number;       // Startkapital ($1000)

  // Wallet-Monitoring
  max_tracked_wallets: number;      // Default: 50
  min_wallet_score: number;         // Min-Score fuer Auto-Tracking (Default: 40)
  wallet_poll_interval_ms: number;  // Default: 5000 (5s)

  // Decision Gate Schwellen
  min_combined_score: number;       // Default: 60
  min_conviction_score: number;     // Default: 55

  // Risk Limits (Hard Limits)
  max_portfolio_drawdown_pct: number;   // Default: 15
  daily_loss_limit_pct: number;         // Default: 5
  max_exposure_per_asset_pct: number;   // Default: 10
  max_concurrent_positions: number;     // Default: 5
  max_portfolio_leverage: number;       // Default: 5
  max_correlation: number;              // Default: 0.7

  // Trade-Regeln
  default_sl_atr_multiplier: number;    // Default: 1.5
  min_risk_reward: number;              // Default: 1.5
  trailing_stop_activation_r: number;   // Default: 2.0
  partial_close_at_r: number;           // Default: 1.5
  partial_close_pct: number;            // Default: 50
  max_hold_hours: number;               // Default: 72
  reentry_cooldown_hours: number;       // Default: 4

  // High-Leverage-Handling (statt Blacklist)
  high_leverage_threshold: number;      // Default: 20
  high_leverage_size_factor: number;    // Default: 0.5 (halbe Groesse)
}
