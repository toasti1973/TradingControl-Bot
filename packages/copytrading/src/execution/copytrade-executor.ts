// ============================================================
// CopyTradeExecutor — Platziert Orders + SL/TP auf Broker
// Verwaltet offene CopyTrade-Positionen und reagiert auf Wallet-Aenderungen
// Funktioniert mit Paper-Broker UND Phemex identisch
// ============================================================

import { EventEmitter } from 'events';
import type { BrokerAdapter } from '@tradingcontrol/core';
import type { WalletSignal, CombinedScore, ConvictionResult, CopyTradingConfig } from '../types/index.js';
import type { OrderFlowSnapshot } from '../scoring/orderflow-analyzer.js';
import type { LiquiditySnapshot } from '../scoring/liquidity-analyzer.js';
import { LiquidityAnalyzer } from '../scoring/liquidity-analyzer.js';

export interface CopyTradePosition {
  id: string;
  signal_id: string;
  wallet_address: string;
  symbol: string;
  direction: 'long' | 'short';
  entry_price: number;
  size: number;                // Asset-Menge
  leverage: number;
  margin_usd: number;         // Eingesetzte Margin
  status: 'opening' | 'open' | 'closing' | 'closed';

  // Orders auf der Boerse
  entry_order_id: string;
  sl_order_id: string | null;
  tp_order_ids: string[];

  // Risk-Parameter
  sl_price: number;
  tp_prices: number[];
  trailing_active: boolean;
  trailing_stop_price: number | null;

  // Ergebnis
  exit_price: number | null;
  realized_pnl: number;
  exit_reason: string | null;

  // Zeitstempel
  opened_at: string;
  closed_at: string | null;
}

