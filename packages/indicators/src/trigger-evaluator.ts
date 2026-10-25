// ============================================================
// TriggerEvaluator — Bewertet TC-konforme TriggerBlocks gegen Klines
// Unterstuetzt alle Operatoren aus INDICATORS_CATALOG (Migration 077)
// ============================================================

import type { TriggerBlock, TriggerCondition, IndicatorKind, IndicatorOperator } from '@tradingcontrol/core';
import {
  rsi, macd, ema, sma, bollinger, stochastic, atr, adx, wavetrend,
  isCrossAbove, isCrossBelow, isCrossOver, isCrossUnder,
  type Candle,
} from './ta-functions.js';

export interface EvaluationContext {
  symbol: string;
  candles: Candle[];           // Bereits aggregiert auf gewuenschtes interval
  currentPrice: number;
}

export interface EvaluationResult {
  passed: boolean;
  conditions: Array<{ condition: TriggerCondition; passed: boolean; reason?: string }>;
}

export class TriggerEvaluator {

  evaluate(block: TriggerBlock, ctx: EvaluationContext): EvaluationResult {
    if (!block.enabled && block.enabled !== undefined) {
      return { passed: false, conditions: [] };
    }
    if (!block.conditions || block.conditions.length === 0) {
      return { passed: true, conditions: [] };
    }

    const results = block.conditions.map(c => ({
      condition: c,
      passed: this.evaluateCondition(c, ctx),
    }));

    const passed = block.logic === 'OR'
      ? results.some(r => r.passed)
      : results.every(r => r.passed);

    return { passed, conditions: results };
  }

  evaluateCondition(c: TriggerCondition, ctx: EvaluationContext): boolean {
    if (!ctx.candles || ctx.candles.length < 30) return false;

    const closes = ctx.candles.map(k => k.close);
    const highs = ctx.candles.map(k => k.high);
    const lows = ctx.candles.map(k => k.low);
    const volumes = ctx.candles.map(k => k.volume);
    const lookback = Math.max(1, Math.min(50, c.lookback ?? 1));

    try {
      switch (c.indicator as IndicatorKind) {
        case 'rsi': return this.evalRsi(c, closes, lookback);
        case 'macd': return this.evalMacd(c, closes, lookback);
        case 'ema': return this.evalEma(c, closes, ctx.currentPrice, lookback);
        case 'sma': return this.evalSma(c, closes, ctx.currentPrice, lookback);
        case 'bollinger': return this.evalBollinger(c, closes, ctx.currentPrice, lookback);
        case 'stochastic': return this.evalStochastic(c, highs, lows, closes, lookback);
        case 'atr': return this.evalAtr(c, highs, lows, closes);
        case 'adx': return this.evalAdx(c, highs, lows, closes);
        case 'volume': return this.evalVolume(c, volumes);
        case 'wavetrend': return this.evalWaveTrend(c, highs, lows, closes, lookback);
        default: return false;
      }
    } catch {
      return false;
    }
  }

  // ============================================================
  // RSI
  // ============================================================
  private evalRsi(c: TriggerCondition, closes: number[], lookback: number): boolean {
    const period = Math.round(c.params['period'] ?? 14);
    const series = rsi(closes, period);
    return this.applyComparison(c.operator, series, c.value, c.value_to, lookback);
  }

  // ============================================================
  // MACD
  // ============================================================
  private evalMacd(c: TriggerCondition, closes: number[], lookback: number): boolean {
    const fast = Math.round(c.params['fast'] ?? 12);
    const slow = Math.round(c.params['slow'] ?? 26);
    const signalP = Math.round(c.params['signal'] ?? 9);
    const m = macd(closes, fast, slow, signalP);

    switch (c.operator as IndicatorOperator) {
      case 'cross_above_signal': return isCrossOver(m.macd, m.signal, lookback);
      case 'cross_below_signal': return isCrossUnder(m.macd, m.signal, lookback);
      case 'cross_above_zero': return isCrossAbove(m.macd, 0, lookback);
      case 'cross_below_zero': return isCrossBelow(m.macd, 0, lookback);
      case 'histogram_first_positive': return this.firstSignChange(m.histogram, 'positive', lookback);
      case 'histogram_first_negative': return this.firstSignChange(m.histogram, 'negative', lookback);
      case 'gt': return this.lastFinite(m.macd) > (c.value ?? 0);
      case 'lt': return this.lastFinite(m.macd) < (c.value ?? 0);
      default: return false;
    }
  }

