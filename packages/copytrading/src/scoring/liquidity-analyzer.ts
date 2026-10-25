// ============================================================
// LiquidityAnalyzer — Order-Book Liquidity-Wand Detection
// Inspiriert von Flowsurface Heatmap-Konzept
//
// Ziel: SL-Platzierung optimieren um Stop-Hunts zu vermeiden
//   - Identifiziert grosse Bid/Ask-Walls im Order-Book
//   - Schlaegt SL VOR der Wand vor (statt dahinter wo Stop-Hunts passieren)
// ============================================================

interface DepthLevel {
  price: number;
  qty: number;
}

export interface LiquidityWall {
  price: number;
  qty: number;
  side: 'bid' | 'ask';
  strength_pct: number;        // % des Top-N Volumens
  distance_pct: number;        // Distanz zum aktuellen Preis in %
}

export interface LiquiditySnapshot {
  symbol: string;
  timestamp: number;
  current_price: number;
  bid_walls: LiquidityWall[];   // Support
  ask_walls: LiquidityWall[];   // Resistance
  total_bid_qty: number;
  total_ask_qty: number;
  bid_ask_imbalance_pct: number; // (bid-ask)/(bid+ask) * 100
}

export class LiquidityAnalyzer {
  private cache = new Map<string, { snapshot: LiquiditySnapshot; expires: number }>();
  private readonly cacheTtlMs = 60 * 1000; // 1 Min — Order-Book aendert sich schnell

  // Ein Level gilt als "Wall" wenn es >X% des Top-N Volumens hat
  private readonly wallThresholdPct = 5; // 5% des Top-50-Volumens

  async analyze(symbol: string, currentPrice: number): Promise<LiquiditySnapshot | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() < cached.expires) {
      return cached.snapshot;
    }

    try {
      const depth = await this.fetchDepth(symbol, 100);
      if (depth.bids.length < 10 || depth.asks.length < 10) return null;

      const bidTotal = depth.bids.reduce((s, l) => s + l.qty, 0);
      const askTotal = depth.asks.reduce((s, l) => s + l.qty, 0);
      const total = bidTotal + askTotal;

      const bidWalls = this.detectWalls(depth.bids, 'bid', currentPrice, bidTotal);
      const askWalls = this.detectWalls(depth.asks, 'ask', currentPrice, askTotal);

      const snapshot: LiquiditySnapshot = {
        symbol,
        timestamp: Date.now(),
        current_price: currentPrice,
        bid_walls: bidWalls,
        ask_walls: askWalls,
        total_bid_qty: bidTotal,
        total_ask_qty: askTotal,
        bid_ask_imbalance_pct: total > 0 ? ((bidTotal - askTotal) / total) * 100 : 0,
      };

      this.cache.set(symbol, { snapshot, expires: Date.now() + this.cacheTtlMs });
      return snapshot;
    } catch {
      return null;
    }
  }

  // ============================================================
  // SL-Platzierung optimieren — vor naechster Wall in SL-Richtung
  // ============================================================
  optimizeStopLoss(
    snapshot: LiquiditySnapshot,
    direction: 'long' | 'short',
    proposedSl: number,
    currentPrice: number,
  ): { adjustedSl: number; reason: string } {
    const buffer = 0.001; // 0.1% Puffer

    if (direction === 'long') {
      // Long: SL ist UNTERHALB currentPrice. Suche Bid-Wall zwischen proposedSl und currentPrice.
      // Wenn vorhanden: SL knapp UEBER der Wall (Wall haelt das Niveau).
      const wallsBelow = snapshot.bid_walls
        .filter(w => w.price < currentPrice && w.price >= proposedSl)
        .sort((a, b) => b.price - a.price); // naechste an currentPrice

      if (wallsBelow.length > 0) {
        const nearestWall = wallsBelow[0]!;
        const adjusted = nearestWall.price * (1 + buffer);
        return {
          adjustedSl: Math.round(adjusted * 100) / 100,
          reason: `SL ueber Bid-Wall bei $${nearestWall.price} (${nearestWall.strength_pct.toFixed(1)}% Volumen)`,
        };
      }
    } else {
      // Short: SL ist OBERHALB currentPrice. Suche Ask-Wall zwischen currentPrice und proposedSl.
      const wallsAbove = snapshot.ask_walls
        .filter(w => w.price > currentPrice && w.price <= proposedSl)
        .sort((a, b) => a.price - b.price);

      if (wallsAbove.length > 0) {
        const nearestWall = wallsAbove[0]!;
        const adjusted = nearestWall.price * (1 - buffer);
        return {
          adjustedSl: Math.round(adjusted * 100) / 100,
          reason: `SL unter Ask-Wall bei $${nearestWall.price} (${nearestWall.strength_pct.toFixed(1)}% Volumen)`,
        };
      }
    }

    return { adjustedSl: proposedSl, reason: 'Keine Wall in SL-Richtung gefunden' };
  }

  // ============================================================
  // Risk-Faktor: Verhaeltnis Bid/Ask-Liquiditaet (Sentiment)
  // ============================================================
  getLiquiditySentiment(snapshot: LiquiditySnapshot): 'bullish' | 'bearish' | 'neutral' {
    const imb = snapshot.bid_ask_imbalance_pct;
    if (imb > 15) return 'bullish';
    if (imb < -15) return 'bearish';
    return 'neutral';
  }

  // ============================================================
  // Binance Order-Book Depth fetch
  // ============================================================
  private async fetchDepth(symbol: string, limit: number): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }> {
    const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`depth ${res.status}`);

    const raw = await res.json() as { bids: [string, string][]; asks: [string, string][] };
    return {
      bids: raw.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: raw.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
  }

  // ============================================================
  // Wall-Detection: Levels die ueberproportional viel Volumen halten
  // ============================================================
  private detectWalls(
    levels: DepthLevel[],
    side: 'bid' | 'ask',
    currentPrice: number,
    totalQty: number,
  ): LiquidityWall[] {
    if (totalQty === 0) return [];

    const walls: LiquidityWall[] = [];
    for (const level of levels) {
      const strengthPct = (level.qty / totalQty) * 100;
      if (strengthPct >= this.wallThresholdPct) {
        const distancePct = Math.abs(currentPrice - level.price) / currentPrice * 100;
        walls.push({
          price: level.price,
          qty: level.qty,
          side,
          strength_pct: Math.round(strengthPct * 10) / 10,
          distance_pct: Math.round(distancePct * 100) / 100,
        });
      }
    }

    // Top 5 Walls
    return walls.sort((a, b) => b.strength_pct - a.strength_pct).slice(0, 5);
  }
}
