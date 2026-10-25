// ============================================================
// DecisionGate — Kombiniert Signal-Score und Conviction zu Entscheidung
// ============================================================

import type {
  CombinedScore,
  ConvictionResult,
  WalletSignal,
  CopyTradingConfig,
} from '../types/index.js';

export class DecisionGate {
  constructor(private readonly config: CopyTradingConfig) {}

  evaluate(signal: WalletSignal, conviction: ConvictionResult): CombinedScore {
    const signalScore = signal.wallet_score;
    const convictionScore = conviction.conviction_score;

    // Gewichtung: 40% Signal, 60% Conviction
    const combined = Math.round(signalScore * 0.4 + convictionScore * 0.6);

    // High-Leverage-Anpassung
    const isHighLeverage = signal.leverage > this.config.high_leverage_threshold;

    // Action bestimmen
    let action: CombinedScore['action'];
    let sizePct: number;
    let maxLev: number;

    if (combined < this.config.min_combined_score) {
      action = 'reject';
      sizePct = 0;
      maxLev = 0;
    } else if (convictionScore < this.config.min_conviction_score && !conviction.execute) {
      action = 'skip';
      sizePct = 0;
      maxLev = 0;
    } else if (combined >= 90) {
      action = 'full_size';
      sizePct = 3;
      maxLev = 5;
    } else if (combined >= 75) {
      action = 'standard';
      sizePct = 2;
      maxLev = 3;
    } else if (combined >= 60) {
      action = 'reduced';
      sizePct = 1;
      maxLev = 2;
    } else if (combined >= 50) {
      action = 'reduced';
      sizePct = 0.5;
      maxLev = 1;
    } else if (combined >= 40) {
      // Paper-Trading: Minimale Position fuer Datensammlung
      action = 'reduced';
      sizePct = 0.25;
      maxLev = 1;
    } else {
      action = 'skip';
      sizePct = 0;
      maxLev = 0;
    }

    // High-Leverage: Groesse halbieren
    if (isHighLeverage && sizePct > 0) {
      sizePct *= this.config.high_leverage_size_factor;
    }

    // Tier-basierte Anpassung
    if (signal.wallet_tier === 'tier2' && sizePct > 0) {
      sizePct = Math.min(sizePct, 2);
    } else if (signal.wallet_tier === 'tier3' && sizePct > 0) {
      sizePct = Math.min(sizePct, 1);
    }

    // Claude-Empfehlung beruecksichtigen
    if (conviction.recommended_size_pct > 0 && sizePct > 0) {
      sizePct = Math.min(sizePct, conviction.recommended_size_pct);
    }
    if (conviction.recommended_leverage > 0 && maxLev > 0) {
      maxLev = Math.min(maxLev, conviction.recommended_leverage);
    }

    return {
      signal_score: signalScore,
      conviction_score: convictionScore,
      combined,
      action,
      size_pct: Math.round(sizePct * 100) / 100,
      max_leverage: maxLev,
    };
  }
}
