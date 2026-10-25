// ============================================================
// CopyTradingService — Verbindet CopyTrading-Engine mit Bot-Infrastruktur
// 3-Stufen-Pipeline: WalletMonitor → Vorfilter → LocalAnalyzer → Claude → Trade
// ============================================================

import {
  HyperliquidClient,
  WalletScorer,
  WalletMonitor,
  SignalPreprocessor,
  ConvictionEngine,
  SentimentService,
  DecisionGate,
  CopyTradeExecutor,
  LocalAnalyzer,
  MarketDataService,
  OrderFlowAnalyzer,
  type TrackedWallet,
  type WalletSignal,
  type CopyTradingConfig,
  type ConvictionInput,
  type HLLeaderboardEntry,
} from '@tradingcontrol/copytrading';
import { PaperBroker, type BrokerAdapter } from '@tradingcontrol/core';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Logger } from './log-service.js';

export class CopyTradingService {
  private hlClient: HyperliquidClient;
  private scorer: WalletScorer;
  private monitor: WalletMonitor | null = null;
  private preprocessor: SignalPreprocessor | null = null;
  private localAnalyzer: LocalAnalyzer;
  private marketData: MarketDataService;
  private orderFlow: OrderFlowAnalyzer;
  private conviction: ConvictionEngine | null = null;
  private sentiment: SentimentService;
  private decisionGate: DecisionGate | null = null;

  private executor: CopyTradeExecutor | null = null;
  private broker: BrokerAdapter | null = null;

  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private monitorRunning = false;

  // Stats
  private signalsReceived = 0;
  private signalsPassedStage1 = 0;
  private signalsPassedStage2 = 0;
  private signalsAnalyzed = 0;    // Claude-Analysen (Stage 3)
  private tradesExecuted = 0;
  private signalsSkipped = 0;

  // Event-Listeners
  private listeners: Array<(event: string, data: unknown) => void> = [];

