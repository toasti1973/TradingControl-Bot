// ============================================================
// MarketDataService — Berechnet echte technische Indikatoren
// Nutzt Binance Public API (kostenlos, kein Key)
// Cache: 60s pro Symbol
// ============================================================

import type { MarketData } from '../types/index.js';

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

interface CacheEntry {
  data: MarketData;
  expires: number;
}

export class MarketDataService {
  private cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 60_000; // 1 Min

  async getMarketData(symbol: string, currentPrice: number): Promise<MarketData> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() < cached.expires) {
      // Preis aktualisieren
      cached.data.price = currentPrice;
      return cached.data;
    }

    try {
      const candles = await this.fetchCandles(symbol, '1h', 210); // 200+ fuer EMA200
      if (candles.length < 20) {
        return this.fallback(symbol, currentPrice);
      }

      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);

      const data: MarketData = {
        symbol,
        price: currentPrice,
        rsi_14: this.calculateRSI(closes, 14),
        ema_200: this.calculateEMA(closes, 200),
        macd: this.calculateMACD(closes),
        atr_14: this.calculateATR(highs, lows, closes, 14),
        bollinger: this.calculateBollinger(closes, 20),
        volume_24h: candles.slice(-24).reduce((s, c) => s + c.volume, 0),
        price_change_24h_pct: candles.length >= 24
          ? ((currentPrice - candles[candles.length - 24]!.close) / candles[candles.length - 24]!.close) * 100
          : 0,
      };

      this.cache.set(symbol, { data, expires: Date.now() + this.cacheTtlMs });
      return data;
    } catch {
      return this.fallback(symbol, currentPrice);
    }
  }

  private async fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    // Binance Symbol Format: BTCUSDT
    const binanceSymbol = symbol.replace('/', '');
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];

    const raw = await res.json() as Array<Array<string | number>>;
    return raw.map(k => ({
      time: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));
  }

  // --- RSI(14) ---
  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i]! - closes[i - 1]!;
      if (change > 0) gains += change;
      else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // --- EMA ---
  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;

    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i]! - ema) * multiplier + ema;
    }
    return ema;
  }

  // --- MACD (12, 26, 9) ---
  private calculateMACD(closes: number[]): { value: number; signal: number; histogram: number } {
    if (closes.length < 26) return { value: 0, signal: 0, histogram: 0 };

    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const macdValue = ema12 - ema26;

    // Signal-Linie: EMA(9) des MACD — vereinfacht
    const macdLine: number[] = [];
    for (let i = 26; i < closes.length; i++) {
      const e12 = this.calculateEMA(closes.slice(0, i + 1), 12);
      const e26 = this.calculateEMA(closes.slice(0, i + 1), 26);
      macdLine.push(e12 - e26);
    }
    const signalLine = macdLine.length >= 9 ? this.calculateEMA(macdLine, 9) : macdValue;

    return {
      value: Math.round(macdValue * 100) / 100,
      signal: Math.round(signalLine * 100) / 100,
      histogram: Math.round((macdValue - signalLine) * 100) / 100,
    };
  }

  // --- ATR(14) ---
  private calculateATR(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) return 0;

    const trueRanges: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(
        highs[i]! - lows[i]!,
        Math.abs(highs[i]! - closes[i - 1]!),
        Math.abs(lows[i]! - closes[i - 1]!)
      );
      trueRanges.push(tr);
    }

    // Letzten `period` TR-Werte mitteln
    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((s, v) => s + v, 0) / recentTR.length;
  }

  // --- Bollinger Bands (20, 2) ---
  private calculateBollinger(closes: number[], period: number): { upper: number; middle: number; lower: number } {
    if (closes.length < period) {
      const price = closes[closes.length - 1] ?? 0;
      return { upper: price * 1.04, middle: price, lower: price * 0.96 };
    }

    const recent = closes.slice(-period);
    const middle = recent.reduce((s, v) => s + v, 0) / period;
    const variance = recent.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: Math.round((middle + 2 * stdDev) * 100) / 100,
      middle: Math.round(middle * 100) / 100,
      lower: Math.round((middle - 2 * stdDev) * 100) / 100,
    };
  }

  private fallback(symbol: string, price: number): MarketData {
    return {
      symbol,
      price,
      rsi_14: 50,
      ema_200: price * 0.95,
      macd: { value: 0, signal: 0, histogram: 0 },
      atr_14: price * 0.02,
      bollinger: { upper: price * 1.04, middle: price, lower: price * 0.96 },
      volume_24h: 0,
      price_change_24h_pct: 0,
    };
  }
}
