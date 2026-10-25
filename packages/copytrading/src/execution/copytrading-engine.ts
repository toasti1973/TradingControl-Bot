// ============================================================
// CopyTradingEngine — Orchestriert die gesamte Pipeline
// Signal → Validate → Conviction → Decision → Execute
// ============================================================

import { EventEmitter } from 'events';
import type {
  WalletSignal,
  ConvictionInput,
  CombinedScore,
  CopyTradingConfig,
  TrackedWallet,
  MarketData,
  OpenPositionSummary,
} from '../types/index.js';

import { HyperliquidClient } from '../hyperliquid/hl-client.js';
import { WalletMonitor } from '../hyperliquid/wallet-monitor.js';
import { SignalPreprocessor } from '../hyperliquid/signal-preprocessor.js';
import { WalletScorer } from '../scoring/wallet-scorer.js';
import { ConvictionEngine } from '../conviction/conviction-engine.js';
import { SentimentService } from '../sentiment/sentiment-service.js';
import { DecisionGate } from './decision-gate.js';

export interface CopyTradeDecision {
  signal: WalletSignal;
  decision: CombinedScore;
  timestamp: string;
}

export class CopyTradingEngine extends EventEmitter {
  private readonly hlClient: HyperliquidClient;
  private readonly monitor: WalletMonitor;
  private readonly preprocessor: SignalPreprocessor;
  private readonly scorer: WalletScorer;
  private readonly conviction: ConvictionEngine;
  private readonly sentiment: SentimentService;
  private readonly decisionGate: DecisionGate;
  private readonly config: CopyTradingConfig;

  private running = false;
  private processedSignals = 0;
  private executedTrades = 0;
  private skippedSignals = 0;

  constructor(config: CopyTradingConfig) {
    super();
    this.config = config;

    this.hlClient = new HyperliquidClient();
    this.monitor = new WalletMonitor(this.hlClient, config.wallet_poll_interval_ms);
    this.preprocessor = new SignalPreprocessor(config);
    this.scorer = new WalletScorer();
    this.conviction = new ConvictionEngine(config);
    this.sentiment = new SentimentService();
    this.decisionGate = new DecisionGate(config);

    // Signal-Pipeline verbinden
    this.monitor.on('signal', (signal: WalletSignal) => {
      void this.processSignal(signal);
    });

    this.monitor.on('error', (err: { wallet: string; error: string }) => {
      this.emit('monitor:error', err);
    });
  }

  // --- Wallet-Verwaltung ---

  addWallet(wallet: TrackedWallet): void {
    this.monitor.addWallet(wallet);
    this.emit('wallet:added', wallet);
  }

  removeWallet(address: string): void {
    this.monitor.removeWallet(address);
    this.emit('wallet:removed', address);
  }

  getTrackedWallets(): TrackedWallet[] {
    return this.monitor.getTrackedWallets();
  }