  // ============================================================
  // EMA / SMA — Preis gegen MA
  // ============================================================
  private evalEma(c: TriggerCondition, closes: number[], currentPrice: number, lookback: number): boolean {
    const period = Math.round(c.params['period'] ?? 50);
    const series = ema(closes, period);
    return this.priceVsLine(c.operator, currentPrice, series, closes, lookback);
  }

  private evalSma(c: TriggerCondition, closes: number[], currentPrice: number, lookback: number): boolean {
    const period = Math.round(c.params['period'] ?? 50);
    const series = sma(closes, period);
    return this.priceVsLine(c.operator, currentPrice, series, closes, lookback);
  }

  private priceVsLine(op: IndicatorOperator, price: number, line: number[], closes: number[], lookback: number): boolean {
    const last = line[line.length - 1];
    if (last === undefined || !Number.isFinite(last)) return false;

    switch (op) {
      case 'price_above': return price > last;
      case 'price_below': return price < last;
      case 'price_cross_above': return isCrossOver(closes, line, lookback);
      case 'price_cross_below': return isCrossUnder(closes, line, lookback);
      default: return false;
    }
  }

  // ============================================================
  // Bollinger Bands
  // ============================================================
  private evalBollinger(c: TriggerCondition, closes: number[], currentPrice: number, lookback: number): boolean {
    const period = Math.round(c.params['period'] ?? 20);
    const stdDev = c.params['stddev'] ?? 2;
    const bb = bollinger(closes, period, stdDev);

    const upperLast = bb.upper[bb.upper.length - 1];
    const lowerLast = bb.lower[bb.lower.length - 1];
    const middleLast = bb.middle[bb.middle.length - 1];

    switch (c.operator as IndicatorOperator) {
      case 'price_below_lower': return lowerLast !== undefined && Number.isFinite(lowerLast) && currentPrice < lowerLast;
      case 'price_above_upper': return upperLast !== undefined && Number.isFinite(upperLast) && currentPrice > upperLast;
      case 'price_cross_above_middle': return isCrossOver(closes, bb.middle, lookback);
      case 'price_cross_below_middle': return isCrossUnder(closes, bb.middle, lookback);
      case 'squeeze': {
        // Squeeze: bandwidth unter Schwelle (default 0.05)
        const lastBw = bb.bandwidth[bb.bandwidth.length - 1];
        return lastBw !== undefined && Number.isFinite(lastBw) && lastBw < (c.value ?? 0.05);
      }
      default:
        // Fallback: gt/lt auf middle (Sicherheitsnetz, wird aber selten benutzt)
        if (middleLast === undefined || !Number.isFinite(middleLast)) return false;
        if (c.operator === 'lt') return currentPrice < middleLast;
        if (c.operator === 'gt') return currentPrice > middleLast;
        return false;
    }
  }

  // ============================================================
  // Stochastic
  // ============================================================
  private evalStochastic(c: TriggerCondition, highs: number[], lows: number[], closes: number[], lookback: number): boolean {
    const kP = Math.round(c.params['k'] ?? 14);
    const dP = Math.round(c.params['d'] ?? 3);
    const smooth = Math.round(c.params['smooth'] ?? 3);
    const s = stochastic(highs, lows, closes, kP, dP, smooth);

    switch (c.operator as IndicatorOperator) {
      case 'k_cross_above_d': return isCrossOver(s.k, s.d, lookback);
      case 'k_cross_below_d': return isCrossUnder(s.k, s.d, lookback);
      case 'lt': return this.lastFinite(s.k) < (c.value ?? 20);
      case 'gt': return this.lastFinite(s.k) > (c.value ?? 80);
      default: return false;
    }
  }

