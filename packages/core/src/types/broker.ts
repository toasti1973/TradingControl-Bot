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

  /**
   * Welche der beiden Positionen ist gemeint?
   *
   * Nur im Hedge-Modus von Belang — dort fuehrt die Boerse zu einem
   * Symbol einen Long UND einen Short. Die Orderseite genuegt dann
   * nicht: Ein Verkauf kann einen Long schliessen ODER einen Short
   * eroeffnen. Ohne diese Angabe landet die Order im falschen Topf
   * oder wird abgewiesen.
   *
   * Jede Boerse nennt das Feld anders — Phemex `posSide`, Bybit
   * `positionIdx`, Binance `positionSide`. Der Broker uebersetzt.
   */
  positionSide?: 'long' | 'short';

  /**
   * Der Hebel, mit dem diese Order gebucht werden soll.
   *
   * ## Warum er an die Order gehoert
   *
   * Eine echte Boerse fuehrt den Hebel je Symbol und merkt ihn sich —
   * `setLeverage()` genuegt dort. Der Uebungsbroker hielt ihn in einer
   * Map im Arbeitsspeicher, und genau daran ging er verloren:
   *
   * Seit die Einstiege als Limit-Orders im Orderbuch liegen (Regel
   * 3aa), vergehen zwischen `setLeverage()` beim Platzieren und der
   * Fuellung oft Stunden oder Tage. Faellt dazwischen ein Neustart,
   * ist die Map leer — und die Fuellung wird mit Hebel 1 gebucht.
   *
   * Am 02.11.2026 standen so 10.606 USDT als gebunden in einem Konto
   * mit 8.310 USDT Stand. Zwei Positionen trugen Hebel 1 statt 16
   * und 13 und banden allein 7.937 USDT. Die Folge war schwerer als
   * eine falsche Anzeige: Die freie Margin fiel auf 0, und damit fiel
   * die Risikogrenze, die sich auf sie stuetzt, bei jedem Signal
   * stillschweigend aus.
   *
   * An der Order reist er mit — auch durch einen Neustart, denn die
   * liegenden Orders werden wiederhergestellt.
   *
   * Boersen-Broker ignorieren das Feld; dort bleibt `setLeverage()`
   * massgeblich.
   */
  leverage?: number;
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

  /**
   * Angefallene Gebuehr, soweit der Zugang sie nennt.
   *
   * Ohne sie sieht jeder Trade besser aus, als er war: Die
   * Ergebnisrechnung je Plan zieht diese Spalte ab, und sie blieb
   * bisher leer, waehrend das Uebungskonto die Gebuehr sehr wohl
   * buchte. Beim Beurteilen eines Signalgebers ist das keine
   * Kleinigkeit — bei engen Zielen entscheidet die Gebuehr darueber,
   * ob ein Trade im Plus endete.
   */
  fees?: number;
  feeCurrency?: string;
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
  /**
   * Eine Order zuruecknehmen.
   *
   * `positionSide` nennt die Richtung der Position, zu der die Order
   * gehoert — im Hedge-Modus unverzichtbar. ccxt setzt bei Phemex
   * sonst `posSide: "Merged"`, die One-Way-Form, und die Boerse weist
   * den Aufruf ab: Der Bot kann seine eigene Order nicht mehr
   * loswerden.
   */
  cancelOrder(symbol: string, orderId: string, positionSide?: 'long' | 'short'): Promise<void>;
  getOrder(symbol: string, orderId: string): Promise<OrderResult | null>;
  /**
   * Die offene Position zu einem Symbol.
   *
   * `side` waehlt im Hedge-Modus zwischen Long und Short — dort sind
   * das zwei Positionen, nicht eine. Ohne Angabe wird die erste
   * gefundene geliefert, was im Netting-Modus die einzige ist.
   */
  getPosition(symbol: string, side?: OrderSide): Promise<PositionInfo | null>;

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