  constructor(
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {
    this.hlClient = new HyperliquidClient();
    this.scorer = new WalletScorer();
    this.localAnalyzer = new LocalAnalyzer();
    this.marketData = new MarketDataService();
    this.orderFlow = new OrderFlowAnalyzer();
    this.sentiment = new SentimentService();
  }

  onEvent(listener: (event: string, data: unknown) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: string, data: unknown): void {
    for (const l of this.listeners) {
      try { l(event, data); } catch { /* ignore */ }
    }
  }

  // ============================================================
  // Signal-Pipeline starten/stoppen
  // ============================================================

  async startMonitoring(config: {
    claudeApiKey: string;
    claudeModel: string;
    portfolioSize: number;
    minCombinedScore: number;
    minConvictionScore: number;
  }): Promise<void> {
    if (this.monitorRunning) return;

    const ctConfig: CopyTradingConfig = {
      enabled: true,
      claude_model: config.claudeModel as CopyTradingConfig['claude_model'],
      claude_api_key: config.claudeApiKey,
      portfolio_size_usd: config.portfolioSize,
      max_tracked_wallets: 50,
      min_wallet_score: 40,
      wallet_poll_interval_ms: 10_000, // 10s Polling
      min_combined_score: config.minCombinedScore,
      min_conviction_score: config.minConvictionScore,
      max_portfolio_drawdown_pct: 15,
      daily_loss_limit_pct: 5,
      max_exposure_per_asset_pct: 10,
      max_concurrent_positions: 5,
      max_portfolio_leverage: 5,
      max_correlation: 0.7,
      default_sl_atr_multiplier: 1.5,
      min_risk_reward: 1.5,
      trailing_stop_activation_r: 2.0,
      partial_close_at_r: 1.5,
      partial_close_pct: 50,
      max_hold_hours: 72,
      reentry_cooldown_hours: 4,
      high_leverage_threshold: 20,
      high_leverage_size_factor: 0.5,
    };

    this.preprocessor = new SignalPreprocessor(ctConfig);
    this.conviction = new ConvictionEngine(ctConfig);
    this.decisionGate = new DecisionGate(ctConfig);
    this.monitor = new WalletMonitor(this.hlClient, ctConfig.wallet_poll_interval_ms);

    // Paper-Broker fuer realistisches Paper-Trading
    this.broker = new PaperBroker({ priceSource: 'phemex' });
    await this.broker.connect();
    this.executor = new CopyTradeExecutor(this.broker, ctConfig);

    // Executor-Events loggen
    this.executor.on('opened', (pos) => {
      this.logger.info({
        id: pos.id, symbol: pos.symbol, direction: pos.direction,
        entry: pos.entry_price, size: pos.size, margin: pos.margin_usd,
        sl: pos.sl_price, tp: pos.tp_prices,
      }, 'CT PAPER-TRADE eroeffnet');
      // In DB persistieren
      this.store.insertCtTrade({
        id: pos.id, signal_id: pos.signal_id, wallet_address: pos.wallet_address,
        symbol: pos.symbol, direction: pos.direction, entry_price: pos.entry_price,
        size: pos.size, leverage: pos.leverage, margin_usd: pos.margin_usd,
        status: 'open', sl_price: pos.sl_price, tp_prices: pos.tp_prices,
        opened_at: pos.opened_at,
      });
      this.emit('ct:trade:opened', pos);
    });

    this.executor.on('closed', (pos) => {
      this.logger.info({
        id: pos.id, symbol: pos.symbol, pnl: pos.realized_pnl.toFixed(2),
        reason: pos.exit_reason, entry: pos.entry_price, exit: pos.exit_price,
      }, 'CT PAPER-TRADE geschlossen');
      // DB updaten
      this.store.updateCtTrade(pos.id, {
        status: 'closed', exit_price: pos.exit_price ?? undefined,
        realized_pnl: pos.realized_pnl, exit_reason: pos.exit_reason ?? undefined,
        closed_at: pos.closed_at ?? undefined,
      });
      this.emit('ct:trade:closed', pos);
    });

    this.executor.on('tp_hit', (data: { id: string; remaining_size: number }) => {
      this.logger.info(data, 'CT Take-Profit erreicht');
      this.store.updateCtTrade(data.id, { size: data.remaining_size });
      this.emit('ct:tp_hit', data);
    });

    this.executor.on('trailing_activated', (data: { id: string; price: number }) => {
      this.logger.info(data, 'CT Trailing-Stop aktiviert');
      this.store.updateCtTrade(data.id, { trailing_active: true, trailing_stop_price: data.price });
    });

    this.executor.on('sl_updated', (data: { id: string; newSlPrice: number }) => {
      this.logger.debug(data, 'CT Stop-Loss aktualisiert');
      this.store.updateCtTrade(data.id, { sl_price: data.newSlPrice });
    });

    this.executor.on('error', (data) => {
      this.logger.warn(data, 'CT Executor-Fehler');
    });

    this.executor.on('rejected', (data) => {
      this.logger.info(data, 'CT Trade abgelehnt (Risk-Limit)');
    });

    // Aktive Wallets aus DB laden und zum Monitor hinzufuegen
    const wallets = this.store.getCtWallets();
    let activeCount = 0;
    for (const w of wallets) {
      if (!w.active) continue;
      const wallet: TrackedWallet = {
        address: w.address as string,
        label: w.label as string | undefined,
        tier: w.tier as TrackedWallet['tier'],
        score: w.score as number,
        added_by: w.added_by as 'auto' | 'manual',
        active: true,
        sharpe_ratio: w.sharpe_ratio as number,
        max_drawdown_pct: w.max_drawdown_pct as number,
        win_rate: w.win_rate as number,
        profit_factor: w.profit_factor as number,
        total_trades: w.total_trades as number,
        track_record_days: w.track_record_days as number,
        avg_leverage: w.avg_leverage as number,
        streak: w.streak as number,
        created_at: w.created_at as string,
        updated_at: w.updated_at as string,
      };
      this.monitor.addWallet(wallet);
      activeCount++;
    }

    // Signal-Handler verbinden
    this.monitor.on('signal', (signal: WalletSignal) => {
      // Close/Decrease Signale an Executor weiterleiten
      if (signal.signal_type === 'close' && this.executor) {
        void this.executor.onWalletClose(signal.wallet_address, signal.symbol);
        return;
      }
      if (signal.signal_type === 'decrease' && this.executor) {
        void this.executor.onWalletReduce(signal.wallet_address, signal.symbol, 30); // 30% reduzieren
        return;
      }
      void this.processSignal(signal);
    });

    this.monitor.on('error', (err: { wallet: string; error: string }) => {
      this.logger.warn({ wallet: err.wallet.slice(0, 8) }, `CT Monitor: ${err.error}`);
    });

    await this.monitor.start();
    this.monitorRunning = true;

    this.logger.info({ activeWallets: activeCount }, 'CopyTrading: Signal-Monitoring gestartet');
    this.emit('ct:started', { activeWallets: activeCount });
  }

  stopMonitoring(): void {
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
    }
    if (this.conviction) {
      void this.conviction.shutdown();
      this.conviction = null;
    }
    if (this.executor) {
      this.executor.shutdown();
      // Executor nicht nullen — offene Positionen bleiben tracked
    }
    this.monitorRunning = false;
    this.logger.info('CopyTrading: Signal-Monitoring gestoppt');
    this.emit('ct:stopped', {});
  }

