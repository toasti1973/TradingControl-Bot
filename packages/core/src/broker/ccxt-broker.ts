// ============================================================
// CcxtBroker — Handel ueber jede Boerse aus dem Verzeichnis
//
// Loest den fruheren PhemexBroker ab, der bereits ueber ccxt lief und sich
// nur in der fest verdrahteten Boerse unterschied. Die Eigenheiten je
// Boerse stehen jetzt im Verzeichnis (exchange-registry.ts) statt im Code.
// ============================================================

import ccxt from 'ccxt';
import type { Exchange, Order, Position, Market } from 'ccxt';
import type { BrokerAdapter, MarketInfo, OrderParams, OrderResult, PositionInfo } from '../types/broker.js';
import { getExchange, type ExchangeDefinition } from './exchange-registry.js';

export type BrokerMarketType = 'spot' | 'futures';

export interface CcxtBrokerConfig {
  /** Schluessel aus dem Boersen-Verzeichnis, z. B. 'kraken' oder 'okx'. */
  exchange: string;
  apiKey: string;
  apiSecret: string;
  /** Bei manchen Boersen zusaetzlich noetig (OKX, KuCoin, Crypto.com). */
  password?: string;
  testnet?: boolean;
  marketType?: BrokerMarketType;   // Default: 'futures'
  timeout?: number;
}

export class CcxtBroker implements BrokerAdapter {
  readonly name: string;
  /** Die Definition aus dem Verzeichnis — enthaelt auch den MiCA-Vermerk. */
  readonly definition: ExchangeDefinition;

  private readonly exchange: Exchange;
  private readonly marketType: BrokerMarketType;
  private marketsLoaded = false;

  constructor(config: CcxtBrokerConfig) {
    const def = getExchange(config.exchange);
    if (!def) {
      throw new UnbekannteBoerseError(config.exchange);
    }
    this.definition = def;
    this.marketType = config.marketType ?? (def.supportsFutures ? 'futures' : 'spot');

    if (this.marketType === 'futures' && !def.supportsFutures) {
      throw new BrokerKonfigurationsError(`${def.label} bietet keine Termingeschaefte.`);
    }
    if (this.marketType === 'spot' && !def.supportsSpot) {
      throw new BrokerKonfigurationsError(`${def.label} bietet keinen Kassahandel.`);
    }
    if (config.testnet && !def.supportsSandbox) {
      throw new BrokerKonfigurationsError(`${def.label} hat keine Testumgebung.`);
    }

    const env = config.testnet ? ' (testnet)' : '';
    this.name = `${def.id}-${this.marketType}${env}`;

    const ExchangeClass = ccxt[def.ccxtId as keyof typeof ccxt] as typeof ccxt.Exchange | undefined;
    if (typeof ExchangeClass !== 'function') {
      throw new UnbekannteBoerseError(def.ccxtId);
    }

    // Die Optionen aus dem Verzeichnis kommen zuerst, danach die
    // Marktart — sie ist die konkretere Angabe und soll gewinnen.
    const { options: defOptions, ...defRest } = (def.ccxtOptions ?? {}) as Record<string, unknown>;

    this.exchange = new ExchangeClass({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      ...(config.password ? { password: config.password } : {}),
      enableRateLimit: true,
      timeout: config.timeout ?? 10_000,
      ...defRest,
      options: {
        ...(defOptions as Record<string, unknown> ?? {}),
        defaultType: this.marketType === 'futures' ? 'swap' : 'spot',
      },
    });

    if (config.testnet) {
      this.exchange.setSandboxMode(true);
    }
  }

  /** Ist diese Boerse im EWR zugelassen? */
  get istMicaZugelassen(): boolean {
    return this.definition.mica === 'zugelassen';
  }

  // ============================================================
  // Lebenszyklus
  // ============================================================

  async connect(): Promise<void> {
    await this.ensureMarkets();
  }

  async disconnect(): Promise<void> {
    if (typeof this.exchange.close === 'function') {
      await this.exchange.close();
    }
  }

