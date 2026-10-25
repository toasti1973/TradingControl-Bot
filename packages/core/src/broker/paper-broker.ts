import { BrokerAdapter, OrderParams, OrderResult, PositionInfo } from '../types/broker.js';
import { PaperAccount, PHEMEX_FUTURES_GEBUEHREN, type FeeModel } from './paper-account.js';

export interface PaperBrokerConfig {
  priceSource?: 'phemex' | 'static';
  staticPrices?: Record<string, number>;
  /**
   * Startkapital des Uebungskontos je Waehrung, z. B. { USDT: 10000 }.
   *
   * Gebraucht, sobald Handelssignale auf das Kapital umgerechnet werden:
   * Der CapitalService fragt den Broker nach dem Kontostand, und ohne
   * Antwort lehnt er jedes Signal ab — im Uebungsbetrieb waere das kein
   * Schutz, sondern nur ein Stillstand.
   */
  startkapital?: Record<string, number>;
  /** Gebuehrensaetze. Voreingestellt die von Phemex fuer Dauerkontrakte. */
  gebuehren?: FeeModel;
  /**
   * Ein bereits bestehendes Konto weiterfuehren.
   *
   * Wird von aussen gereicht, damit der Stand einen Neustart ueberlebt
   * und mehrere Zugriffe dasselbe Konto sehen.
   */
  konto?: PaperAccount;
}

interface InternalOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: OrderParams['type'];
  quantity: number;
  price: number;
  stopPrice?: number;
  status: OrderResult['status'];
  filledQuantity: number;
  avgFillPrice: number;
  timestamp: number;
  /**
   * Darf diese Order nur schliessen, nie eroeffnen?
   *
   * Take-Profits und Stops tragen das. Ohne diese Angabe wuerde ein
   * Take-Profit, der feuert, bevor ein Einstieg gefuellt ist, eine
   * Position in der Gegenrichtung eroeffnen — aus einem Short wuerde
   * ein Long, den niemand wollte.
   */
  reduceOnly: boolean;
}

interface InternalPosition {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  entryPrice: number;
  leverage: number;
}

export class PaperBroker implements BrokerAdapter {
  readonly name = 'paper';
  private orders = new Map<string, InternalOrder>();
  private positions = new Map<string, InternalPosition>();
  private leverages = new Map<string, number>();
  private prices = new Map<string, number>();
  private orderCounter = 0;
  private readonly priceSource: 'phemex' | 'static';
  /** Das Uebungskonto. Fuehrt Kapital, Ergebnis und Gebuehren. */
  readonly konto: PaperAccount;

  constructor(config: PaperBrokerConfig = {}) {
    this.priceSource = config.priceSource ?? 'phemex';

    if (config.konto) {
      this.konto = config.konto;
    } else {
      // Ohne ausdrueckliche Waehrung die erste genannte nehmen; das
      // Uebungskonto fuehrt nur eine.
      const [waehrung, betrag] = Object.entries(config.startkapital ?? {})[0] ?? ['USDT', 0];
      this.konto = new PaperAccount(betrag, waehrung, config.gebuehren ?? PHEMEX_FUTURES_GEBUEHREN);
    }

    if (config.staticPrices) {
      for (const [symbol, price] of Object.entries(config.staticPrices)) {
        this.prices.set(symbol, price);
      }
    }
  }

  /**
   * Kontostand des Uebungskontos.
   *
   * Der Wert wandert mit: Startkapital plus realisierte Ergebnisse
   * minus Gebuehren. Genau darauf rechnet der Bot die Groesse des
   * naechsten Signals um — ein Konto, das nach einer Verlustserie noch
   * dasselbe behauptete, liesse ihn unveraendert weiterhandeln.
   *
   * Ist kein Kapital hinterlegt, wird nichts behauptet. Der
   * CapitalService lehnt dann ab, statt auf einer erfundenen Zahl zu
   * rechnen.
   */
  async getBalance(): Promise<{
    total: Record<string, number>;
    free: Record<string, number>;
    used: Record<string, number>;
  }> {
    const stand = this.konto.stand();
    if (stand.startkapital <= 0 && stand.trades === 0) {
      return { total: {}, free: {}, used: {} };
    }

    return {
      total: { [stand.waehrung]: stand.equity },
      free: { [stand.waehrung]: stand.frei },
      used: { [stand.waehrung]: stand.gebunden },
    };
  }

  async connect(): Promise<void> {
    // Paper broker is always connected
  }

  async disconnect(): Promise<void> {
    // No-op for paper broker
  }