  // ============================================================
  // ATR / ADX
  // ============================================================
  private evalAtr(c: TriggerCondition, highs: number[], lows: number[], closes: number[]): boolean {
    const period = Math.round(c.params['period'] ?? 14);
    const series = atr(highs, lows, closes, period);
    const last = this.lastFinite(series);
    if (c.operator === 'gt') return last > (c.value ?? 0);
    if (c.operator === 'lt') return last < (c.value ?? Infinity);
    return false;
  }

  private evalAdx(c: TriggerCondition, highs: number[], lows: number[], closes: number[]): boolean {
    const period = Math.round(c.params['period'] ?? 14);
    const r = adx(highs, lows, closes, period);
    const last = this.lastFinite(r.adx);
    if (c.operator === 'gt') return last > (c.value ?? 25);
    if (c.operator === 'lt') return last < (c.value ?? 20);
    return false;
  }

  // ============================================================
  // Volume
  // ============================================================
  private evalVolume(c: TriggerCondition, volumes: number[]): boolean {
    if (volumes.length < 20) return false;
    const last = volumes[volumes.length - 1]!;
    const avg = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
    if (avg === 0) return false;
    const ratio = last / avg;

    switch (c.operator as IndicatorOperator) {
      case 'gt_avg_x': return ratio > (c.value ?? 2);
      case 'spike': {
        // 3-sigma spike
        const mean = avg;
        const variance = volumes.slice(-20).reduce((s, v) => s + (v - mean) ** 2, 0) / 20;
        const sd = Math.sqrt(variance);
        return sd > 0 && (last - mean) > 3 * sd;
      }
      default: return false;
    }
  }

  // ============================================================
  // WaveTrend
  // ============================================================
  private evalWaveTrend(c: TriggerCondition, highs: number[], lows: number[], closes: number[], lookback: number): boolean {
    const n1 = Math.round(c.params['n1'] ?? 10);
    const n2 = Math.round(c.params['n2'] ?? 21);
    const w = wavetrend(highs, lows, closes, n1, n2);

    switch (c.operator as IndicatorOperator) {
      case 'cross_up': return isCrossOver(w.wt1, w.wt2, lookback);
      case 'cross_down': return isCrossUnder(w.wt1, w.wt2, lookback);
      case 'lt': return this.lastFinite(w.wt1) < (c.value ?? -50);
      case 'gt': return this.lastFinite(w.wt1) > (c.value ?? 50);
      case 'oversold_cross_up': {
        const last = this.lastFinite(w.wt1);
        return last < -50 && isCrossOver(w.wt1, w.wt2, lookback);
      }
      case 'overbought_cross_down': {
        const last = this.lastFinite(w.wt1);
        return last > 50 && isCrossUnder(w.wt1, w.wt2, lookback);
      }
      default: return false;
    }
  }

  // ============================================================
  // Hilfsfunktionen
  // ============================================================
  private applyComparison(op: IndicatorOperator, series: number[], value?: number, valueTo?: number, lookback = 1): boolean {
    const last = this.lastFinite(series);
    switch (op) {
      case 'lt': return value !== undefined && last < value;
      case 'gt': return value !== undefined && last > value;
      case 'in_range': return value !== undefined && valueTo !== undefined && last >= value && last <= valueTo;
      case 'cross_above': return value !== undefined && isCrossAbove(series, value, lookback);
      case 'cross_below': return value !== undefined && isCrossBelow(series, value, lookback);
      default: return false;
    }
  }

  private lastFinite(series: number[]): number {
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i];
      if (v !== undefined && Number.isFinite(v)) return v;
    }
    return NaN;
  }

  private firstSignChange(histogram: number[], target: 'positive' | 'negative', lookback: number): boolean {
    const last = histogram[histogram.length - 1];
    if (last === undefined || !Number.isFinite(last)) return false;
    if (target === 'positive' && last <= 0) return false;
    if (target === 'negative' && last >= 0) return false;
    for (let i = 1; i <= lookback; i++) {
      const prev = histogram[histogram.length - 1 - i];
      if (prev === undefined || !Number.isFinite(prev)) continue;
      if (target === 'positive' && prev <= 0) return true;
      if (target === 'negative' && prev >= 0) return true;
    }
    return false;
  }
}