  // ============================================================
  // Signal-Pipeline
  // ============================================================

  private async processSignal(signal: WalletSignal): Promise<void> {
    this.signalsReceived++;

    // In DB speichern (minimal — kein Log-Spam)
    this.store.insertCtSignal({
      id: signal.id,
      wallet_address: signal.wallet_address,
      wallet_tier: signal.wallet_tier,
      wallet_score: signal.wallet_score,
      signal_type: signal.signal_type,
      symbol: signal.symbol,
      direction: signal.direction,
      size: signal.size,
      leverage: signal.leverage,
      entry_price: signal.entry_price,
      detected_at: signal.detected_at,
      status: 'pending',
    });

    // ========== STUFE 1: Vorfilter (kostenlos, <1ms) ==========
    if (!this.preprocessor) return;
    const validation = this.preprocessor.validate(signal);
    if (!validation.valid) {
      this.store.updateCtSignalStatus(signal.id, 'rejected', { rejection_reason: `[S1] ${validation.reason}` });
      return;
    }
    this.signalsPassedStage1++;

    // ========== STUFE 2: Lokale Schnellanalyse (kostenlos, <10ms) ==========
    const wallet = this.monitor?.getTrackedWallets().find(w => w.address === signal.wallet_address);
    if (!wallet) return;

    const sentimentData = await this.sentiment.getSentiment();
    const mids = await this.hlClient.getAllMidPrices();
    const coin = signal.symbol.replace('USDT', '');
    const price = mids[coin] ?? signal.entry_price;

    const openSymbols = this.executor?.getOpenPositions().map(p => p.symbol) ?? [];

    // Order-Flow Analyse (Binance aggTrades, Cache 5 Min)
    const orderFlowSnapshot = await this.orderFlow.analyze(signal.symbol, price);

    const localResult = this.localAnalyzer.analyze(signal, wallet, price, sentimentData, openSymbols, orderFlowSnapshot);

    if (!localResult.pass) {
      this.store.updateCtSignalStatus(signal.id, 'rejected', {
        rejection_reason: `[S2] ${localResult.reason} | ${localResult.factors.join(', ')}`,
      });
      return;
    }
    this.signalsPassedStage2++;

    this.logger.info({
      wallet: signal.wallet_address.slice(0, 8),
      symbol: signal.symbol,
      type: signal.signal_type,
      direction: signal.direction,
      localScore: localResult.score,
    }, 'CT Signal passiert Stufe 1+2 — sende an Claude');

    this.store.updateCtSignalStatus(signal.id, 'validated');

    // ========== STUFE 3: Claude Conviction-Analyse (kostenpflichtig) ==========
    if (!this.conviction) return;

    // Echte Marktdaten von Binance holen
    const realMarketData = await this.marketData.getMarketData(signal.symbol, price);

    const convictionInput: ConvictionInput = {
      signal,
      wallet,
      market_data: realMarketData,
      sentiment: sentimentData,
      open_positions: openSymbols.map(s => ({
        symbol: s, direction: 'long' as const, size_usd: 0, pnl_pct: 0, correlation_to_btc: 0.5,
      })),
    };

    const convictionResult = await this.conviction.analyze(convictionInput);
    this.signalsAnalyzed++;

    this.store.updateCtSignalStatus(signal.id, 'analyzed', {
      conviction_json: JSON.stringify(convictionResult),
    });

    this.logger.info({
      symbol: signal.symbol,
      conviction: convictionResult.conviction_score,
      execute: convictionResult.execute,
      reasoning: convictionResult.reasoning.slice(0, 120),
    }, 'CT Claude-Analyse abgeschlossen');

    this.emit('ct:conviction', { signal, conviction: convictionResult });

    // ========== DECISION GATE ==========
    if (!this.decisionGate) return;
    const decision = this.decisionGate.evaluate(signal, convictionResult);

    if (decision.action === 'reject' || decision.action === 'skip') {
      this.signalsSkipped++;
      this.store.updateCtSignalStatus(signal.id, 'skipped', {
        rejection_reason: `Combined ${decision.combined}: ${decision.action}`,
      });
      this.logger.info({ combined: decision.combined, action: decision.action }, 'CT Trade uebersprungen');
      return;
    }

    // ========== TRADE AUSFUEHREN ==========
    if (!this.executor) return;

    // Preis im PaperBroker setzen (Hyperliquid-Assets existieren nicht auf Phemex)
    if (this.broker && 'setPrice' in this.broker && price > 0) {
      (this.broker as { setPrice: (s: string, p: number) => void }).setPrice(signal.symbol, price);
    }

    const position = await this.executor.openTrade(signal, decision, convictionResult, orderFlowSnapshot);
    if (position) {
      this.tradesExecuted++;
      this.store.updateCtSignalStatus(signal.id, 'executed', {
        trade_id: position.id,
        rejection_reason: `Combined ${decision.combined} | ${decision.action} | $${position.margin_usd.toFixed(2)} Margin | SL $${position.sl_price}`,
      });
    } else {
      this.signalsSkipped++;
      this.store.updateCtSignalStatus(signal.id, 'skipped', {
        rejection_reason: 'Executor rejected (Risk-Limit)',
      });
    }
  }

