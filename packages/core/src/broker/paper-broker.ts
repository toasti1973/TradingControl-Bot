import { randomUUID } from 'node:crypto';

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

  /**
   * Der Hebel, mit dem die Fuellung gebucht wird.
   *
   * An der Order und nicht nur in der Symbol-Map: Zwischen dem Legen
   * eines Limit-Einstiegs und seiner Fuellung liegen oft Stunden, und
   * ein Neustart dazwischen leert die Map. Siehe `OrderParams.leverage`.
   */
  leverage?: number;
  /** Was das Konto fuer diese Fuellung an Gebuehr berechnet hat. */
  fees?: number;
}

export class PaperBroker implements BrokerAdapter {
  readonly name = 'paper';
  private orders = new Map<string, InternalOrder>();
  // Keine eigene Positionsliste mehr — die fuehrt allein das Konto.
  //
  // Frueher stand hier eine zweite Map neben der des Kontos. Nur das
  // Konto wird gespeichert; nach einem Neustart war die Liste des
  // Brokers leer, waehrend das Konto seine Positionen sehr wohl kannte.
  // Jede Nur-Schliessen-Order lief dann ins Leere: Der erste
  // Take-Profit nach dem Hochfahren wurde abgewiesen, obwohl eine
  // Position offen war — und der Monitor hielt ihn trotzdem fuer
  // ausgefuehrt. Eine Tatsache gehoert in ein Buch.
  private leverages = new Map<string, number>();
  private prices = new Map<string, number>();
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

