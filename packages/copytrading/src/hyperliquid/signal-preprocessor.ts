// ============================================================
// SignalPreprocessor — Stufe 1: Validiert und filtert eingehende Signale
// Reduziert ~5000 Signale/Tag auf ~200-300
// ============================================================

import type { WalletSignal, CopyTradingConfig } from '../types/index.js';

interface RecentSignal {
  symbol: string;
  direction: string;
  wallet: string;
  signalType: string;
  time: number;
}

export class SignalPreprocessor {
  private recentSignals: RecentSignal[] = [];
  private readonly watchlist: Set<string>;

  // Cooldown: 30 Min pro Wallet+Symbol Kombination
  private readonly cooldownMs = 30 * 60 * 1000;

  // Stats
  private stats = { total: 0, passed: 0, rejected_watchlist: 0, rejected_score: 0, rejected_blacklist: 0, rejected_cooldown: 0, rejected_type: 0 };

  constructor(_config: CopyTradingConfig, watchlistSymbols: string[] = []) {
    this.watchlist = new Set(watchlistSymbols.map(s => s.toUpperCase()));
  }

  updateWatchlist(symbols: string[]): void {
    this.watchlist.clear();
    for (const s of symbols) this.watchlist.add(s.toUpperCase());
  }

  getStats() { return { ...this.stats }; }

  validate(signal: WalletSignal): { valid: boolean; reason?: string } {
    this.stats.total++;
    const now = Date.now();

    // 1. Nur open/increase Signale fuer neue Trades (frueh filtern — kostenlos)
    if (signal.signal_type === 'close' || signal.signal_type === 'decrease') {
      this.stats.rejected_type++;
      return { valid: false, reason: `Signal-Typ ${signal.signal_type} — kein neuer Trade` };
    }

    // 2. Wallet nicht in Blacklist?
    if (signal.wallet_tier === 'blacklist') {
      this.stats.rejected_blacklist++;
      return { valid: false, reason: 'Wallet ist auf Blacklist' };
    }

    // 3. Wallet-Score: open >= 45 (Watchlist+), increase >= 55 (Tier 3+)
    const minScore = signal.signal_type === 'open' ? 45 : 55;
    if (signal.wallet_score < minScore) {
      this.stats.rejected_score++;
      return { valid: false, reason: `Wallet-Score ${signal.wallet_score} unter Minimum ${minScore} fuer ${signal.signal_type}` };
    }

    // 4. Asset auf Watchlist? (wenn Watchlist gesetzt)
    if (this.watchlist.size > 0 && !this.watchlist.has(signal.symbol.toUpperCase())) {
      this.stats.rejected_watchlist++;
      return { valid: false, reason: `${signal.symbol} nicht auf Watchlist` };
    }

    // 5. Cooldown: Max 1 Signal pro Wallet+Symbol+Direction in 30 Min
    const hasCooldown = this.recentSignals.some(
      rs => rs.wallet === signal.wallet_address
        && rs.symbol === signal.symbol
        && rs.direction === signal.direction
        && now - rs.time < this.cooldownMs
    );
    if (hasCooldown) {
      this.stats.rejected_cooldown++;
      return { valid: false, reason: `Cooldown aktiv (30 Min pro Wallet+Symbol)` };
    }

    // 6. Check bereits durch Punkt 3 abgedeckt (increase >= 55)

    // Signal ist valid — in Recent-Liste aufnehmen
    this.recentSignals.push({
      symbol: signal.symbol,
      direction: signal.direction,
      wallet: signal.wallet_address,
      signalType: signal.signal_type,
      time: now,
    });

    // Cleanup: Alte Signale entfernen (>35 min)
    this.recentSignals = this.recentSignals.filter(rs => now - rs.time < 35 * 60 * 1000);

    this.stats.passed++;
    return { valid: true };
  }
}
