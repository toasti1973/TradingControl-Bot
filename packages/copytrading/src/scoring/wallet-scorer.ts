// ============================================================
// WalletScorer — Berechnet Wallet-Scores und Tier-Zuordnung
// ============================================================

import type { HLUserFill, TrackedWallet, WalletTier, ScoreComponents } from '../types/index.js';

interface DailyReturn {
  date: string;
  pnl: number;
  trades: number;
}

export class WalletScorer {

  // --- Hauptfunktion: Score berechnen ---
  calculateScore(
    fills: HLUserFill[],
    accountValue: number,
  ): ScoreComponents {
    if (fills.length < 5) {
      return this.emptyScore();
    }

    const dailyReturns = this.computeDailyReturns(fills, accountValue);
    const tradeStats = this.computeTradeStats(fills);

    // 1. Sharpe Ratio (20%) — Krypto: >1.0 gut, >2.0 exzellent
    const sharpe = this.computeSharpe(dailyReturns);
    const sharpeNorm = Math.min(Math.max(sharpe, 0) / 2, 1);
    const sharpeWeighted = sharpeNorm * 20;

    // 2. Drawdown-Qualitaet (15%) — <15% exzellent, >50% = 0
    const maxDD = this.computeMaxDrawdown(dailyReturns);
    const ddNorm = maxDD >= 50 ? 0 : Math.max(0, 1 - maxDD / 50);
    const drawdownWeighted = ddNorm * 15;

    // 3. Win Rate (20%) — >55% gut, >65% exzellent
    const winRateNorm = Math.min(Math.max((tradeStats.winRate - 30) / 40, 0), 1); // 30%=0, 70%=1
    const consistencyWeighted = winRateNorm * 20;

    // 4. Signal-Replizierbarkeit (10%) — Laengere Holds = besser kopierbar
    const replicability = Math.min(tradeStats.avgHoldHours / 4, 1); // 4h+ = Perfekt
    const replicabilityWeighted = replicability * 10;

    // 5. Profitabilitaet (20%) — Netto-PnL positiv?
    const totalPnl = fills.reduce((s, f) => s + parseFloat(f.closedPnl), 0);
    const profitNorm = accountValue > 0
      ? Math.min(Math.max(totalPnl / accountValue + 0.5, 0), 1) // -50% = 0, +50% = 1
      : (totalPnl > 0 ? 0.7 : 0.2);
    const recencyWeighted = profitNorm * 20;

    // 6. Track-Record + Volumen (15%)
    const tradingDays = dailyReturns.length;
    const dayScore = Math.min(tradingDays / 60, 1); // 60 Tage = max
    const tradeCount = fills.length;
    const volumeScore = Math.min(tradeCount / 500, 1); // 500 Trades = max
    const trackRecordWeighted = ((dayScore + volumeScore) / 2) * 15;

    const total = Math.round(
      sharpeWeighted + drawdownWeighted + consistencyWeighted +
      replicabilityWeighted + recencyWeighted + trackRecordWeighted
    );

    // Profit Factor berechnen
    const grossProfit = fills.reduce((s, f) => { const p = parseFloat(f.closedPnl); return p > 0 ? s + p : s; }, 0);
    const grossLoss = fills.reduce((s, f) => { const p = parseFloat(f.closedPnl); return p < 0 ? s + Math.abs(p) : s; }, 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);

    return {
      sharpe_weighted: Math.round(sharpeWeighted * 10) / 10,
      drawdown_weighted: Math.round(drawdownWeighted * 10) / 10,
      consistency_weighted: Math.round(consistencyWeighted * 10) / 10,
      replicability_weighted: Math.round(replicabilityWeighted * 10) / 10,
      recency_weighted: Math.round(recencyWeighted * 10) / 10,
      track_record_weighted: Math.round(trackRecordWeighted * 10) / 10,
      total: Math.min(total, 100),
      raw_sharpe: Math.round(sharpe * 100) / 100,
      raw_max_drawdown: Math.round(maxDD * 100) / 100,
      raw_win_rate: tradeStats.winRate,
      raw_profit_factor: Math.round(profitFactor * 100) / 100,
    };
  }

  // --- Tier bestimmen ---
  determineTier(score: number, wallet: TrackedWallet): WalletTier {
    // Auto-Disqualifikation pruefen
    if (this.isDisqualified(wallet)) return 'blacklist';

    if (score >= 85) return 'tier1';
    if (score >= 70) return 'tier2';
    if (score >= 55) return 'tier3';
    if (score >= 40) return 'watchlist';
    return 'blacklist';
  }

  // --- Auto-Disqualifikation ---
  // KEIN Blacklisting fuer hohen Leverage — nur Performance zaehlt
  private isDisqualified(wallet: TrackedWallet): boolean {
    // Nur bei extremer Inaktivitaet disqualifizieren
    if (wallet.total_trades === 0 && wallet.track_record_days >= 30) {
      return true;
    }
    return false;
  }

  // --- Hilfsfunktionen ---

  private computeDailyReturns(fills: HLUserFill[], accountValue: number): DailyReturn[] {
    const byDay = new Map<string, { pnl: number; trades: number }>();

    for (const fill of fills) {
      const date = new Date(fill.time).toISOString().slice(0, 10);
      const pnl = parseFloat(fill.closedPnl);
      const existing = byDay.get(date) ?? { pnl: 0, trades: 0 };
      existing.pnl += pnl;
      existing.trades++;
      byDay.set(date, existing);
    }

    return Array.from(byDay.entries())
      .map(([date, data]) => ({
        date,
        pnl: accountValue > 0 ? (data.pnl / accountValue) * 100 : 0,
        trades: data.trades,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private computeSharpe(dailyReturns: DailyReturn[]): number {
    if (dailyReturns.length < 7) return 0;
    const returns = dailyReturns.map(d => d.pnl);
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    return (mean / stdDev) * Math.sqrt(365); // Annualisiert
  }

  private computeMaxDrawdown(dailyReturns: DailyReturn[]): number {
    let peak = 0;
    let cumulative = 0;
    let maxDD = 0;

    for (const day of dailyReturns) {
      cumulative += day.pnl;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDD) maxDD = dd;
    }

    return maxDD;
  }

  private computeTradeStats(fills: HLUserFill[]): { avgHoldHours: number; winRate: number } {
    let wins = 0;
    let totalHoldMs = 0;
    let holdCount = 0;

    // Einfache Heuristik: Paare aus Open/Close Fills pro Coin
    const openTimes = new Map<string, number>();
    for (const fill of fills) {
      const pnl = parseFloat(fill.closedPnl);
      if (pnl !== 0) {
        // Closing trade
        if (pnl > 0) wins++;
        const openTime = openTimes.get(fill.coin);
        if (openTime) {
          totalHoldMs += fill.time - openTime;
          holdCount++;
          openTimes.delete(fill.coin);
        }
      } else {
        // Opening trade
        openTimes.set(fill.coin, fill.time);
      }
    }

    const closingTrades = fills.filter(f => parseFloat(f.closedPnl) !== 0).length;
    return {
      avgHoldHours: holdCount > 0 ? totalHoldMs / holdCount / 3_600_000 : 12,
      winRate: closingTrades > 0 ? (wins / closingTrades) * 100 : 0,
    };
  }

  private emptyScore(): ScoreComponents {
    return {
      sharpe_weighted: 0, drawdown_weighted: 0, consistency_weighted: 0,
      replicability_weighted: 0, recency_weighted: 0, track_record_weighted: 0,
      total: 0, raw_sharpe: 0, raw_max_drawdown: 0, raw_win_rate: 0, raw_profit_factor: 0,
    };
  }
}
