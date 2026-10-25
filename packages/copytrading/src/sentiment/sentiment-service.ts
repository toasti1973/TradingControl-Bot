// ============================================================
// SentimentService — Aggregiert Markt-Sentiment aus externen Quellen
// ============================================================

import type { SentimentData } from '../types/index.js';

export class SentimentService {
  private cache: { data: SentimentData; expires: number } | null = null;
  private readonly cacheTtlMs = 5 * 60 * 1000; // 5 Minuten Cache

  async getSentiment(): Promise<SentimentData> {
    if (this.cache && Date.now() < this.cache.expires) {
      return this.cache.data;
    }

    const [fearGreed, fundingRates, oiData] = await Promise.allSettled([
      this.fetchFearGreed(),
      this.fetchFundingRates(),
      this.fetchOpenInterest(),
    ]);

    const fg = fearGreed.status === 'fulfilled' ? fearGreed.value : { value: 50, label: 'Neutral' };
    const funding = fundingRates.status === 'fulfilled' ? fundingRates.value : { btc: 0, eth: 0 };
    const oi = oiData.status === 'fulfilled' ? oiData.value : { change24h: 0, btcDominance: 50 };

    const data: SentimentData = {
      fear_greed_index: fg.value,
      fear_greed_label: fg.label,
      btc_funding_rate: funding.btc,
      eth_funding_rate: funding.eth,
      total_oi_change_24h_pct: oi.change24h,
      btc_dominance: oi.btcDominance,
    };

    this.cache = { data, expires: Date.now() + this.cacheTtlMs };
    return data;
  }

  // --- Fear & Greed Index (alternative.me) ---
  private async fetchFearGreed(): Promise<{ value: number; label: string }> {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Fear&Greed API ${res.status}`);
    const json = await res.json() as { data: Array<{ value: string; value_classification: string }> };
    const entry = json.data[0];
    return {
      value: entry ? parseInt(entry.value, 10) : 50,
      label: entry?.value_classification ?? 'Neutral',
    };
  }

  // --- Funding Rates (Binance Public API) ---
  private async fetchFundingRates(): Promise<{ btc: number; eth: number }> {
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1', {
        signal: AbortSignal.timeout(5000),
      }),
      fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=1', {
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    const btcData = btcRes.ok ? await btcRes.json() as Array<{ fundingRate: string }> : [];
    const ethData = ethRes.ok ? await ethRes.json() as Array<{ fundingRate: string }> : [];

    return {
      btc: btcData[0] ? parseFloat(btcData[0].fundingRate) * 100 : 0,
      eth: ethData[0] ? parseFloat(ethData[0].fundingRate) * 100 : 0,
    };
  }

  // --- Open Interest Aggregiert (CoinGlass Public) ---
  private async fetchOpenInterest(): Promise<{ change24h: number; btcDominance: number }> {
    // CoinGlass free endpoint — kann sich aendern
    try {
      const res = await fetch('https://open-api.coinglass.com/public/v2/open_interest?symbol=BTC', {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { change24h: 0, btcDominance: 50 };
      const json = await res.json() as { data?: { openInterest?: number; h24Change?: number } };
      return {
        change24h: json.data?.h24Change ?? 0,
        btcDominance: 50, // Vereinfacht
      };
    } catch {
      return { change24h: 0, btcDominance: 50 };
    }
  }
}
