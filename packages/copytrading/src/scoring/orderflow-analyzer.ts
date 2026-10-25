// ============================================================
// OrderFlowAnalyzer — Order-Flow Analyse via Binance aggTrades
// Inspiriert von Flowsurface (https://github.com/flowsurface-rs/flowsurface)
//
// Berechnet pro Symbol:
//   - PoC (Point of Control): Preis mit hoechstem Volumen
//   - Naked PoC: Unfilled PoC aus vergangenen Bars (Magnetwirkung)
//   - Delta (Buy - Sell): Order-Flow-Druck
//   - Imbalance: Asymmetrie zwischen Buy/Sell auf benachbarten Levels
// ============================================================

interface AggTrade {
  price: number;
  qty: number;
  time: number;        // ms
  isBuyerMaker: boolean; // true = Sell aggressor
}

export interface PriceBin {
  price: number;
  buyQty: number;
  sellQty: number;
  totalQty: number;
  delta: number;       // buy - sell
}

export interface OrderFlowSnapshot {
  symbol: string;
  timestamp: number;
  range_low: number;
  range_high: number;
  poc: number;                  // Point of Control
  bins: PriceBin[];
  total_buy: number;
  total_sell: number;
  total_delta: number;          // Bullish/Bearish overall
  delta_pct: number;            // Delta als % des Volumens (-100..100)
  imbalance_zones: ImbalanceZone[];
  naked_pocs: NakedPoc[];       // Unfilled PoCs aus historischen Bars
}

export interface ImbalanceZone {
  price: number;
  side: 'buy' | 'sell';
  ratio: number;          // buy/sell oder sell/buy
  strength: 'weak' | 'medium' | 'strong';
}

export interface NakedPoc {
  price: number;
  bar_time: number;       // Wann der PoC entstand
  age_hours: number;
  volume: number;
}

export class OrderFlowAnalyzer {
  private cache = new Map<string, { snapshot: OrderFlowSnapshot; expires: number }>();
  private readonly cacheTtlMs = 5 * 60 * 1000;
  private readonly imbalanceThreshold = 200; // 200% = 3x

  // Naked-PoC Tracking pro Symbol
  private nakedPocsBySymbol = new Map<string, NakedPoc[]>();

