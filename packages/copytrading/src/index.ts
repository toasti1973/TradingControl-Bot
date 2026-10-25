// CopyTrading Module — Public API
export { HyperliquidClient } from './hyperliquid/hl-client.js';
export { WalletMonitor } from './hyperliquid/wallet-monitor.js';
export { SignalPreprocessor } from './hyperliquid/signal-preprocessor.js';
export { WalletScorer } from './scoring/wallet-scorer.js';
export { LocalAnalyzer, type LocalAnalysisResult } from './scoring/local-analyzer.js';
export { MarketDataService } from './scoring/market-data-service.js';
export { OrderFlowAnalyzer, type OrderFlowSnapshot, type PriceBin, type ImbalanceZone, type NakedPoc } from './scoring/orderflow-analyzer.js';
export { LiquidityAnalyzer, type LiquiditySnapshot, type LiquidityWall } from './scoring/liquidity-analyzer.js';
export { ConvictionEngine } from './conviction/conviction-engine.js';
export { SentimentService } from './sentiment/sentiment-service.js';
export { DecisionGate } from './execution/decision-gate.js';
export { CopyTradingEngine } from './execution/copytrading-engine.js';
export { CopyTradeExecutor, type CopyTradePosition } from './execution/copytrade-executor.js';

// Types
export type * from './types/index.js';