export class CopyTradeExecutor extends EventEmitter {
  private positions = new Map<string, CopyTradePosition>();
  private fillCheckTimer: ReturnType<typeof setInterval> | null = null;
  private liquidityAnalyzer: LiquidityAnalyzer;

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly config: CopyTradingConfig,
  ) {
    super();
    this.liquidityAnalyzer = new LiquidityAnalyzer();
  }

  // ============================================================
  // Trade eroeffnen
  // ============================================================

  async openTrade(
    signal: WalletSignal,
    decision: CombinedScore,
    conviction: ConvictionResult,
    orderFlow?: OrderFlowSnapshot | null,
    liquidity?: LiquiditySnapshot | null,
  ): Promise<CopyTradePosition | null> {
    const symbol = signal.symbol;
    const direction = signal.direction;
    const side = direction === 'long' ? 'buy' as const : 'sell' as const;

    // Position Sizing: % des Portfolios
    const marginUsd = this.config.portfolio_size_usd * (decision.size_pct / 100);
    const leverage = Math.min(decision.max_leverage, this.config.max_portfolio_leverage);

    // Aktuellen Preis holen
    const currentPrice = await this.broker.getPrice(symbol);
    if (!currentPrice) {
      this.emit('error', { symbol, error: 'Kein Preis verfuegbar' });
      return null;
    }

    // Asset-Menge berechnen
    const positionValueUsd = marginUsd * leverage;
    const size = positionValueUsd / currentPrice;

    // Max-Exposure pruefen
    const existingExposure = this.getExposureForSymbol(symbol);
    const maxExposure = this.config.portfolio_size_usd * (this.config.max_exposure_per_asset_pct / 100);
    if (existingExposure + marginUsd > maxExposure) {
      this.emit('rejected', { symbol, reason: `Max-Exposure ${this.config.max_exposure_per_asset_pct}% erreicht` });
      return null;
    }

    // Max gleichzeitige Positionen
    const openCount = Array.from(this.positions.values()).filter(p => p.status === 'open').length;
    if (openCount >= this.config.max_concurrent_positions) {
      this.emit('rejected', { symbol, reason: `Max ${this.config.max_concurrent_positions} gleichzeitige Positionen` });
      return null;
    }

    // SL berechnen: ATR-basiert ODER struktureller SL am PoC (naehere Wahl)
    const slPct = conviction.stop_loss_pct || (this.config.default_sl_atr_multiplier * 2);
    let slPrice = direction === 'long'
      ? currentPrice * (1 - slPct / 100)
      : currentPrice * (1 + slPct / 100);

    // Phase B: Struktureller SL am PoC wenn vorhanden und naeher
    if (orderFlow && orderFlow.poc > 0) {
      const poc = orderFlow.poc;
      // Long: SL knapp unter PoC (PoC = Support)
      if (direction === 'long' && poc < currentPrice && poc > slPrice) {
        slPrice = poc * 0.998; // 0.2% Puffer
      }
      // Short: SL knapp ueber PoC (PoC = Resistance)
      else if (direction === 'short' && poc > currentPrice && poc < slPrice) {
        slPrice = poc * 1.002;
      }
    }

    // Phase C: Liquidity-Wand-Optimierung (lazy fetch wenn nicht uebergeben)
    let liquiditySnapshot = liquidity;
    if (!liquiditySnapshot) {
      liquiditySnapshot = await this.liquidityAnalyzer.analyze(symbol, currentPrice);
    }
    if (liquiditySnapshot) {
      const optimized = this.liquidityAnalyzer.optimizeStopLoss(
        liquiditySnapshot, direction, slPrice, currentPrice
      );
      if (optimized.adjustedSl !== slPrice) {
        slPrice = optimized.adjustedSl;
        this.emit('sl_optimized', { symbol, oldSl: slPrice, newSl: optimized.adjustedSl, reason: optimized.reason });
      }
    }

    // TP berechnen: Conviction-Levels ODER Naked PoCs in Profit-Richtung
    let tpPrices: number[];
    if (conviction.take_profit_levels.length > 0) {
      tpPrices = conviction.take_profit_levels;
    } else if (orderFlow && orderFlow.naked_pocs.length > 0) {
      // Phase B: Naked PoCs in Profit-Richtung als TPs (Magnetwirkung)
      const profitDirection = direction === 'long'
        ? orderFlow.naked_pocs.filter(n => n.price > currentPrice).sort((a, b) => a.price - b.price)
        : orderFlow.naked_pocs.filter(n => n.price < currentPrice).sort((a, b) => b.price - a.price);

      if (profitDirection.length > 0) {
        // Bis zu 2 NPoCs als TP-Levels
        tpPrices = profitDirection.slice(0, 2).map(n => Math.round(n.price * 100) / 100);
      } else {
        // Fallback: Min R:R basiert
        const riskPerUnit = Math.abs(currentPrice - slPrice);
        const tp1 = direction === 'long'
          ? currentPrice + riskPerUnit * this.config.min_risk_reward
          : currentPrice - riskPerUnit * this.config.min_risk_reward;
        tpPrices = [Math.round(tp1 * 100) / 100];
      }
    } else {
      const riskPerUnit = Math.abs(currentPrice - slPrice);
      const tp1 = direction === 'long'
        ? currentPrice + riskPerUnit * this.config.min_risk_reward
        : currentPrice - riskPerUnit * this.config.min_risk_reward;
      tpPrices = [Math.round(tp1 * 100) / 100];
    }

    const posId = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // 1. Leverage setzen
      await this.broker.setLeverage(symbol, leverage);

      // 2. Entry-Order (Market)
      const entryResult = await this.broker.placeOrder({
        symbol,
        side,
        type: 'market',
        quantity: Math.round(size * 1e8) / 1e8,
      });

      if (entryResult.status !== 'filled') {
        this.emit('error', { symbol, error: `Entry-Order nicht gefuellt: ${entryResult.status}` });
        return null;
      }

      // 3. Stop-Loss auf Boerse setzen
      const slSide = direction === 'long' ? 'sell' as const : 'buy' as const;
      const slResult = await this.broker.placeOrder({
        symbol,
        side: slSide,
        type: 'stop',
        quantity: entryResult.filledQuantity,
        stopPrice: Math.round(slPrice * 100) / 100,
        reduceOnly: true,
      });

      // 4. Take-Profit(s) auf Boerse setzen
      const tpOrderIds: string[] = [];
      const tpQuantityPerLevel = entryResult.filledQuantity / tpPrices.length;

      for (const tp of tpPrices) {
        const tpResult = await this.broker.placeOrder({
          symbol,
          side: slSide,
          type: 'limit',
          quantity: Math.round(tpQuantityPerLevel * 1e8) / 1e8,
          price: Math.round(tp * 100) / 100,
          reduceOnly: true,
        });
        tpOrderIds.push(tpResult.orderId);
      }

      // Position speichern
      const position: CopyTradePosition = {
        id: posId,
        signal_id: signal.id,
        wallet_address: signal.wallet_address,
        symbol,
        direction,
        entry_price: entryResult.avgFillPrice,
        size: entryResult.filledQuantity,
        leverage,
        margin_usd: marginUsd,
        status: 'open',
        entry_order_id: entryResult.orderId,
        sl_order_id: slResult.orderId,
        tp_order_ids: tpOrderIds,
        sl_price: Math.round(slPrice * 100) / 100,
        tp_prices: tpPrices,
        trailing_active: false,
        trailing_stop_price: null,
        realized_pnl: 0,
        exit_price: null,
        exit_reason: null,
        opened_at: new Date().toISOString(),
        closed_at: null,
      };

      this.positions.set(posId, position);
      this.emit('opened', position);

      // Fill-Check starten wenn noch nicht laufend
      this.startFillChecker();

      return position;

    } catch (err) {
      this.emit('error', { symbol, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ============================================================
  // Auf Wallet-Aenderungen reagieren
  // ============================================================

  async onWalletClose(walletAddress: string, symbol: string): Promise<void> {
    const positions = this.getPositionsForWallet(walletAddress, symbol);
    for (const pos of positions) {
      if (pos.status !== 'open') continue;
      await this.closePosition(pos.id, 'wallet_closed');
    }
  }

  async onWalletReduce(walletAddress: string, symbol: string, reducePct: number): Promise<void> {
    const positions = this.getPositionsForWallet(walletAddress, symbol);
    for (const pos of positions) {
      if (pos.status !== 'open') continue;
      const reduceSize = pos.size * (reducePct / 100);
      if (reduceSize <= 0) continue;

      const side = pos.direction === 'long' ? 'sell' as const : 'buy' as const;
      await this.broker.placeOrder({
        symbol: pos.symbol,
        side,
        type: 'market',
        quantity: Math.round(reduceSize * 1e8) / 1e8,
        reduceOnly: true,
      });

      pos.size -= reduceSize;
      this.emit('reduced', { id: pos.id, reducePct, newSize: pos.size });
    }
  }

  async onWalletLeverageChange(walletAddress: string, symbol: string, _newLeverage: number): Promise<void> {
    // Leverage-Erhoehung der Wallet → SL enger setzen statt Leverage kopieren
    const positions = this.getPositionsForWallet(walletAddress, symbol);
    for (const pos of positions) {
      if (pos.status !== 'open') continue;

      // SL um 20% enger setzen
      const currentPrice = await this.broker.getPrice(pos.symbol) ?? pos.entry_price;
      const currentRisk = Math.abs(currentPrice - pos.sl_price);
      const newSlDistance = currentRisk * 0.8;
      const newSlPrice = pos.direction === 'long'
        ? currentPrice - newSlDistance
        : currentPrice + newSlDistance;

      await this.updateStopLoss(pos.id, Math.round(newSlPrice * 100) / 100);
    }
  }

  // ============================================================
  // Position schliessen
  // ============================================================

  async closePosition(posId: string, reason: string): Promise<void> {
    const pos = this.positions.get(posId);
    if (!pos || pos.status !== 'open') return;

    pos.status = 'closing';

    try {
      // Offene SL/TP Orders canceln
      if (pos.sl_order_id) {
        await this.broker.cancelOrder(pos.symbol, pos.sl_order_id).catch(() => {});
      }
      for (const tpId of pos.tp_order_ids) {
        await this.broker.cancelOrder(pos.symbol, tpId).catch(() => {});
      }

      // Market-Close
      const side = pos.direction === 'long' ? 'sell' as const : 'buy' as const;
      const closeResult = await this.broker.placeOrder({
        symbol: pos.symbol,
        side,
        type: 'market',
        quantity: pos.size,
        reduceOnly: true,
      });

      pos.exit_price = closeResult.avgFillPrice;
      const direction = pos.direction === 'long' ? 1 : -1;
      // Hinzuzaehlen: Was bereits per Take-Profit realisiert wurde,
      // steht schon in `realized_pnl`, und `pos.size` ist nur noch
      // der Rest.
      pos.realized_pnl += (closeResult.avgFillPrice - pos.entry_price) * pos.size * direction;
      pos.status = 'closed';
      pos.exit_reason = reason;
      pos.closed_at = new Date().toISOString();

      this.emit('closed', pos);
    } catch (err) {
      pos.status = 'open'; // Rollback
      this.emit('error', { id: posId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ============================================================
  // Stop-Loss aktualisieren
  // ============================================================

  async updateStopLoss(posId: string, newSlPrice: number): Promise<void> {
    const pos = this.positions.get(posId);
    if (!pos || pos.status !== 'open') return;

    // Alte SL-Order canceln
    if (pos.sl_order_id) {
      await this.broker.cancelOrder(pos.symbol, pos.sl_order_id).catch(() => {});
    }

    // Neue SL-Order setzen
    const slSide = pos.direction === 'long' ? 'sell' as const : 'buy' as const;
    const slResult = await this.broker.placeOrder({
      symbol: pos.symbol,
      side: slSide,
      type: 'stop',
      quantity: pos.size,
      stopPrice: newSlPrice,
      reduceOnly: true,
    });

    pos.sl_order_id = slResult.orderId;
    pos.sl_price = newSlPrice;

    this.emit('sl_updated', { id: posId, newSlPrice });
  }

  // ============================================================
  // Fill-Checker: SL/TP Orders pruefen (fuer Paper-Broker + Boerse)
  // ============================================================

  private startFillChecker(): void {
    if (this.fillCheckTimer) return;

    this.fillCheckTimer = setInterval(() => {
      void this.checkAllFills();
    }, 3000); // Alle 3s
  }

  private async checkAllFills(): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.status !== 'open') continue;

      try {
        // SL gefuellt?
        if (pos.sl_order_id) {
          const slOrder = await this.broker.getOrder(pos.symbol, pos.sl_order_id);
          if (slOrder?.status === 'filled') {
            // TP Orders canceln
            for (const tpId of pos.tp_order_ids) {
              await this.broker.cancelOrder(pos.symbol, tpId).catch(() => {});
            }
            pos.exit_price = slOrder.avgFillPrice;
            const dir = pos.direction === 'long' ? 1 : -1;
            // Hinzuzaehlen, NICHT ueberschreiben.
            //
            // `pos.size` ist zu diesem Zeitpunkt nur noch der Rest:
            // Jeder gefuellte Take-Profit hat ihn verkleinert und
            // seinen Gewinn bereits aufaddiert (siehe unten, `+=`).
            // Mit `=` loeschte der Stop genau diesen Gewinn wieder —
            // ein Trade, der TP1 mitnahm und dann gestoppt wurde,
            // erschiene als reiner Verlust.
            pos.realized_pnl += (slOrder.avgFillPrice - pos.entry_price) * pos.size * dir;
            pos.status = 'closed';
            pos.exit_reason = 'stop_loss';
            pos.closed_at = new Date().toISOString();
            pos.sl_order_id = null;
            this.emit('closed', pos);
            continue;
          }
        }

        // TP Orders gefuellt?
        for (let i = 0; i < pos.tp_order_ids.length; i++) {
          const tpId = pos.tp_order_ids[i]!;
          const tpOrder = await this.broker.getOrder(pos.symbol, tpId);
          if (tpOrder?.status === 'filled') {
            pos.tp_order_ids.splice(i, 1);
            i--;

            // Teilschliessung
            const filledSize = tpOrder.filledQuantity;
            pos.size -= filledSize;
            const dir = pos.direction === 'long' ? 1 : -1;
            pos.realized_pnl += (tpOrder.avgFillPrice - pos.entry_price) * filledSize * dir;

            this.emit('tp_hit', {
              id: pos.id,
              level: i + 1,
              price: tpOrder.avgFillPrice,
              remaining_size: pos.size,
            });

            // Position komplett geschlossen?
            if (pos.size <= 0 || pos.tp_order_ids.length === 0) {
              if (pos.sl_order_id) {
                await this.broker.cancelOrder(pos.symbol, pos.sl_order_id).catch(() => {});
              }
              pos.status = 'closed';
              pos.exit_price = tpOrder.avgFillPrice;
              pos.exit_reason = 'take_profit';
              pos.closed_at = new Date().toISOString();
              this.emit('closed', pos);
            } else {
              // SL auf Break-Even nachziehen nach erstem TP
              await this.updateStopLoss(pos.id, pos.entry_price);
            }
          }
        }

        // Trailing-Stop pruefen
        if (pos.status === 'open') {
          await this.checkTrailingStop(pos);
        }

        // Max Hold Time pruefen
        if (pos.status === 'open') {
          const holdMs = Date.now() - new Date(pos.opened_at).getTime();
          if (holdMs > this.config.max_hold_hours * 3600_000) {
            await this.closePosition(pos.id, 'max_hold_time');
          }
        }

      } catch (err) {
        this.emit('error', { id: pos.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Timer stoppen wenn keine offenen Positionen
    const hasOpen = Array.from(this.positions.values()).some(p => p.status === 'open');
    if (!hasOpen && this.fillCheckTimer) {
      clearInterval(this.fillCheckTimer);
      this.fillCheckTimer = null;
    }
  }

  // ============================================================
  // Trailing Stop
  // ============================================================

  private async checkTrailingStop(pos: CopyTradePosition): Promise<void> {
    const currentPrice = await this.broker.getPrice(pos.symbol);
    if (!currentPrice) return;

    const direction = pos.direction === 'long' ? 1 : -1;
    const pnlPct = ((currentPrice - pos.entry_price) / pos.entry_price) * direction * 100;
    const riskPct = Math.abs(pos.entry_price - pos.sl_price) / pos.entry_price * 100;
    const rMultiple = riskPct > 0 ? pnlPct / riskPct : 0;

    // Trailing aktivieren ab +2R
    if (!pos.trailing_active && rMultiple >= this.config.trailing_stop_activation_r) {
      pos.trailing_active = true;
      const trailPct = riskPct * 0.5; // Trail mit 50% des initialen Risikos
      const trailPrice = pos.direction === 'long'
        ? currentPrice * (1 - trailPct / 100)
        : currentPrice * (1 + trailPct / 100);
      pos.trailing_stop_price = Math.round(trailPrice * 100) / 100;

      await this.updateStopLoss(pos.id, pos.trailing_stop_price);
      this.emit('trailing_activated', { id: pos.id, price: pos.trailing_stop_price });
    }

    // Trailing nachziehen
    if (pos.trailing_active && pos.trailing_stop_price) {
      const trailPct = Math.abs(pos.entry_price - pos.sl_price) / pos.entry_price * 50;
      const newTrail = pos.direction === 'long'
        ? currentPrice * (1 - trailPct / 100)
        : currentPrice * (1 + trailPct / 100);

      const shouldUpdate = pos.direction === 'long'
        ? newTrail > pos.trailing_stop_price
        : newTrail < pos.trailing_stop_price;

      if (shouldUpdate) {
        pos.trailing_stop_price = Math.round(newTrail * 100) / 100;
        await this.updateStopLoss(pos.id, pos.trailing_stop_price);
      }
    }
  }

  // ============================================================
  // Hilfsfunktionen
  // ============================================================

  getOpenPositions(): CopyTradePosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  getAllPositions(): CopyTradePosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): CopyTradePosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'closed');
  }

  getPositionBySignal(signalId: string): CopyTradePosition | undefined {
    return Array.from(this.positions.values()).find(p => p.signal_id === signalId);
  }

  private getPositionsForWallet(walletAddress: string, symbol: string): CopyTradePosition[] {
    return Array.from(this.positions.values()).filter(
      p => p.wallet_address === walletAddress && p.symbol === symbol && p.status === 'open'
    );
  }

  private getExposureForSymbol(symbol: string): number {
    return Array.from(this.positions.values())
      .filter(p => p.symbol === symbol && p.status === 'open')
      .reduce((sum, p) => sum + p.margin_usd, 0);
  }

  getTotalPnl(): number {
    return Array.from(this.positions.values())
      .filter(p => p.status === 'closed')
      .reduce((sum, p) => sum + p.realized_pnl, 0);
  }

  getTotalMarginInUse(): number {
    return Array.from(this.positions.values())
      .filter(p => p.status === 'open')
      .reduce((sum, p) => sum + p.margin_usd, 0);
  }

  shutdown(): void {
    if (this.fillCheckTimer) {
      clearInterval(this.fillCheckTimer);
      this.fillCheckTimer = null;
    }
  }
}