  // ============================================================
  // Leaderboard & Scoring (unveraendert)
  // ============================================================

  async scanLeaderboard(maxWallets = 100): Promise<{ added: number; updated: number; total: number }> {
    this.logger.info('CopyTrading: Scanning Hyperliquid leaderboard...');

    let leaderboard: HLLeaderboardEntry[];
    try {
      leaderboard = await this.hlClient.getLeaderboard('month');
    } catch (err) {
      this.logger.error({ err }, 'CopyTrading: Failed to fetch leaderboard');
      throw err;
    }

    const existingWallets = new Set(
      this.store.getCtWallets().map(w => (w.address as string).toLowerCase())
    );

    let added = 0;
    let updated = 0;

    const candidates = leaderboard.slice(0, maxWallets);

    for (const entry of candidates) {
      const address = entry.ethAddress.toLowerCase();

      const allTimePerf = entry.windowPerformances?.find(p => p.window === 'allTime');
      const pnl = allTimePerf ? parseFloat(allTimePerf.pnl) : 0;

      if (existingWallets.has(address)) {
        updated++;
        continue;
      }

      try {
        const stats = await this.hlClient.getWalletStats(address);
        const scoreResult = this.scorer.calculateScore(stats.fills, stats.accountValue);

        const walletData: TrackedWallet = {
          address,
          label: `HL-Top (PnL: ${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()})`,
          tier: 'watchlist',
          score: scoreResult.total,
          added_by: 'auto',
          active: scoreResult.total >= 40,
          sharpe_ratio: scoreResult.raw_sharpe,
          max_drawdown_pct: scoreResult.raw_max_drawdown,
          win_rate: 0,
          profit_factor: scoreResult.raw_profit_factor,
          total_trades: stats.fills.length,
          track_record_days: 90,
          avg_leverage: 0,
          streak: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        const closingFills = stats.fills.filter(f => parseFloat(f.closedPnl) !== 0);
        const wins = closingFills.filter(f => parseFloat(f.closedPnl) > 0).length;
        walletData.win_rate = closingFills.length > 0 ? (wins / closingFills.length) * 100 : 0;

        const leverages = stats.positions.map(p => p.leverage.value).filter(v => v > 0);
        walletData.avg_leverage = leverages.length > 0
          ? leverages.reduce((s, v) => s + v, 0) / leverages.length
          : 0;

        walletData.tier = this.scorer.determineTier(scoreResult.total, walletData);

        this.store.upsertCtWallet({
          address: walletData.address,
          label: walletData.label,
          tier: walletData.tier,
          score: walletData.score,
          added_by: walletData.added_by,
          active: walletData.active,
          sharpe_ratio: walletData.sharpe_ratio,
          max_drawdown_pct: walletData.max_drawdown_pct,
          win_rate: walletData.win_rate,
          profit_factor: walletData.profit_factor,
          total_trades: walletData.total_trades,
          track_record_days: walletData.track_record_days,
          avg_leverage: walletData.avg_leverage,
          streak: walletData.streak,
        });

        added++;
        this.logger.info({
          address: address.slice(0, 8) + '...',
          score: scoreResult.total,
          tier: walletData.tier,
        }, 'CopyTrading: Wallet added');

        // Wallet zum laufenden Monitor hinzufuegen
        if (this.monitor && walletData.active) {
          this.monitor.addWallet(walletData);
        }

        await new Promise(r => setTimeout(r, 200));
      } catch {
        this.logger.warn({ address: address.slice(0, 8) }, 'CopyTrading: Failed to analyze wallet');
      }
    }

    const total = this.store.getCtWallets().length;
    this.logger.info({ added, updated, total }, 'CopyTrading: Leaderboard scan complete');
    return { added, updated, total };
  }

  async updateAllScores(): Promise<void> {
    const wallets = this.store.getCtWallets();
    this.logger.info({ count: wallets.length }, 'CopyTrading: Updating wallet scores...');

    for (const w of wallets) {
      const address = w.address as string;
      try {
        const stats = await this.hlClient.getWalletStats(address);
        const scoreResult = this.scorer.calculateScore(stats.fills, stats.accountValue);

        const closingFills = stats.fills.filter(f => parseFloat(f.closedPnl) !== 0);
        const wins = closingFills.filter(f => parseFloat(f.closedPnl) > 0).length;
        const winRate = closingFills.length > 0 ? (wins / closingFills.length) * 100 : 0;

        const leverages = stats.positions.map(p => p.leverage.value).filter(v => v > 0);
        const avgLeverage = leverages.length > 0
          ? leverages.reduce((s, v) => s + v, 0) / leverages.length
          : 0;

        const tier = this.scorer.determineTier(scoreResult.total, {
          ...w as unknown as TrackedWallet,
          score: scoreResult.total,
        });

        this.store.upsertCtWallet({
          address,
          label: w.label as string | undefined,
          tier,
          score: scoreResult.total,
          added_by: w.added_by as string,
          active: scoreResult.total >= 40,
          sharpe_ratio: scoreResult.raw_sharpe,
          max_drawdown_pct: scoreResult.raw_max_drawdown,
          win_rate: winRate,
          profit_factor: scoreResult.raw_profit_factor,
          total_trades: stats.fills.length,
          track_record_days: w.track_record_days as number,
          avg_leverage: avgLeverage,
          streak: w.streak as number,
        });

        await new Promise(r => setTimeout(r, 200));
      } catch {
        this.logger.warn({ address: address.slice(0, 8) }, 'CopyTrading: Score update failed');
      }
    }

    this.logger.info('CopyTrading: Score update complete');
  }

  // ============================================================
  // Auto-Scanner
  // ============================================================

  startAutoScan(intervalHours = 24): void {
    if (this.scanTimer) return;
    this.running = true;

    setTimeout(() => {
      if (this.running) void this.runFullScan();
    }, 10_000);

    this.scanTimer = setInterval(() => {
      if (this.running) void this.runFullScan();
    }, intervalHours * 60 * 60 * 1000);

    this.logger.info({ intervalHours }, 'CopyTrading: Auto-scan started');
  }

  stopAutoScan(): void {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private async runFullScan(): Promise<void> {
    try {
      await this.scanLeaderboard();
      await this.updateAllScores();
    } catch (err) {
      this.logger.error({ err }, 'CopyTrading: Full scan failed');
    }
  }

  // ============================================================
  // Status
  // ============================================================

  isRunning(): boolean {
    return this.running;
  }

  isMonitoring(): boolean {
    return this.monitorRunning;
  }

  getMonitorStats() {
    const openPositions = this.executor?.getOpenPositions() ?? [];
    const closedPositions = this.executor?.getClosedPositions() ?? [];
    return {
      monitoring: this.monitorRunning,
      signals_received: this.signalsReceived,
      stage1_passed: this.signalsPassedStage1,
      stage2_passed: this.signalsPassedStage2,
      claude_analyses: this.signalsAnalyzed,
      trades_executed: this.tradesExecuted,
      signals_skipped: this.signalsSkipped,
      tracked_wallets: this.monitor?.getTrackedWallets().length ?? 0,
      open_positions: openPositions.length,
      closed_trades: closedPositions.length,
      total_pnl: this.executor?.getTotalPnl() ?? 0,
      margin_in_use: this.executor?.getTotalMarginInUse() ?? 0,
      positions: openPositions.map(p => ({
        id: p.id,
        symbol: p.symbol,
        direction: p.direction,
        entry_price: p.entry_price,
        size: p.size,
        margin_usd: p.margin_usd,
        sl_price: p.sl_price,
        tp_prices: p.tp_prices,
        trailing: p.trailing_active,
        opened_at: p.opened_at,
      })),
    };
  }

  getExecutor(): CopyTradeExecutor | null {
    return this.executor;
  }

  async stop(): Promise<void> {
    this.stopMonitoring();
    this.stopAutoScan();
  }
}
