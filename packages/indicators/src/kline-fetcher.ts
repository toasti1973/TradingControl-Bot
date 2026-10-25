// ============================================================
// KlineFetcher — Holt OHLCV-Kerzen von Binance Futures (kostenlos, kein Key)
// Mit optionalem Persistenz-Cache (z.B. SQLite)
// ============================================================

import type { Candle } from './ta-functions.js';

export interface KlineCache {
  get(symbol: string, interval: string): { candles: Candle[]; lastUpdated: number } | undefined;
  set(symbol: string, interval: string, candles: Candle[], lastUpdated: number): void;
}

export interface KlineFetcherConfig {
  cache?: KlineCache;
  ttlMs?: number;          // Default: 60s
  baseUrl?: string;        // Default: Binance Futures
}

export class KlineFetcher {
  private memoryCache = new Map<string, { candles: Candle[]; lastUpdated: number }>();
  private readonly ttl: number;
  private readonly persistentCache?: KlineCache;
  private readonly baseUrl: string;

  constructor(config: KlineFetcherConfig = {}) {
    this.persistentCache = config.cache;
    this.ttl = config.ttlMs ?? 60_000;
    this.baseUrl = config.baseUrl ?? 'https://fapi.binance.com';
  }

  async getCandles(symbol: string, interval: string, limit: number = 200): Promise<Candle[]> {
    const key = `${symbol}@${interval}`;
    const now = Date.now();

    // 1. Memory-Cache
    const mem = this.memoryCache.get(key);
    if (mem && now - mem.lastUpdated < this.ttl) {
      return mem.candles;
    }

    // 2. Persistenz-Cache
    if (this.persistentCache) {
      const persisted = this.persistentCache.get(symbol, interval);
      if (persisted && now - persisted.lastUpdated < this.ttl) {
        this.memoryCache.set(key, persisted);
        return persisted.candles;
      }
    }

    // 3. Live fetchen
    try {
      const candles = await this.fetchFromBinance(symbol, interval, limit);
      const entry = { candles, lastUpdated: now };
      this.memoryCache.set(key, entry);
      this.persistentCache?.set(symbol, interval, candles, now);
      return candles;
    } catch {
      // Fallback: stale Cache
      if (mem) return mem.candles;
      const persisted = this.persistentCache?.get(symbol, interval);
      if (persisted) return persisted.candles;
      return [];
    }
  }

  private async fetchFromBinance(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const url = `${this.baseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Binance ${res.status}`);

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
}