  /**
   * Nimmt liegende Orders aus einem frueheren Lauf wieder auf.
   *
   * Die Orders dieses Zugangs leben im Arbeitsspeicher — nach einem
   * Neustart ist die Liste leer. Eine Order, die in der Datenbank des
   * Bots als "liegt an der Boerse" steht, waere dann unbekannt:
   * `getOrder` liefert null, der Monitor erfaehrt nie von ihrer
   * Fuellung, und sie fuellt auch nie.
   *
   * Am 26.10. traf es BNBUSDT: Take-Profit 1 lag bei 743,86, der Kurs
   * stand bei 746,73 — zwei Mark darueber. Die Order haette fuellen
   * MUESSEN. Sie lag in der Datenbank, der Zugang kannte sie nicht.
   *
   * Eine echte Boerse verliert ihr Orderbuch nicht, wenn der Bot neu
   * startet. Dieser Zugang darf es auch nicht.
   */
  ordersWiederherstellen(liste: Array<{
    brokerOrderId: string;
    clientOrderId?: string | null;
    symbol: string;
    side: 'buy' | 'sell';
    type: OrderParams['type'];
    quantity: number;
    price?: number | null;
    stopPrice?: number | null;
    reduceOnly?: boolean;
    /**
     * Der Hebel des Plans, zu dem diese Order gehoert.
     *
     * Muss mitkommen: Ohne ihn wird die Fuellung einer vor dem
     * Neustart gelegten Order mit Hebel 1 gebucht. Siehe
     * `OrderParams.leverage`.
     */
    leverage?: number | null;
  }>): number {
    let aufgenommen = 0;

    for (const o of liste) {
      if (!o.brokerOrderId || this.orders.has(o.brokerOrderId)) continue;

      const hebel = Number(o.leverage) || 0;

      this.orders.set(o.brokerOrderId, {
        orderId: o.brokerOrderId,
        clientOrderId: o.clientOrderId ?? o.brokerOrderId,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        quantity: o.quantity,
        price: Number(o.price) || 0,
        stopPrice: o.stopPrice ?? undefined,
        status: 'new',
        filledQuantity: 0,
        avgFillPrice: 0,
        timestamp: Date.now(),
        reduceOnly: o.reduceOnly === true,
        leverage: hebel > 0 ? hebel : undefined,
      });

      // Auch die Map fuellen — sie bleibt die Auskunft fuer alles,
      // was ohne eigenen Hebel kommt (Notschliessungen etwa). Ein
      // leeres Gedaechtnis nach dem Neustart war der Kern des
      // Fehlers.
      if (hebel > 0) this.leverages.set(o.symbol, hebel);

      aufgenommen++;
    }

    return aufgenommen;
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

  /**
   * Mit welchem Hebel wird diese Order gebucht?
   *
   * Drei Quellen, in dieser Reihenfolge:
   *
   * 1. **Die Order selbst.** Der Plan kennt seinen Hebel und gibt ihn
   *    mit. Das ist die einzige Quelle, die einen Neustart ueberlebt.
   * 2. **Die Symbol-Map** aus `setLeverage()`. Richtig, solange der
   *    Bot seit dem Platzieren durchlief.
   * 3. **Eine bestehende Position** auf demselben Symbol. Beim
   *    Nachkauf oder Schliessen ist ihr Hebel der einzig sinnvolle —
   *    ein anderer ergaebe eine Position mit zwei Hebeln.
   *
   * Bleibt alles leer, ist 1 die Notannahme. Sie ist fast immer
   * falsch und wird deshalb gemeldet: Eine Position mit Hebel 1
   * bindet das Vielfache der richtigen Margin und laesst die freie
   * Margin auf 0 fallen — womit die Risikogrenze, die sich auf sie
   * stuetzt, stillschweigend ausfaellt.
   */
  private hebelFuer(params: OrderParams): number {
    const ausOrder = Number(params.leverage) || 0;
    if (ausOrder > 0) return ausOrder;

    const ausMap = this.leverages.get(params.symbol) ?? 0;
    if (ausMap > 0) return ausMap;

    // Beide Seiten ansehen: Im Hedge-Modus fuehrt das Konto je
    // Richtung eine eigene Position.
    const ausPosition = this.konto.position(params.symbol, params.side)?.hebel
      ?? this.konto.position(params.symbol, params.side === 'buy' ? 'sell' : 'buy')?.hebel
      ?? 0;
    if (ausPosition > 0) return ausPosition;

    console.warn(
      `[Uebungsbroker] Kein Hebel fuer ${params.symbol} bekannt — es wird mit 1 gebucht. ` +
      'Die gebundene Margin faellt dadurch um ein Vielfaches zu hoch aus.',
    );
    return 1;
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    // Eine Kennung, die sich nicht wiederholen kann.
    //
    // Frueher stand hier ein fortlaufender Zaehler. Der beginnt nach
    // jedem Neustart wieder bei 1 — waehrend in der Datenbank noch die
    // Kennungen des vorigen Laufs stehen. Eine Nachfrage nach
    // "paper-11" traf dann auf eine voellig andere Order.
    const orderId = `paper-${randomUUID()}`;
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
      // Der Hebel wird JETZT festgehalten, nicht erst beim Fuellen.
      // Dazwischen kann ein Neustart liegen (siehe OrderParams.leverage).
      leverage: this.hebelFuer(params),
    };

    // Nur-Schliessen-Orders ohne passende Position werden abgewiesen.
    //
    // Eine echte Boerse tut das auch. Ohne diese Pruefung eroeffnete ein
    // Take-Profit, der feuert, bevor ein Einstieg gefuellt wurde, eine
    // Position in der Gegenrichtung — aus einem geplanten Short wuerde
    // ein Long, den niemand wollte, und das Uebungskonto zeigte einen
    // Bestand, den es nie gab.
    if (order.reduceOnly) {
      const schliessbar = this.schliessbareMenge(params.symbol, params.side);

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

  // `_positionSide` nimmt der Uebungsbroker nur entgegen, damit er
  // dieselbe Schnittstelle hat. Er fuehrt die Order ueber ihre Kennung
  // und braucht die Richtung nicht — anders als eine echte Boerse im
  // Hedge-Modus.
  async cancelOrder(
    _symbol: string,
    orderId: string,
    _positionSide?: 'long' | 'short',
  ): Promise<void> {
    const order = this.orders.get(orderId);
    if (order && order.status === 'new') {
      order.status = 'cancelled';
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<OrderResult | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;

    // Das Symbol MUSS stimmen.
    //
    // Es wurde hier lange ignoriert, und das ging schief, sobald die
    // Kennungen sich wiederholten: Nach einem Neustart begann die
    // Nummerierung von vorn, waehrend in der Datenbank noch Kennungen
    // aus dem Lauf davor standen. Am 25.10. beantwortete dieser Zugang
    // deshalb die Frage nach einer BNBUSDT-Order mit einer HYPEUSDT-
    // Order: 122,14 Stueck zu 76,45 statt 1,67 zu 748,49. Der Bot
    // verbuchte einen Verlust von 80.768 USDT auf einem Konto mit
    // 10.000.
    //
    // Die Kennungen sind inzwischen eindeutig (randomUUID). Diese
    // Pruefung bleibt trotzdem: Eine Antwort ueber ein anderes Symbol
    // ist unter keinen Umstaenden richtig.
    if (this.toPhemexSymbol(order.symbol) !== this.toPhemexSymbol(symbol)) {
      return null;
    }

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
            const schliessbar = this.schliessbareMenge(order.symbol, order.side);

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

  async getPosition(symbol: string, side?: 'buy' | 'sell'): Promise<PositionInfo | null> {
    const pos = this.konto.position(symbol, side);
    if (!pos) return null;

    const currentPrice = (await this.getPrice(symbol)) ?? pos.einstiegspreis;
    const direction = pos.seite === 'buy' ? 1 : -1;
    const unrealizedPnl = (currentPrice - pos.einstiegspreis) * pos.menge * direction;

    return {
      symbol: pos.symbol,
      side: pos.seite,
      size: pos.menge,
      entryPrice: pos.einstiegspreis,
      unrealizedPnl,
      leverage: pos.hebel,
    };
  }

  /**
   * Wieviel laesst sich mit einer Order dieser Seite schliessen?
   *
   * Eine Kauf-Order schliesst einen Short, eine Verkaufs-Order einen
   * Long. Zeigt die offene Position in dieselbe Richtung wie die Order,
   * wuerde sie vergroessert statt verkleinert — dann gibt es nichts zu
   * schliessen.
   */
  private schliessbareMenge(symbol: string, seite: 'buy' | 'sell'): number {
    // Im Hedge-Modus gezielt die Gegenposition nachschlagen: Zu
    // demselben Symbol kann daneben eine gleichgerichtete offen sein,
    // die nichts mit dieser Order zu tun hat.
    const gegenrichtung: 'buy' | 'sell' = seite === 'buy' ? 'sell' : 'buy';
    const offen = this.konto.position(symbol, gegenrichtung);
    return offen ? offen.menge : 0;
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
   * Verbucht einen Fill auf dem Uebungskonto.
   *
   * Das Konto schreibt dabei die Position fort, bucht die Gebuehr und
   * — wenn der Fill eine Position verkleinert — das Ergebnis. Der
   * Broker fuehrt daneben kein eigenes Buch mehr.
   */
  private updatePosition(order: InternalOrder): void {
    const { gebuehr } = this.konto.ordnungAusgefuehrt({
      symbol: order.symbol,
      seite: order.side,
      menge: order.filledQuantity,
      preis: order.avgFillPrice,
      orderArt: order.type,
      // Der an der Order festgehaltene Hebel geht vor. Hier stand
      // frueher `this.leverages.get(order.symbol) ?? 1` — und genau
      // dieser Griff in eine nach jedem Neustart leere Map buchte am
      // 02.11.2026 zwei Positionen mit Hebel 1 statt 16 und 13.
      hebel: order.leverage ?? this.hebelFuer({
        symbol: order.symbol, side: order.side, type: order.type,
        quantity: order.quantity,
      }),
      // Im Hedge-Modus die entscheidende Angabe: Ein Kauf eroeffnet
      // einen Long ODER schliesst einen Short. Welches von beidem,
      // sagt allein reduceOnly.
      schliesst: order.reduceOnly,
    });

    // An der Order festhalten, nicht nur im Konto: Die Ergebnisrechnung
    // je Plan liest die Gebuehr aus den Orders.
    order.fees = gebuehr;
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
      fees: order.fees,
      feeCurrency: order.fees != null ? this.konto.waehrung : undefined,
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