  // ============================================================
  // Markt-Daten
  // ============================================================

  async getPrice(symbol: string): Promise<number | null> {
    try {
      await this.ensureMarkets();
      const ticker = await this.exchange.fetchTicker(this.toCcxtSymbol(symbol));
      return ticker.last ?? ticker.close ?? ticker.bid ?? null;
    } catch {
      return null;
    }
  }

  async getOrderbook(symbol: string, limit = 20): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
    try {
      await this.ensureMarkets();
      const ob = await this.exchange.fetchOrderBook(this.toCcxtSymbol(symbol), limit);
      return {
        bids: ob.bids as [number, number][],
        asks: ob.asks as [number, number][],
      };
    } catch {
      return null;
    }
  }

  async getCandles(
    symbol: string,
    timeframe: string = '1h',
    limit: number = 100,
  ): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    await this.ensureMarkets();
    const ohlcv = await this.exchange.fetchOHLCV(this.toCcxtSymbol(symbol), timeframe, undefined, limit);
    return ohlcv.map(c => ({
      time: c[0] as number,
      open: c[1] as number,
      high: c[2] as number,
      low: c[3] as number,
      close: c[4] as number,
      volume: c[5] as number,
    }));
  }

  // ============================================================
  // Handel
  // ============================================================

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this.marketType !== 'futures') return; // Kassahandel kennt keinen Hebel

    await this.ensureMarkets();
    await this.exchange.setLeverage(leverage, this.toCcxtSymbol(symbol));
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    await this.ensureMarkets();

    const ccxtSymbol = this.toCcxtSymbol(params.symbol);
    const ccxtType = this.mapOrderTypeToCcxt(params.type);
    const ccxtSide = params.side; // 'buy' | 'sell' — kompatibel

    const extraParams: Record<string, unknown> = {};

    if (params.stopPrice !== undefined) {
      extraParams['stopPrice'] = params.stopPrice;
    }
    if (params.clientOrderId) {
      extraParams['clientOrderId'] = params.clientOrderId;
    }
    if (params.timeInForce) {
      extraParams['timeInForce'] = params.timeInForce;
    }
    if (params.reduceOnly && this.marketType === 'futures') {
      extraParams['reduceOnly'] = true;
    }

    const order = await this.exchange.createOrder(
      ccxtSymbol,
      ccxtType,
      ccxtSide,
      params.quantity,
      params.price,
      extraParams,
    );

    return this.toOrderResult(order, params.symbol);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.ensureMarkets();
    await this.exchange.cancelOrder(orderId, this.toCcxtSymbol(symbol));
  }

  async cancelAllOrders(symbol?: string): Promise<void> {
    await this.ensureMarkets();
    if (symbol) {
      await this.exchange.cancelAllOrders(this.toCcxtSymbol(symbol));
    } else {
      await this.exchange.cancelAllOrders();
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<OrderResult | null> {
    try {
      await this.ensureMarkets();
      const order = await this.exchange.fetchOrder(orderId, this.toCcxtSymbol(symbol));
      return this.toOrderResult(order, symbol);
    } catch {
      return null;
    }
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    await this.ensureMarkets();
    const ccxtSymbol = symbol ? this.toCcxtSymbol(symbol) : undefined;
    const orders = await this.exchange.fetchOpenOrders(ccxtSymbol);
    return orders.map(o => this.toOrderResult(o, this.fromCcxtSymbol(o.symbol)));
  }

  async getOrderHistory(symbol?: string, limit = 100): Promise<OrderResult[]> {
    await this.ensureMarkets();
    const ccxtSymbol = symbol ? this.toCcxtSymbol(symbol) : undefined;
    const orders = await this.exchange.fetchClosedOrders(ccxtSymbol, undefined, limit);
    return orders.map(o => this.toOrderResult(o, this.fromCcxtSymbol(o.symbol)));
  }

  // ============================================================
  // Konto & Positionen
  // ============================================================

  async getBalance(): Promise<{ total: Record<string, number>; free: Record<string, number>; used: Record<string, number> }> {
    await this.ensureMarkets();
    const balance = await this.exchange.fetchBalance() as unknown as {
      total?: Record<string, number>;
      free?: Record<string, number>;
      used?: Record<string, number>;
    };
    return {
      total: balance.total ?? {},
      free: balance.free ?? {},
      used: balance.used ?? {},
    };
  }

  /**
   * Grenzen eines Marktes: Mindestmenge, Mindestwert, Schrittweite.
   *
   * Gebraucht, sobald eine Positionsgroesse umgerechnet wird — eine
   * Order unter der Mindestgroesse weist die Boerse zurueck, und das
   * erfaehrt der Bot sonst erst beim Absenden.
   */
  async getMarketInfo(symbol: string): Promise<MarketInfo | null> {
    try {
      await this.ensureMarkets();
      const markt = this.exchange.markets?.[this.toCcxtSymbol(symbol)] as Market | undefined;
      if (!markt) return null;

      const grenzen = markt.limits as {
        amount?: { min?: number };
        cost?: { min?: number };
      } | undefined;
      const genauigkeit = markt.precision as { amount?: number } | undefined;

      // ccxt nennt die Mengen-Genauigkeit je nach Boerse entweder als
      // Anzahl Nachkommastellen (4) oder als Schrittweite (0.0001).
      const rohGenauigkeit = genauigkeit?.amount;
      const istSchrittweite = rohGenauigkeit != null && rohGenauigkeit > 0 && rohGenauigkeit < 1;

      return {
        symbol,
        minAmount: grenzen?.amount?.min,
        minCost: grenzen?.cost?.min,
        amountStep: istSchrittweite ? rohGenauigkeit : undefined,
        amountPrecision: !istSchrittweite && rohGenauigkeit != null ? rohGenauigkeit : undefined,
      };
    } catch {
      return null;
    }
  }

  async getPosition(symbol: string): Promise<PositionInfo | null> {
    if (this.marketType !== 'futures') return null;

    try {
      await this.ensureMarkets();
      const positions = await this.exchange.fetchPositions([this.toCcxtSymbol(symbol)]);
      const pos = positions.find(p => Math.abs(p.contracts ?? 0) > 0);
      if (!pos) return null;

      return this.toPositionInfo(pos, symbol);
    } catch {
      return null;
    }
  }

  async getAllPositions(): Promise<PositionInfo[]> {
    if (this.marketType !== 'futures') return [];

    await this.ensureMarkets();
    const positions = await this.exchange.fetchPositions();
    return positions
      .filter(p => Math.abs(p.contracts ?? 0) > 0)
      .map(p => this.toPositionInfo(p, this.fromCcxtSymbol(p.symbol)));
  }

  async closePosition(symbol: string): Promise<OrderResult | null> {
    const pos = await this.getPosition(symbol);
    if (!pos) return null;

    const closeSide: 'buy' | 'sell' = pos.side === 'buy' ? 'sell' : 'buy';
    return this.placeOrder({
      symbol,
      side: closeSide,
      type: 'market',
      quantity: pos.size,
      reduceOnly: true,
    });
  }

  // ============================================================
  // Intern
  // ============================================================

  private async ensureMarkets(): Promise<void> {
    if (this.marketsLoaded) return;

    try {
      await this.exchange.loadMarkets();
      this.marketsLoaded = true;
      return;
    } catch (err) {
      // Boersen mit getrennten Einheiten je Rechtsraum lehnen einen
      // Schluessel der anderen Domain ab. Statt aufzugeben, die im
      // Verzeichnis hinterlegten Ausweich-Domains durchprobieren.
      const alternates = this.definition.alternateHostnames ?? [];
      for (const hostname of alternates) {
        try {
          (this.exchange as unknown as { hostname: string }).hostname = hostname;
          if (typeof (this.exchange as unknown as { urls?: unknown }).urls === 'object') {
            // ccxt liest den Hostnamen beim Aufbau der URLs — nach der
            // Aenderung muessen die Maerkte neu geladen werden.
          }
          await this.exchange.loadMarkets(true);
          this.marketsLoaded = true;
          return;
        } catch {
          continue;
        }
      }
      throw err;
    }
  }

  /** BTCUSDT -> BTC/USDT:USDT (Termin) oder BTC/USDT (Kasse) */
  private toCcxtSymbol(symbol: string): string {
    // Wenn schon im ccxt-Format (enthaelt '/'): direkt nutzen
    if (symbol.includes('/')) return symbol;

    const markets = this.exchange.markets;
    if (markets) {
      for (const m of Object.values(markets) as Array<Market | undefined>) {
        if (!m) continue;
        if (m.id === symbol || m.symbol === symbol) return m.symbol;
      }

      for (const quote of QUOTE_CURRENCIES) {
        if (symbol.endsWith(quote)) {
          const base = symbol.slice(0, -quote.length);
          const spot = `${base}/${quote}`;
          const swap = `${base}/${quote}:${quote}`;
          const target = this.marketType === 'futures' ? swap : spot;
          if (markets[target]) return target;
          if (markets[spot]) return spot;
        }
      }
    }

    // Rueckfallebene, wenn die Maerkte noch nicht geladen sind
    for (const quote of QUOTE_CURRENCIES) {
      if (symbol.endsWith(quote)) {
        const base = symbol.slice(0, -quote.length);
        return this.marketType === 'futures' ? `${base}/${quote}:${quote}` : `${base}/${quote}`;
      }
    }
    return symbol;
  }

  /** BTC/USDT:USDT -> BTCUSDT */
  private fromCcxtSymbol(ccxtSymbol: string): string {
    const mainPart = ccxtSymbol.split(':')[0] ?? ccxtSymbol;
    return mainPart.replace('/', '');
  }

  private mapOrderTypeToCcxt(type: OrderParams['type']): string {
    switch (type) {
      case 'limit': return 'limit';
      case 'market': return 'market';
      case 'stop': return 'stop';
      case 'stop_limit': return 'stop_limit';
    }
  }

  private mapOrderStatus(status: string | undefined): OrderResult['status'] {
    switch (status) {
      case 'open': return 'new';
      case 'closed': return 'filled';
      case 'canceled':
      case 'cancelled':
        return 'cancelled';
      case 'expired':
      case 'rejected':
        return 'rejected';
      default:
        return 'new';
    }
  }

  private toOrderResult(order: Order, symbol: string): OrderResult {
    const filled = order.filled ?? 0;
    const amount = order.amount ?? 0;
    let status = this.mapOrderStatus(order.status);
    if (status === 'new' && filled > 0 && filled < amount) {
      status = 'partially_filled';
    }

    return {
      orderId: order.id,
      clientOrderId: order.clientOrderId ?? '',
      symbol,
      side: (order.side as 'buy' | 'sell') ?? 'buy',
      type: (order.type as OrderParams['type']) ?? 'limit',
      quantity: amount,
      price: order.price ?? 0,
      status,
      filledQuantity: filled,
      avgFillPrice: order.average ?? 0,
      timestamp: order.timestamp ?? Date.now(),
    };
  }

  private toPositionInfo(pos: Position, symbol: string): PositionInfo {
    return {
      symbol,
      side: (pos.side as 'buy' | 'sell') ?? (((pos.contracts ?? 0) > 0) ? 'buy' : 'sell'),
      size: Math.abs(pos.contracts ?? 0),
      entryPrice: pos.entryPrice ?? 0,
      unrealizedPnl: pos.unrealizedPnl ?? 0,
      leverage: pos.leverage ?? 1,
    };
  }
}

const QUOTE_CURRENCIES = ['USDT', 'USDC', 'BUSD', 'EUR', 'USD'];

export class UnbekannteBoerseError extends Error {
  constructor(id: string) {
    super(`Boerse "${id}" ist dem Bot nicht bekannt.`);
    this.name = 'UnbekannteBoerseError';
  }
}

export class BrokerKonfigurationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerKonfigurationsError';
  }
}