  async getPrice(symbol: string): Promise<number | null> {
    if (this.priceSource === 'static') {
      return this.prices.get(symbol) ?? null;
    }

    try {
      const phemexSymbol = this.toPhemexSymbol(symbol);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://api.phemex.com/md/v2/ticker/24hr?symbol=${encodeURIComponent(phemexSymbol)}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!res.ok) return this.prices.get(symbol) ?? null;

      // Phemex antwortet in zwei Fassungen, je nach Endpunkt und
      // Zeitpunkt: frueher { code, data }, heute { error, result }.
      // Beide werden gelesen — sonst liefert der Uebungsbroker
      // stillschweigend gar keinen Kurs mehr, und kein Plan kaeme je
      // ueber die Preispruefung hinaus.
      const antwort = await res.json() as {
        code?: number;
        error?: unknown;
        data?: { markPriceRp?: string; lastRp?: string; closeRp?: string };
        result?: { markPriceRp?: string; lastRp?: string; closeRp?: string };
      };

      if (antwort.code != null && antwort.code !== 0) return this.prices.get(symbol) ?? null;
      if (antwort.error != null) return this.prices.get(symbol) ?? null;

      const kurse = antwort.result ?? antwort.data;
      // markPriceRp fuehrt; closeRp und lastRp sind die Rueckfallebenen
      // fuer Maerkte, die keinen Mark-Preis fuehren (Kasse).
      const roh = kurse?.markPriceRp ?? kurse?.closeRp ?? kurse?.lastRp;
      if (roh == null) return this.prices.get(symbol) ?? null;

      const price = parseFloat(roh);
      if (!Number.isFinite(price) || price <= 0) return this.prices.get(symbol) ?? null;

      this.prices.set(symbol, price);
      return price;
    } catch {
      return this.prices.get(symbol) ?? null;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.leverages.set(symbol, leverage);
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const orderId = `paper-${++this.orderCounter}`;
    const clientOrderId = params.clientOrderId ?? orderId;
    const price = params.price ?? (await this.getPrice(params.symbol)) ?? 0;

    const order: InternalOrder = {
      orderId,
      clientOrderId,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
      price,
      stopPrice: params.stopPrice,
      status: 'new',
      filledQuantity: 0,
      avgFillPrice: 0,
      timestamp: Date.now(),
      reduceOnly: params.reduceOnly === true,
    };

    // Nur-Schliessen-Orders ohne passende Position werden abgewiesen.
    //
    // Eine echte Boerse tut das auch. Ohne diese Pruefung eroeffnete ein
    // Take-Profit, der feuert, bevor ein Einstieg gefuellt wurde, eine
    // Position in der Gegenrichtung — aus einem geplanten Short wuerde
    // ein Long, den niemand wollte, und das Uebungskonto zeigte einen
    // Bestand, den es nie gab.
    if (order.reduceOnly) {
      const offen = this.positions.get(params.symbol);
      const gegenrichtung = params.side === 'buy' ? 'sell' : 'buy';
      const schliessbar = (offen && offen.side === gegenrichtung) ? offen.size : 0;

      if (schliessbar <= 0) {
        order.status = 'rejected';
        this.orders.set(orderId, order);
        return this.toOrderResult(order);
      }

      // Nie mehr schliessen, als offen ist.
      if (params.quantity > schliessbar) {
        order.quantity = schliessbar;
      }
    }

    // Market-Orders sofort füllen
    if (params.type === 'market') {
      const currentPrice = (await this.getPrice(params.symbol)) ?? price;
      order.status = 'filled';
      order.filledQuantity = order.quantity;
      order.avgFillPrice = currentPrice;
      this.updatePosition(order);
    }

    this.orders.set(orderId, order);
    return this.toOrderResult(order);
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (order && order.status === 'new') {
      order.status = 'cancelled';
    }
  }

  async getOrder(_symbol: string, orderId: string): Promise<OrderResult | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;

    if (order.status === 'new') {
      const currentPrice = await this.getPrice(order.symbol);
      if (currentPrice !== null) {
        let shouldFill = false;

        if (order.type === 'limit') {
          // Limit-Orders: Buy wenn Preis <= Limit, Sell wenn Preis >= Limit
          shouldFill =
            (order.side === 'buy' && currentPrice <= order.price) ||
            (order.side === 'sell' && currentPrice >= order.price);
        } else if ((order.type === 'stop' || order.type === 'stop_limit') && order.stopPrice) {
          // Stop-Orders: Buy-Stop wenn Preis >= Stop, Sell-Stop wenn Preis <= Stop
          shouldFill =
            (order.side === 'buy' && currentPrice >= order.stopPrice) ||
            (order.side === 'sell' && currentPrice <= order.stopPrice);
        }

        if (shouldFill) {
          // Auch hier gilt der Riegel: Was nur schliessen darf, braucht
          // eine Position zum Schliessen. Sie kann zwischen dem
          // Platzieren und dem Fuellen verschwunden sein.
          if (order.reduceOnly) {
            const offen = this.positions.get(order.symbol);
            const gegenrichtung = order.side === 'buy' ? 'sell' : 'buy';
            const schliessbar = (offen && offen.side === gegenrichtung) ? offen.size : 0;

            if (schliessbar <= 0) {
              order.status = 'rejected';
              return this.toOrderResult(order);
            }
            if (order.quantity > schliessbar) order.quantity = schliessbar;
          }

          order.status = 'filled';
          order.filledQuantity = order.quantity;
          order.avgFillPrice = order.stopPrice ?? order.price;
          this.updatePosition(order);
        }
      }
    }

    return this.toOrderResult(order);
  }