  // ============================================================
  // Hauptfunktion: Order-Flow fuer Symbol holen
  // ============================================================
  async analyze(symbol: string, currentPrice: number): Promise<OrderFlowSnapshot | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() < cached.expires) {
      return cached.snapshot;
    }

    try {
      // Letzte Stunde aggTrades holen (Binance: max 1000 pro Call)
      const trades = await this.fetchAggTrades(symbol, 1000);
      if (trades.length < 50) return null;

      const tickSize = this.estimateTickSize(currentPrice);
      const bins = this.bucketize(trades, tickSize);
      const range = this.computeRange(bins);
      const poc = this.computePoC(bins);
      const totals = this.computeTotals(bins);
      const imbalances = this.detectImbalances(bins);
      const nakedPocs = this.updateNakedPocs(symbol, poc, currentPrice);

      const snapshot: OrderFlowSnapshot = {
        symbol,
        timestamp: Date.now(),
        range_low: range.low,
        range_high: range.high,
        poc,
        bins: bins.slice(0, 50),  // Top 50 Bins fuer Speicher
        total_buy: totals.buy,
        total_sell: totals.sell,
        total_delta: totals.buy - totals.sell,
        delta_pct: totals.total > 0 ? ((totals.buy - totals.sell) / totals.total) * 100 : 0,
        imbalance_zones: imbalances,
        naked_pocs: nakedPocs,
      };

      this.cache.set(symbol, { snapshot, expires: Date.now() + this.cacheTtlMs });
      return snapshot;
    } catch {
      return null;
    }
  }

  // ============================================================
  // Binance aggTrades fetch
  // ============================================================
  private async fetchAggTrades(symbol: string, limit: number): Promise<AggTrade[]> {
    const url = `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`aggTrades ${res.status}`);

    const raw = await res.json() as Array<{ p: string; q: string; T: number; m: boolean }>;
    return raw.map(t => ({
      price: parseFloat(t.p),
      qty: parseFloat(t.q),
      time: t.T,
      isBuyerMaker: t.m,
    }));
  }

  // ============================================================
  // Trade-Bucketing in PriceBins
  // ============================================================
  private bucketize(trades: AggTrade[], tickSize: number): PriceBin[] {
    const map = new Map<number, { buy: number; sell: number }>();

    for (const t of trades) {
      // Round-to-step (Flowsurface: round_to_step)
      const bucket = Math.round(t.price / tickSize) * tickSize;
      const key = Math.round(bucket * 1e8) / 1e8;
      const entry = map.get(key) ?? { buy: 0, sell: 0 };
      // isBuyerMaker = true: Verkaeufer war aggressor → Sell
      if (t.isBuyerMaker) {
        entry.sell += t.qty;
      } else {
        entry.buy += t.qty;
      }
      map.set(key, entry);
    }

    return Array.from(map.entries())
      .map(([price, qty]) => ({
        price,
        buyQty: qty.buy,
        sellQty: qty.sell,
        totalQty: qty.buy + qty.sell,
        delta: qty.buy - qty.sell,
      }))
      .sort((a, b) => b.totalQty - a.totalQty);
  }

  // ============================================================
  // Tick-Size Schaetzung (heuristisch)
  // ============================================================
  private estimateTickSize(price: number): number {
    if (price >= 10_000) return 1;
    if (price >= 1_000) return 0.1;
    if (price >= 100) return 0.01;
    if (price >= 10) return 0.001;
    if (price >= 1) return 0.0001;
    return 0.00001;
  }

  private computeRange(bins: PriceBin[]): { low: number; high: number } {
    let low = Infinity, high = -Infinity;
    for (const b of bins) {
      if (b.price < low) low = b.price;
      if (b.price > high) high = b.price;
    }
    return { low, high };
  }

  private computePoC(bins: PriceBin[]): number {
    if (bins.length === 0) return 0;
    return bins[0]!.price; // Bins sind nach totalQty sortiert
  }

  private computeTotals(bins: PriceBin[]): { buy: number; sell: number; total: number } {
    let buy = 0, sell = 0;
    for (const b of bins) {
      buy += b.buyQty;
      sell += b.sellQty;
    }
    return { buy, sell, total: buy + sell };
  }

  // ============================================================
  // Imbalance-Detection (Diagonal, Flowsurface-Stil)
  //   Bullish: BuyQty[P+1] > SellQty[P] * (100+threshold)/100
  //   Bearish: SellQty[P-1] > BuyQty[P] * (100+threshold)/100
  // ============================================================
  private detectImbalances(bins: PriceBin[]): ImbalanceZone[] {
    const zones: ImbalanceZone[] = [];
    const sorted = [...bins].sort((a, b) => a.price - b.price);
    const threshold = this.imbalanceThreshold;
    const factor = (100 + threshold) / 100;

    for (let i = 0; i < sorted.length - 1; i++) {
      const lower = sorted[i]!;
      const upper = sorted[i + 1]!;

      // Bullish: aggressive Buys oben gegenueber Sells unten
      if (lower.sellQty > 0 && upper.buyQty > lower.sellQty * factor) {
        const ratio = upper.buyQty / lower.sellQty;
        zones.push({
          price: upper.price,
          side: 'buy',
          ratio,
          strength: ratio > 5 ? 'strong' : ratio > 3.5 ? 'medium' : 'weak',
        });
      }

      // Bearish: aggressive Sells unten gegenueber Buys oben
      if (upper.buyQty > 0 && lower.sellQty > upper.buyQty * factor) {
        const ratio = lower.sellQty / upper.buyQty;
        zones.push({
          price: lower.price,
          side: 'sell',
          ratio,
          strength: ratio > 5 ? 'strong' : ratio > 3.5 ? 'medium' : 'weak',
        });
      }
    }

    return zones.slice(0, 20);
  }

  // ============================================================
  // Naked-PoC Tracking
  //   Ein PoC wird "naked" wenn der Preis ihn nie wieder beruehrt hat
  //   Naked PoCs wirken als Magnet (Markt zieht oft zurueck)
  // ============================================================
  private updateNakedPocs(symbol: string, currentPoc: number, currentPrice: number): NakedPoc[] {
    const existing = this.nakedPocsBySymbol.get(symbol) ?? [];
    const now = Date.now();

    // Bestehende NPoCs filtern: "filled" wenn Preis sie beruehrt hat
    const stillNaked = existing.filter(npoc => {
      // PoC als gefuellt markieren wenn currentPrice innerhalb 0.1% war
      // (vereinfacht — echte Implementierung wuerde Trade-Stream nutzen)
      const distance = Math.abs(currentPrice - npoc.price) / npoc.price;
      return distance > 0.001; // 0.1% — hat sich nicht beruehrt
    }).map(npoc => ({
      ...npoc,
      age_hours: (now - npoc.bar_time) / 3600_000,
    }));

    // Neuen PoC hinzufuegen wenn unterschiedlich von bestehenden
    const isDuplicate = stillNaked.some(n => Math.abs(n.price - currentPoc) / currentPoc < 0.002);
    if (!isDuplicate && currentPoc > 0) {
      stillNaked.push({
        price: currentPoc,
        bar_time: now,
        age_hours: 0,
        volume: 0,
      });
    }

    // Max 10 Naked PoCs pro Symbol, aelteste zuerst entfernen
    const sorted = stillNaked.sort((a, b) => b.bar_time - a.bar_time).slice(0, 10);
    this.nakedPocsBySymbol.set(symbol, sorted);
    return sorted;
  }

  // ============================================================
  // Hilfsfunktion: Naechster Naked-PoC in Richtung
  // ============================================================
  getNearestNakedPocAbove(symbol: string, price: number): NakedPoc | null {
    const npocs = this.nakedPocsBySymbol.get(symbol) ?? [];
    return npocs.filter(n => n.price > price).sort((a, b) => a.price - b.price)[0] ?? null;
  }

  getNearestNakedPocBelow(symbol: string, price: number): NakedPoc | null {
    const npocs = this.nakedPocsBySymbol.get(symbol) ?? [];
    return npocs.filter(n => n.price < price).sort((a, b) => b.price - a.price)[0] ?? null;
  }
}