  // --- Lebenszyklus ---

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.emit('started');
    await this.monitor.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.monitor.stop();
    this.emit('stopped');
  }

  getStats() {
    return {
      running: this.running,
      tracked_wallets: this.monitor.getTrackedWallets().length,
      processed_signals: this.processedSignals,
      executed_trades: this.executedTrades,
      skipped_signals: this.skippedSignals,
    };
  }

  // --- Signal-Pipeline ---

  private async processSignal(signal: WalletSignal): Promise<void> {
    this.processedSignals++;
    this.emit('signal:received', signal);

    // 1. Validierung
    const validation = this.preprocessor.validate(signal);
    if (!validation.valid) {
      signal.status = 'rejected';
      signal.rejection_reason = validation.reason;
      this.skippedSignals++;
      this.emit('signal:rejected', { signal, reason: validation.reason });
      return;
    }
    signal.status = 'validated';
    this.emit('signal:validated', signal);

    // 2. Marktdaten und Sentiment laden
    const [sentiment, marketData] = await Promise.all([
      this.sentiment.getSentiment(),
      this.fetchMarketData(signal.symbol),
    ]);

    // 3. Claude Conviction-Analyse
    const wallet = this.monitor.getTrackedWallets().find(w => w.address === signal.wallet_address);
    if (!wallet) {
      signal.status = 'rejected';
      signal.rejection_reason = 'Wallet nicht mehr getrackt';
      return;
    }

    const convictionInput: ConvictionInput = {
      signal,
      wallet,
      market_data: marketData,
      sentiment,
      open_positions: this.getOpenPositions(),
    };

    const convictionResult = await this.conviction.analyze(convictionInput);
    signal.conviction = convictionResult;
    signal.status = 'analyzed';
    this.emit('signal:analyzed', { signal, conviction: convictionResult });

    // 4. Decision Gate
    const decision = this.decisionGate.evaluate(signal, convictionResult);

    if (decision.action === 'reject' || decision.action === 'skip') {
      signal.status = 'skipped';
      this.skippedSignals++;
      this.emit('signal:skipped', { signal, decision });
      return;
    }

    // 5. Trade ausfuehren (via Event — der BotService kuemmert sich um Execution)
    signal.status = 'executed';
    this.executedTrades++;

    const tradeDecision: CopyTradeDecision = {
      signal,
      decision,
      timestamp: new Date().toISOString(),
    };

    this.emit('trade:execute', tradeDecision);
  }

  // --- Marktdaten (vereinfacht — wird spaeter durch echte TA-Lib ersetzt) ---

  private async fetchMarketData(symbol: string): Promise<MarketData> {
    const coin = symbol.replace('USDT', '');
    const mids = await this.hlClient.getAllMidPrices();
    const price = mids[coin] ?? 0;

    // Vereinfachte Indikatoren — wird in Phase 5 durch echte Berechnung ersetzt
    return {
      symbol,
      price,
      rsi_14: 50,           // Placeholder
      ema_200: price * 0.95, // Placeholder
      macd: { value: 0, signal: 0, histogram: 0 },
      atr_14: price * 0.02, // 2% als Schaetzung
      bollinger: {
        upper: price * 1.04,
        middle: price,
        lower: price * 0.96,
      },
      volume_24h: 0,
      price_change_24h_pct: 0,
    };
  }

  // --- Offene Positionen (wird vom BotService gefuellt) ---
  private openPositions: OpenPositionSummary[] = [];

  setOpenPositions(positions: OpenPositionSummary[]): void {
    this.openPositions = positions;
  }

  private getOpenPositions(): OpenPositionSummary[] {
    return this.openPositions;
  }

  // --- Wallet-Score-Update ---

  async updateWalletScores(): Promise<void> {
    const wallets = this.monitor.getTrackedWallets();

    for (const wallet of wallets) {
      try {
        const stats = await this.hlClient.getWalletStats(wallet.address);
        const score = this.scorer.calculateScore(stats.fills, stats.accountValue);
        const tier = this.scorer.determineTier(score.total, wallet);

        wallet.score = score.total;
        wallet.tier = tier;
        wallet.last_score_update = new Date().toISOString();

        this.emit('wallet:scored', { address: wallet.address, score: score.total, tier });
      } catch (err) {
        this.emit('wallet:score_error', {
          address: wallet.address,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // --- Leaderboard scannen und neue Wallets entdecken ---

  async discoverWallets(): Promise<TrackedWallet[]> {
    const leaderboard = await this.hlClient.getLeaderboard('month');
    const existing = new Set(this.monitor.getTrackedWallets().map(w => w.address));
    const newWallets: TrackedWallet[] = [];

    for (const entry of leaderboard.slice(0, this.config.max_tracked_wallets)) {
      if (existing.has(entry.ethAddress)) continue;

      const wallet: TrackedWallet = {
        address: entry.ethAddress,
        tier: 'watchlist',
        score: 0,
        added_by: 'auto',
        active: false, // Erst nach Score-Berechnung aktivieren
        sharpe_ratio: 0,
        max_drawdown_pct: 0,
        win_rate: 0,
        profit_factor: 0,
        total_trades: 0,
        track_record_days: 0,
        avg_leverage: 0,
        streak: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      newWallets.push(wallet);
    }

    return newWallets;
  }
}
