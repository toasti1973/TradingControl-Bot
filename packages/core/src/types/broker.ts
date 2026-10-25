export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market' | 'stop' | 'stop_limit';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'PostOnly';

export interface OrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  clientOrderId?: string;
  reduceOnly?: boolean;
}

export interface OrderResult {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  status: 'new' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';
  filledQuantity: number;
  avgFillPrice: number;
  timestamp: number;
}

export interface PositionInfo {
  symbol: string;
  side: OrderSide;
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

/** Kontostand je Waehrung, wie ihn die Boerse fuehrt. */
export interface BalanceInfo {
  total: Record<string, number>;
  free: Record<string, number>;
  used: Record<string, number>;
}

/** Grenzen der Boerse fuer einen Markt. Was sie nicht nennt, fehlt. */
export interface MarketInfo {
  symbol: string;
  minAmount?: number;
  minCost?: number;
  amountStep?: number;
  amountPrecision?: number;
}

export interface BrokerAdapter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getPrice(symbol: string): Promise<number | null>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOrder(symbol: string, orderId: string): Promise<OrderResult | null>;
  getPosition(symbol: string): Promise<PositionInfo | null>;

  /**
   * Kontostand. Optional, weil nicht jeder Zugang ihn fuehrt — der
   * Uebungsbroker etwa rechnet nur gegen Kurse.
   */
  getBalance?(): Promise<BalanceInfo>;

  /**
   * Grenzen eines Marktes: Mindestmenge, Mindestwert, Schrittweite.
   * Wird gebraucht, um umgerechnete Positionsgroessen so zu runden, dass
   * die Boerse sie annimmt.
   */
  getMarketInfo?(symbol: string): Promise<MarketInfo | null>;
}