  async getPosition(symbol: string): Promise<PositionInfo | null> {
    const pos = this.positions.get(symbol);
    if (!pos || pos.size === 0) return null;

    const currentPrice = (await this.getPrice(symbol)) ?? pos.entryPrice;
    const direction = pos.side === 'buy' ? 1 : -1;
    const unrealizedPnl = (currentPrice - pos.entryPrice) * pos.size * direction;

    return {
      symbol: pos.symbol,
      side: pos.side,
      size: pos.size,
      entryPrice: pos.entryPrice,
      unrealizedPnl,
      leverage: pos.leverage,
    };
  }

  /** Simuliert Fill-Checks für alle offenen Orders */
  async checkFills(): Promise<OrderResult[]> {
    const filled: OrderResult[] = [];
    for (const order of this.orders.values()) {
      if (order.status !== 'new') continue;
      const result = await this.getOrder(order.symbol, order.orderId);
      if (result && result.status === 'filled') {
        filled.push(result);
      }
    }
    return filled;
  }

  /** Setzt einen statischen Preis (für Tests) */
  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  /**
   * Verbucht einen Fill auf dem Uebungskonto und schreibt die Position
   * fort.
   *
   * Beides gehoert zusammen: Die Gebuehr faellt auf jeden Fill an, das
   * Ergebnis nur, wenn der Fill eine Position verkleinert. Welcher Fall
   * vorliegt, weiss das Konto selbst.
   */
  private updatePosition(order: InternalOrder): void {
    this.konto.ordnungAusgefuehrt({
      symbol: order.symbol,
      seite: order.side,
      menge: order.filledQuantity,
      preis: order.avgFillPrice,
      orderArt: order.type,
      hebel: this.leverages.get(order.symbol) ?? 1,
    });

    this.positionFortschreiben(order);
  }

  private positionFortschreiben(order: InternalOrder): void {
    const existing = this.positions.get(order.symbol);
    const leverage = this.leverages.get(order.symbol) ?? 1;

    if (!existing || existing.size === 0) {
      this.positions.set(order.symbol, {
        symbol: order.symbol,
        side: order.side,
        size: order.filledQuantity,
        entryPrice: order.avgFillPrice,
        leverage,
      });
      return;
    }

    // Gleiche Richtung: Position vergrößern
    if (existing.side === order.side) {
      const totalSize = existing.size + order.filledQuantity;
      const avgPrice =
        (existing.entryPrice * existing.size + order.avgFillPrice * order.filledQuantity) / totalSize;
      existing.size = totalSize;
      existing.entryPrice = avgPrice;
    } else {
      // Gegenrichtung: Position verkleinern/schließen
      if (order.filledQuantity >= existing.size) {
        const remaining = order.filledQuantity - existing.size;
        if (remaining > 0) {
          existing.side = order.side;
          existing.size = remaining;
          existing.entryPrice = order.avgFillPrice;
        } else {
          existing.size = 0;
        }
      } else {
        existing.size -= order.filledQuantity;
      }
    }
  }

  private toOrderResult(order: InternalOrder): OrderResult {
    return {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
      status: order.status,
      filledQuantity: order.filledQuantity,
      avgFillPrice: order.avgFillPrice,
      timestamp: order.timestamp,
    };
  }

  /**
   * Symbol fuer die Kursabfrage bei Phemex.
   *
   * Die Dauerkontrakte heissen dort schlicht BTCUSDT, ETHUSDT. Ein
   * frueher hier angehaengtes "s" (fuer die Kasse) quittiert die
   * Schnittstelle mit "invalid argument" — der Uebungsbroker bekam
   * dadurch nie einen Kurs.
   *
   * Bereinigt werden nur die Schreibweisen, die anderswo im Bot
   * vorkommen: BTC/USDT und BTCUSDT.P.
   */
  private toPhemexSymbol(symbol: string): string {
    return symbol
      .toUpperCase()
      .replace(/\.P$/, '')
      .replace(/:.*$/, '')
      .replace(/[/\-_]/g, '');
  }
}
