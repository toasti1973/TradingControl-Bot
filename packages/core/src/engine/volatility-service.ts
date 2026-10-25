import { EventEmitter } from 'node:events';

export interface VolatilityServiceEvents {
  'atr:update': [symbol: string, atr: number, avgAtr: number];
}

export interface VolatilityServiceConfig {
  /** ATR period (default: 14) */
  atrPeriod?: number;
  /** Candle interval for ATR calculation (default: '4h') */
  interval?: '1h' | '4h' | '1d';
  /** How often to refresh ATR data in ms (default: 5 minutes) */
  refreshInterval?: number;
}

interface AtrData {
  atr: number;
  avgAtr: number; // 20-period average of ATR
  lastUpdate: number;
}

export class VolatilityService extends EventEmitter<VolatilityServiceEvents> {
  private readonly atrPeriod: number;
  private readonly interval: string;
  private readonly refreshInterval: number;
  private atrCache = new Map<string, AtrData>();
  private watchedSymbols = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: VolatilityServiceConfig = {}) {
    super();
    this.atrPeriod = config.atrPeriod ?? 14;
    this.interval = config.interval ?? '4h';
    this.refreshInterval = config.refreshInterval ?? 5 * 60 * 1000;
  }

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  watchSymbol(symbol: string): void {
    this.watchedSymbols.add(symbol.toUpperCase());
  }

  unwatchSymbol(symbol: string): void {
    this.watchedSymbols.delete(symbol.toUpperCase());
    this.atrCache.delete(symbol.toUpperCase());
  }

  /** Get current ATR for symbol (null if not yet calculated) */
  getAtr(symbol: string): number | null {
    return this.atrCache.get(symbol.toUpperCase())?.atr ?? null;
  }

  /** Get average ATR (20-period SMA of ATR values) */
  getAvgAtr(symbol: string): number | null {
    return this.atrCache.get(symbol.toUpperCase())?.avgAtr ?? null;
  }

  /** Calculate dynamic stop-loss based on ATR */
  calcDynamicSl(entryPrice: number, symbol: string, direction: 'long' | 'short', multiplier = 2.0): number | null {
    const atr = this.getAtr(symbol);
    if (atr === null) return null;

    return direction === 'long'
      ? entryPrice - atr * multiplier
      : entryPrice + atr * multiplier;
  }

  /** Calculate dynamic take-profit based on ATR */
  calcDynamicTp(entryPrice: number, symbol: string, direction: 'long' | 'short', multiplier = 3.0): number | null {
    const atr = this.getAtr(symbol);
    if (atr === null) return null;

    return direction === 'long'
      ? entryPrice + atr * multiplier
      : entryPrice - atr * multiplier;
  }

  /** Calculate position size normalized by volatility */
  calcVolAdjustedSize(baseSize: number, symbol: string): number | null {
    const atr = this.getAtr(symbol);
    const avgAtr = this.getAvgAtr(symbol);
    if (atr === null || avgAtr === null || atr === 0) return baseSize;

    // When volatility is double the average → half the size
    const ratio = avgAtr / atr;
    // Clamp between 0.25x and 2x
    const clamped = Math.max(0.25, Math.min(2.0, ratio));
    return baseSize * clamped;
  }

  /** Check if current volatility is abnormally high (> 2x average) */
  isHighVolatility(symbol: string): boolean {
    const atr = this.getAtr(symbol);
    const avgAtr = this.getAvgAtr(symbol);
    if (atr === null || avgAtr === null || avgAtr === 0) return false;
    return atr > avgAtr * 2;
  }

  /** Check if it's a low-liquidity time window (00:00-04:00 UTC) */
  isLowLiquidityWindow(): boolean {
    const hour = new Date().getUTCHours();
    return hour >= 0 && hour < 4;
  }

  /** Get full volatility stats for a symbol */
  getStats(symbol: string): {
    atr: number | null;
    avgAtr: number | null;
    volatilityRatio: number | null;
    highVolatility: boolean;
    lowLiquidity: boolean;
  } {
    const atr = this.getAtr(symbol);
    const avgAtr = this.getAvgAtr(symbol);
    return {
      atr,
      avgAtr,
      volatilityRatio: atr !== null && avgAtr !== null && avgAtr > 0 ? atr / avgAtr : null,
      highVolatility: this.isHighVolatility(symbol),
      lowLiquidity: this.isLowLiquidityWindow(),
    };
  }

  async refresh(): Promise<void> {
    const symbols = [...this.watchedSymbols];
    await Promise.allSettled(symbols.map(s => this.fetchAndCalcAtr(s)));
  }

  private async fetchAndCalcAtr(symbol: string): Promise<void> {
    try {
      // Need atrPeriod + 20 extra candles for avgAtr calculation
      const limit = this.atrPeriod + 25;
      const candles = await this.fetchCandles(symbol, limit);
      if (candles.length < this.atrPeriod + 1) return;

      const atrValues = this.calculateAtrSeries(candles);
      if (atrValues.length === 0) return;

      const currentAtr = atrValues[atrValues.length - 1]!;
      const avgWindow = Math.min(20, atrValues.length);
      const recentAtrs = atrValues.slice(-avgWindow);
      const avgAtr = recentAtrs.reduce((s, v) => s + v, 0) / recentAtrs.length;

      this.atrCache.set(symbol, {
        atr: Math.round(currentAtr * 100) / 100,
        avgAtr: Math.round(avgAtr * 100) / 100,
        lastUpdate: Date.now(),
      });

      this.emit('atr:update', symbol, currentAtr, avgAtr);
    } catch {
      // Silently fail — will retry next interval
    }
  }

  private async fetchCandles(symbol: string, limit: number): Promise<number[][]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${this.interval}&limit=${limit}`;
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) return [];

      const data = await res.json() as (string | number)[][];
      // [openTime, open, high, low, close, volume, ...]
      return data.map(c => [
        Number(c[2]), // high
        Number(c[3]), // low
        Number(c[4]), // close
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private calculateAtrSeries(candles: number[][]): number[] {
    // candles: [[high, low, close], ...]
    const trueRanges: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const [high, low] = candles[i]!;
      const prevClose = candles[i - 1]![2]!;

      const tr = Math.max(
        high! - low!,                  // Current range
        Math.abs(high! - prevClose),   // Gap up
        Math.abs(low! - prevClose),    // Gap down
      );
      trueRanges.push(tr);
    }

    if (trueRanges.length < this.atrPeriod) return [];

    // Initial ATR = SMA of first N true ranges
    const atrValues: number[] = [];
    let atr = trueRanges.slice(0, this.atrPeriod).reduce((s, v) => s + v, 0) / this.atrPeriod;
    atrValues.push(atr);

    // Subsequent ATR = EMA-style smoothing
    for (let i = this.atrPeriod; i < trueRanges.length; i++) {
      atr = (atr * (this.atrPeriod - 1) + trueRanges[i]!) / this.atrPeriod;
      atrValues.push(atr);
    }

    return atrValues;
  }
}
