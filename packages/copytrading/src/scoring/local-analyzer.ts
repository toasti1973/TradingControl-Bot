// ============================================================
// LocalAnalyzer — Stufe 2: Regelbasierte Schnellanalyse OHNE API-Kosten
// Filtert ~200-300 vorvalidierte Signale auf ~5-15 fuer Claude
// Laeuft lokal in <10ms pro Signal
// ============================================================

import type { WalletSignal, SentimentData, TrackedWallet } from '../types/index.js';
import type { OrderFlowSnapshot } from './orderflow-analyzer.js';

export interface LocalAnalysisResult {
  pass: boolean;
  score: number;      // 0-100 lokaler Quick-Score
  reason: string;
  factors: string[];  // Welche Faktoren haben beigetragen
}

export class LocalAnalyzer {

  analyze(
    signal: WalletSignal,
    wallet: TrackedWallet,
    currentPrice: number,
    sentiment: SentimentData,
    openPositionSymbols: string[],
    orderFlow?: OrderFlowSnapshot | null,
  ): LocalAnalysisResult {
    let score = 50; // Neutral starten
    const factors: string[] = [];

    // --- 1. Wallet-Qualitaet (0-30 Punkte) ---
    if (wallet.score >= 85) {
      score += 30;
      factors.push('Tier-1 Wallet (+30)');
    } else if (wallet.score >= 70) {
      score += 20;
      factors.push('Tier-2 Wallet (+20)');
    } else if (wallet.score >= 55) {
      score += 10;
      factors.push('Tier-3 Wallet (+10)');
    }

    // Win Rate Bonus/Malus
    if (wallet.win_rate >= 65) {
      score += 10;
      factors.push(`Win Rate ${wallet.win_rate.toFixed(0)}% (+10)`);
    } else if (wallet.win_rate < 45) {
      score -= 15;
      factors.push(`Win Rate ${wallet.win_rate.toFixed(0)}% (-15)`);
    }

    // Streak
    if (wallet.streak >= 3) {
      score += 5;
      factors.push(`Gewinn-Streak +${wallet.streak} (+5)`);
    } else if (wallet.streak <= -3) {
      score -= 20;
      factors.push(`Verlust-Streak ${wallet.streak} (-20)`);
    }

    // --- 2. Signal-Typ (0-15 Punkte) ---
    if (signal.signal_type === 'open') {
      score += 15;
      factors.push('Neuer Trade (open) (+15)');
    } else if (signal.signal_type === 'increase') {
      score += 5;
      factors.push('Position erhoet (increase) (+5)');
    }

    // --- 3. Sentiment-Check (-20 bis +10) ---
    const fgi = sentiment.fear_greed_index;

    // Contrarian: Extreme Fear + Long Signal = gut
    if (fgi <= 20 && signal.direction === 'long') {
      score += 10;
      factors.push(`Extreme Fear + Long (contrarian) (+10)`);
    }
    // Contrarian: Extreme Greed + Short Signal = gut
    else if (fgi >= 80 && signal.direction === 'short') {
      score += 10;
      factors.push(`Extreme Greed + Short (contrarian) (+10)`);
    }
    // Herd: Extreme Fear + Short = riskant
    else if (fgi <= 20 && signal.direction === 'short') {
      score -= 10;
      factors.push(`Extreme Fear + Short (Herd-Risk) (-10)`);
    }
    // Herd: Extreme Greed + Long = riskant
    else if (fgi >= 80 && signal.direction === 'long') {
      score -= 10;
      factors.push(`Extreme Greed + Long (Herd-Risk) (-10)`);
    }

    // Funding Rate: Extreme Funding = ueberhitzter Markt
    const fundingAbs = Math.abs(sentiment.btc_funding_rate);
    if (fundingAbs > 0.05) {
      score -= 10;
      factors.push(`Extreme Funding Rate ${sentiment.btc_funding_rate.toFixed(3)}% (-10)`);
    }

    // --- 4. High-Leverage Vorsicht (-10) ---
    if (signal.leverage > 20) {
      score -= 10;
      factors.push(`High Leverage ${signal.leverage}x (-10)`);
    } else if (signal.leverage > 10) {
      score -= 5;
      factors.push(`Mittlerer Leverage ${signal.leverage}x (-5)`);
    }

    // --- 5. Duplikat-Asset im Portfolio (-20) ---
    if (openPositionSymbols.includes(signal.symbol)) {
      score -= 20;
      factors.push(`${signal.symbol} bereits im Portfolio (-20)`);
    }

    // --- 7. Order-Flow Bestaetigung/Divergenz (-30 bis +25) ---
    if (orderFlow) {
      const deltaPct = orderFlow.delta_pct;
      const isLong = signal.direction === 'long';

      // Delta-Bestaetigung: Long + positives Delta = bullish, Short + negatives Delta = bearish
      if (isLong && deltaPct > 15) {
        score += 15;
        factors.push(`Bullisches Delta ${deltaPct.toFixed(1)}% (+15)`);
      } else if (!isLong && deltaPct < -15) {
        score += 15;
        factors.push(`Bearisches Delta ${deltaPct.toFixed(1)}% (+15)`);
      }
      // Delta-Divergenz: Long + stark negatives Delta = Warnung
      else if (isLong && deltaPct < -25) {
        score -= 25;
        factors.push(`Delta-Divergenz Long bei ${deltaPct.toFixed(1)}% (-25)`);
      } else if (!isLong && deltaPct > 25) {
        score -= 25;
        factors.push(`Delta-Divergenz Short bei ${deltaPct.toFixed(1)}% (-25)`);
      }

      // Imbalance-Zonen in Signal-Richtung
      const matchingImbalance = orderFlow.imbalance_zones.find(
        z => (isLong && z.side === 'buy') || (!isLong && z.side === 'sell')
      );
      if (matchingImbalance) {
        const bonus = matchingImbalance.strength === 'strong' ? 10
          : matchingImbalance.strength === 'medium' ? 6 : 3;
        score += bonus;
        factors.push(`${matchingImbalance.side}-Imbalance ${matchingImbalance.strength} (+${bonus})`);
      }

      // Gegen-Imbalance ist Warnung
      const oppositeImbalance = orderFlow.imbalance_zones.find(
        z => (isLong && z.side === 'sell') || (!isLong && z.side === 'buy')
      );
      if (oppositeImbalance && oppositeImbalance.strength === 'strong') {
        score -= 15;
        factors.push(`Gegen-Imbalance ${oppositeImbalance.side} (-15)`);
      }

      // PoC-Naehe: Entry am PoC ist suboptimal (zu viel Liquiditaet)
      const pocDistance = Math.abs(currentPrice - orderFlow.poc) / currentPrice * 100;
      if (pocDistance < 0.1) {
        score -= 5;
        factors.push(`Entry am PoC (-5)`);
      }
    }

    // --- 6. Preis-Plausibilitaet ---
    if (currentPrice <= 0) {
      score -= 30;
      factors.push('Kein gueltiger Preis (-30)');
    }

    // Score clampen
    score = Math.max(0, Math.min(100, score));

    // Schwelle: Mindestens 60 fuer Claude-Analyse
    const pass = score >= 60;

    return {
      pass,
      score,
      reason: pass
        ? `Lokaler Score ${score}/100 — weiter an Claude`
        : `Lokaler Score ${score}/100 — zu niedrig fuer Claude-Analyse`,
      factors,
    };
  }
}
