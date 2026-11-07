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
import { KursStrom, type KursSpanne, type StromFaehigeBoerse } from './kurs-strom.js';

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

  /**
   * Der laufende Kurs ueber WebSocket.
   *
   * `null` bei einer Boerse, die keinen Strom kann — dann traegt REST
   * allein, wie bisher.
   */
  private readonly strom: KursStrom | null;

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

    // **Die `pro`-Klasse zuerst.** Sie erbt von der gewoehnlichen und
    // kann alles, was die kann — zusaetzlich WebSockets. Damit tragen
    // REST und Strom auf **einer** Verbindung mit **einem** Satz
    // Zugangsdaten; zwei Instanzen waeren zwei Sitzungen an der Boerse,
    // zwei Rate-Limit-Zaehler und zwei Stellen, an denen ein Schluessel
    // haengt.
    const ProClass = (ccxt.pro as Record<string, unknown> | undefined)?.[def.ccxtId];
    const BasisClass = ccxt[def.ccxtId as keyof typeof ccxt];
    const ExchangeClass = (typeof ProClass === 'function' ? ProClass : BasisClass) as
      typeof ccxt.Exchange | undefined;
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

    const stromFaehig = this.exchange as unknown as StromFaehigeBoerse;
    const strom = new KursStrom(stromFaehig, this.name, (stufe, text, daten) => {
      // Ohne eigenen Protokollanten hier: Der Strom ist eine
      // Nebenbahn, und ein Abriss ist kein Fehler des Handels — REST
      // traegt weiter. Gemeldet wird er trotzdem, sonst faellt er
      // still aus.
      if (stufe === 'warn') console.warn(`[Kursstrom] ${text}`, daten ?? '');
      else console.info(`[Kursstrom] ${text}`);
    });
    this.strom = strom.moeglich ? strom : null;
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
    // Erst den Strom, dann die Verbindung: `stoppe()` setzt die
    // Schleifen still, damit sie nicht in einen Abriss laufen und ihn
    // als Stoerung melden.
    if (this.strom) await this.strom.stoppe();

    if (typeof this.exchange.close === 'function') {
      await this.exchange.close();
    }
  }

  // ============================================================
  // Markt-Daten
  // ============================================================

  /**
   * Der aktuelle Kurs — aus dem Strom, wenn er frisch ist, sonst per
   * REST.
   *
   * Der Aufrufer merkt den Unterschied nicht; genau deshalb musste fuer
   * den Strom keine Zeile im Monitor geaendert werden. Das Abonnement
   * entsteht bei der ersten Abfrage von selbst: Welche Symbole
   * gebraucht werden, weiss nur der Plan — und der kann sich mit jedem
   * Signal aendern.
   */
  async getPrice(symbol: string): Promise<number | null> {
    const ccxtSymbol = this.toCcxtSymbol(symbol);

    if (this.strom) {
      this.strom.abonniere(ccxtSymbol);
      const stand = this.strom.letzterKurs(ccxtSymbol);
      if (stand) return stand.preis;
    }

    try {
      await this.ensureMarkets();
      const ticker = await this.exchange.fetchTicker(ccxtSymbol);
      return ticker.last ?? ticker.close ?? ticker.bid ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Hoch und Tief seit der letzten Abfrage — fuer den Trailing-Stop.
   *
   * `null`, wenn kein Strom laeuft. Dann muss der Aufrufer mit dem
   * Punktwert aus `getPrice()` auskommen, so wie bisher.
   */
  kursSpanne(symbol: string): KursSpanne | null {
    if (!this.strom) return null;
    return this.strom.spanneSeitAbfrage(this.toCcxtSymbol(symbol));
  }

  /** Was der Strom gerade beobachtet — fuer die Anzeige. */
  stromUebersicht(): { symbol: string; preis: number; alterMs: number; aktiv: boolean }[] {
    return this.strom?.uebersicht() ?? [];
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

  // ============================================================
  // Positionsmodus
  //
  // Eine Boerse fuehrt Positionen entweder je Symbol (One-Way, auch
  // Netting) oder je Symbol UND Richtung (Hedge). Welcher Modus gilt,
  // entscheidet, welche Felder an jede Order und an `setLeverage`
  // muessen — und die falsche Form wird abgewiesen, nicht ignoriert.
  //
  // Am 05.11.2026 schickte der Bot Phemex die One-Way-Form, obwohl das
  // Konto im Hedge-Modus stand. Die Folge war dreifach:
  //
  //   - `setLeverage` scheiterte → es galt Phemex' Voreinstellung 20x
  //     statt der geplanten 4x
  //   - `cancelOrder` scheiterte → der Bot konnte seine eigenen Orders
  //     nicht mehr zuruecknehmen
  //   - zwei Einstiege lagen unbeaufsichtigt an der Boerse
  //
  // Der Modus wird deshalb **gefragt, nicht angenommen** — und wenn
  // die Boerse keine Auskunft gibt, aus ihren Fehlern gelernt.
  // ============================================================

  /**
   * Der Positionsmodus je Symbol — leer, solange keiner feststeht.
   *
   * Je Symbol, weil Phemex ihn so fuehrt: Ein Konto kann BTCUSDT im
   * Hedge-Modus und ETHUSDT im One-Way-Modus halten.
   */
  private readonly posModus = new Map<string, 'hedge' | 'oneway'>();
  /** Welche Symbole schon erfragt wurden — auch die ohne Auskunft. */
  private readonly posModusGefragt = new Set<string>();

  /**
   * Den Positionsmodus feststellen — **je Symbol**.
   *
   * Phemex stellt ihn pro Symbol ein
   * (`PUT /g-positions/switch-pos-mode-sync?symbol=…`), also wird er
   * auch pro Symbol gefuehrt. Ein Konto kann BTCUSDT im Hedge-Modus
   * und ETHUSDT im One-Way-Modus halten; ein gemeinsamer Merker waere
   * fuer das eine richtig und fuer das andere falsch.
   *
   * Zwei Wege, in dieser Reihenfolge:
   *
   *   1. `fetchPositionMode` — der vorgesehene Weg, aber bei Phemex
   *      nicht implementiert: Die ccxt-Basisklasse wirft dort
   *      `NotSupported`.
   *   2. `fetchPositions` — der tragende Weg. ccxt liest `posMode` aus
   *      der Antwort und setzt daraus `hedged`
   *      (`parsePosition`: `'hedged': safeString(position, 'posMode') === 'Hedged'`).
   *      Der Endpunkt ist `GET /g-accounts/accountPositions` und
   *      antwortet auch fuer Symbole ohne offene Position.
   *
   * Schweigen beide, bleibt der Modus offen und wird beim ersten
   * Modusfehler gelernt (`mitModus`). Die Annahme bis dahin ist
   * One-Way, weil ccxt das auch tut.
   *
   * **Warum der Vorabruf lohnt:** Ohne ihn geht die erste Order jeder
   * Sitzung bei einem Hedge-Konto mit `posSide: "Merged"` hinaus, wird
   * abgewiesen und erst der zweite Versuch traegt. Das kostet eine
   * Rundreise — und im unglueckichsten Fall ist es die Stop-Order zu
   * einer gerade gefuellten Position.
   */
  private async ermittlePosModus(symbol: string): Promise<'hedge' | 'oneway' | null> {
    const ccxtSymbol = this.toCcxtSymbol(symbol);

    const bekannt = this.posModus.get(ccxtSymbol);
    if (bekannt) return bekannt;
    if (this.posModusGefragt.has(ccxtSymbol)) return null;
    this.posModusGefragt.add(ccxtSymbol);

    const ex = this.exchange as unknown as {
      fetchPositionMode?: (symbol?: string) => Promise<{ hedged?: boolean }>;
      fetchPositions?: (symbole?: string[]) => Promise<{ symbol?: string; hedged?: boolean }[]>;
    };

    // 1. Der vorgesehene Weg.
    if (typeof ex.fetchPositionMode === 'function') {
      try {
        const antwort = await ex.fetchPositionMode(ccxtSymbol);
        if (typeof antwort?.hedged === 'boolean') {
          return this.merkeModus(ccxtSymbol, antwort.hedged ? 'hedge' : 'oneway', 'fetchPositionMode');
        }
      } catch {
        // Bei Phemex der Regelfall: NotSupported.
      }
    }

    // 2. Der tragende Weg.
    if (typeof ex.fetchPositions === 'function') {
      try {
        const positionen = await ex.fetchPositions([ccxtSymbol]);

        // Nur den Eintrag zu diesem Symbol nehmen. Die Antwort kann
        // mehrere enthalten — im Hedge-Modus sogar zwei zum selben
        // Symbol, eine je Richtung.
        const passend = (positionen ?? []).find(
          (p) => p?.symbol === ccxtSymbol && typeof p?.hedged === 'boolean',
        );
        if (passend) {
          return this.merkeModus(ccxtSymbol, passend.hedged ? 'hedge' : 'oneway', 'fetchPositions');
        }
      } catch {
        // Auch das darf scheitern — dann lernen wir aus dem Fehler.
      }
    }

    return null;
  }

  /** Den erkannten Modus festhalten und einmal melden. */
  private merkeModus(
    ccxtSymbol: string,
    modus: 'hedge' | 'oneway',
    woher: string,
  ): 'hedge' | 'oneway' {
    this.posModus.set(ccxtSymbol, modus);
    console.info(
      `[${this.name}] ${ccxtSymbol} laeuft im "${modus}"-Modus (ueber ${woher} erfragt).`,
    );
    return modus;
  }

  /**
   * Beklagt diese Boerse einen unpassenden Positionsmodus?
   *
   * Erkannt wird am Fehlertext, nicht am Code: Jede Boerse hat ihren
   * eigenen, und ein unbekannter Anbieter soll nicht durchfallen, nur
   * weil seine Nummer hier nicht steht.
   */
  private istModusFehler(err: unknown): boolean {
    const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return text.includes('inconsistent_pos_mode') ||   // Phemex (20004)
           text.includes('position mode') ||            // Binance, Bybit
           text.includes('posmode') ||
           text.includes('position_mode') ||
           text.includes('hedge mode') ||
           text.includes('positionidx');                // Bybit (10001)
  }

  /**
   * Einen Aufruf ausfuehren und bei einem Modusfehler **einmal** in der
   * anderen Form wiederholen.
   *
   * Der gelernte Modus bleibt gemerkt, damit der naechste Aufruf gleich
   * richtig liegt. Genau einmal wiederholen und nicht in einer Schleife:
   * Zwei Formen gibt es, und wenn beide abgewiesen werden, ist der
   * Positionsmodus nicht die Ursache.
   */
  private async mitModus<T>(
    symbol: string,
    fn: (modus: 'hedge' | 'oneway') => Promise<T>,
  ): Promise<T> {
    const erkannt = await this.ermittlePosModus(symbol);
    const erster: 'hedge' | 'oneway' = erkannt ?? 'oneway';

    try {
      return await fn(erster);
    } catch (err) {
      if (!this.istModusFehler(err)) throw err;

      const anderer: 'hedge' | 'oneway' = erster === 'hedge' ? 'oneway' : 'hedge';
      const ergebnis = await fn(anderer);

      // Erst nach dem Erfolg merken. Haette der zweite Versuch auch
      // nicht getragen, waere der gemerkte Modus eine falsche Lehre.
      //
      // Dass es ueberhaupt hierher kommt, heisst: Die Abfrage in
      // `ermittlePosModus` hat geschwiegen oder sich geirrt. Beides
      // ist moeglich — ein Symbol kann im Betrieb umgestellt werden —,
      // und deshalb bleibt dieser Weg als Rueckfall bestehen.
      this.posModus.set(this.toCcxtSymbol(symbol), anderer);
      console.warn(
        `[${this.name}] Positionsmodus fuer ${symbol} war "${erster}", die Boerse ` +
        `arbeitet im "${anderer}"-Modus — ab jetzt gemerkt.`,
      );
      return ergebnis;
    }
  }

  /**
   * Der erkannte Positionsmodus eines Symbols — fuer die Anzeige und
   * die Tests. `null`, solange keiner feststeht. Fragt **nicht** nach.
   */
  positionsModusVon(symbol: string): 'hedge' | 'oneway' | null {
    return this.posModus.get(this.toCcxtSymbol(symbol)) ?? null;
  }

  /**
   * Den Positionsmodus klaeren, ohne zu handeln.
   *
   * Dasselbe wie das, was vor der ersten Order von innen geschieht —
   * nur von aussen anstossbar. Die Oberflaeche nutzt das, um den Modus
   * anzuzeigen; ohne diesen Weg liesse sich die Abfrage nur pruefen,
   * indem man einen echten Plan startet.
   *
   * Rein lesend: Es wird nichts gesetzt und keine Order angefasst.
   */
  async klaerePositionsModus(symbol: string): Promise<'hedge' | 'oneway' | null> {
    return this.ermittlePosModus(symbol);
  }

  /** Alles, was ueber die Modi bekannt ist — fuer die Anzeige. */
  positionsModi(): { symbol: string; modus: 'hedge' | 'oneway' }[] {
    return [...this.posModus.entries()].map(([symbol, modus]) => ({ symbol, modus }));
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this.marketType !== 'futures') return; // Kassahandel kennt keinen Hebel

    await this.ensureMarkets();
    const ccxtSymbol = this.toCcxtSymbol(symbol);

    // Im Hedge-Modus verlangt ccxt `hedged: true` — dann schickt es
    // `longLeverageRr`/`shortLeverageRr` statt `leverageRr`. Ohne das
    // weist Phemex den Aufruf ab, und der Hebel bleibt, wie die Boerse
    // ihn voreingestellt hat.
    await this.mitModus(symbol, async (modus) => {
      const params = modus === 'hedge' ? { hedged: true } : {};
      return this.exchange.setLeverage(leverage, ccxtSymbol, params);
    });
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    await this.ensureMarkets();

    const ccxtSymbol = this.toCcxtSymbol(params.symbol);
    const ccxtType = this.mapOrderTypeToCcxt(params.type);
    const ccxtSide = params.side; // 'buy' | 'sell' — kompatibel

    const extraParams: Record<string, unknown> = {};

    if (params.stopPrice !== undefined) {
      extraParams['stopPrice'] = params.stopPrice;

      // **Eine Trigger-Order braucht die Richtung des Ausloesens.**
      //
      // ccxt verlangt sie fuer Phemex zwingend und wirft sonst
      // `ArgumentsRequired` — die Order verlaesst den Bot gar nicht.
      // Nachgemessen am 07.11.2026:
      //
      //   createOrder(..., { stopPrice: 70000, reduceOnly: true })
      //     → ArgumentsRequired: phemex createOrder() also requires a
      //       'triggerDirection' parameter
      //
      // Aufgefallen ist das nie, weil noch keine Stop-Order an das
      // echte Phemex ging: Beim Vorfall am 05.11.2026 kamen nur zwei
      // Einstiege dorthin, und der Uebungsbroker braucht das Feld
      // nicht.
      //
      // **Die Seite bestimmt die Richtung.** Ein Verkauf loest aus,
      // wenn der Kurs faellt; ein Kauf, wenn er steigt. Das gilt fuer
      // beide Arten von Stop-Order:
      //
      //   | Zweck                     | Seite | Richtung     |
      //   |---------------------------|-------|--------------|
      //   | Stop-Loss auf einen Long  | sell  | `descending` |
      //   | Stop-Loss auf einen Short | buy   | `ascending`  |
      //   | Ausbruchskauf (Stop-Entry)| buy   | `ascending`  |
      //   | Ausbruchsverkauf          | sell  | `descending` |
      //
      // Genau diese Paarung ergibt bei ccxt `ordType: Stop` bzw.
      // `StopLimit`. Die Gegenpaarung ergaebe `MarketIfTouched` — eine
      // Order, die beim Beruehren in Gewinnrichtung ausloest. Die
      // brauchen wir nicht: Take-Profits liegen als gewoehnliche
      // Limit-Orders im Buch (Regel 3aa).
      //
      // Den Kurs zu vergleichen waere die naheliegende Alternative,
      // ist aber schlechter: Liegt er gerade am Stop, kippt die
      // Richtung je nach Augenblick der Abfrage.
      extraParams['triggerDirection'] = params.side === 'sell' ? 'descending' : 'ascending';
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

    // Im Hedge-Modus muss dazugesagt werden, WELCHE der beiden
    // Positionen gemeint ist.
    //
    // **Die Richtung wird notfalls aus der Order erschlossen.** Fehlt
    // `positionSide`, waere im Hedge-Modus sonst kein Feld dabei und
    // die Boerse wiese die Order ab — oder schlimmer: buchte sie gegen
    // die Gegenposition. Bei einem gewoehnlichen Einstieg ist die
    // Richtung eindeutig; bei `reduceOnly` ist sie es nicht, denn ein
    // Verkauf schliesst einen Long **oder** eroeffnet einen Short.
    // Deshalb nur dort erschliessen, wo es eindeutig ist.
    const order = await this.mitModus(params.symbol, async (modus) => {
      const felder = { ...extraParams };

      if (this.marketType === 'futures' && modus === 'hedge') {
        const seite = params.positionSide
          ?? (params.reduceOnly ? undefined : (params.side === 'buy' ? 'long' : 'short'));
        if (seite) Object.assign(felder, this.hedgeFeld(seite, 'hedge'));
      } else if (this.marketType === 'futures' && params.positionSide) {
        Object.assign(felder, this.hedgeFeld(params.positionSide, 'oneway'));
      }

      return this.exchange.createOrder(
        ccxtSymbol,
        ccxtType,
        ccxtSide,
        params.quantity,
        params.price,
        felder,
      );
    });

    return this.toOrderResult(order, params.symbol);
  }

  /**
   * Uebersetzt "long" oder "short" in das Feld, das diese Boerse dafuer
   * kennt.
   *
   * Es gibt keinen gemeinsamen Namen: ccxt reicht solche Angaben
   * unveraendert an die Boerse durch, und jede nennt sie anders.
   *
   *   Phemex   posSide      "Long" / "Short"   (One-Way: "Merged")
   *   Bybit    positionIdx  1 = Long, 2 = Short  (One-Way: 0)
   *   Binance  positionSide "LONG" / "SHORT"     (One-Way: "BOTH")
   *   OKX      posSide      "long" / "short"     (One-Way: "net")
   *
   * Eine unbekannte Boerse bekommt nichts mitgeschickt. Das ist die
   * richtige Vorsicht: Ein erfundenes Feld wuerde entweder ignoriert —
   * dann waere die Order im Netting-Modus und knabberte an der
   * Gegenposition — oder die Boerse wiese sie ab. Beides faellt
   * frueher auf als eine stillschweigend falsch gebuchte Order.
   *
   * **Die One-Way-Werte stehen in derselben Tabelle**, weil sie
   * dieselbe Frage beantworten. Eine Boerse im One-Way-Modus will das
   * Feld nicht weglassen, sondern mit ihrem Sammelwert belegt sehen —
   * Phemex "Merged", Bybit 0, OKX "net". Ein fehlendes Feld und ein
   * Feld mit Sammelwert sind fuer die Boerse nicht dasselbe.
   */
  private hedgeFeld(
    seite: 'long' | 'short',
    modus: 'hedge' | 'oneway',
  ): Record<string, unknown> {
    const id = String(this.exchange.id ?? '').toLowerCase();
    const hedge = modus === 'hedge';

    switch (id) {
      case 'phemex':
        return { posSide: hedge ? (seite === 'long' ? 'Long' : 'Short') : 'Merged' };
      case 'bybit':
        return { positionIdx: hedge ? (seite === 'long' ? 1 : 2) : 0 };
      case 'binance':
      case 'binanceusdm':
      case 'binancecoinm':
        return { positionSide: hedge ? (seite === 'long' ? 'LONG' : 'SHORT') : 'BOTH' };
      case 'okx':
        return { posSide: hedge ? seite : 'net' };
      default:
        return {};
    }
  }

  /**
   * Eine Order zuruecknehmen.
   *
   * **Auch das Zuruecknehmen braucht den Positionsmodus.** Phemex wies
   * `cancelOrder` am 05.11.2026 mit demselben
   * `TE_ERR_INCONSISTENT_POS_MODE` ab wie `setLeverage` — der Bot
   * konnte seine eigenen Einstiege nicht mehr loswerden, obwohl er
   * erkannt hatte, dass sie weg muessen. Zwei Kauf-Limits lagen
   * unbeaufsichtigt an der Boerse.
   *
   * Das ist der schwerste der drei Ausfaelle: Ein Bot, der nicht
   * aufraeumen kann, hinterlaesst Orders, von denen niemand weiss.
   */
  async cancelOrder(
    symbol: string,
    orderId: string,
    positionSide?: 'long' | 'short',
  ): Promise<void> {
    await this.ensureMarkets();
    const ccxtSymbol = this.toCcxtSymbol(symbol);

    try {
      await this.mitModus(symbol, async (modus) => {
        // **Im Hedge-Modus muss die Richtung mit.**
        //
        // ccxt setzt bei Phemex-USDT-Perps von sich aus
        // `posSide: "Merged"`, wenn keines uebergeben wird — das ist
        // die One-Way-Form. Bei einem Hedge-Konto antwortet die Boerse
        // darauf mit `TE_ERR_INCONSISTENT_POS_MODE`, und die Order
        // bleibt liegen.
        //
        // Ein `hedged: true` genuegt hier NICHT: ccxt wertet es nur in
        // `setLeverage` aus und reicht es beim Stornieren bloss durch,
        // waehrend `posSide` weiter auf "Merged" steht. Genau daran
        // scheiterte der erste Versuch, den Vorfall vom 05.11.2026 zu
        // beheben.
        const params = this.marketType === 'futures' && modus === 'hedge' && positionSide
          ? this.hedgeFeld(positionSide, 'hedge')
          : {};
        return this.exchange.cancelOrder(orderId, ccxtSymbol, params);
      });
    } catch (err) {
      // **Eine Order, die es nicht gibt, ist zurueckgenommen.**
      //
      // Das Ziel des Aufrufs ist, dass die Order nicht mehr an der
      // Boerse liegt — und genau das ist der Fall. Als Fehler
      // behandelt, haengt der Aufrufer dagegen fest: Der Monitor
      // vermerkt die Order nicht als storniert, versucht es beim
      // naechsten Durchlauf erneut und kommt nie weiter. Nach dem
      // 05.11.2026 lief genau das alle zwei Sekunden, nachdem die
      // Orders bei Phemex von Hand entfernt worden waren.
      //
      // Die drei Faelle, in denen das vorkommt, sind alle harmlos: Die
      // Order wurde von Hand geloescht, sie war schon gefuellt, oder
      // ein frueherer Versuch hatte Erfolg und nur die Rueckmeldung
      // ging verloren.
      if (!this.istOrderUnbekannt(err)) throw err;

      console.info(
        `[${this.name}] Order ${orderId} kennt die Boerse nicht (mehr) — ` +
        `als zurueckgenommen verbucht.`,
      );
    }
  }

  /**
   * Meldet die Boerse, dass sie diese Order nicht kennt?
   *
   * Erkannt wird am Typ, den ccxt vergibt, und ergaenzend am Text —
   * nicht jede Boerse laesst sich von ccxt zu `OrderNotFound`
   * einordnen.
   */
  private istOrderUnbekannt(err: unknown): boolean {
    const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? '';
    if (name === 'OrderNotFound') return true;

    const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return text.includes('order_not_found') ||    // Phemex (10002)
           text.includes('order not found') ||
           text.includes('unknown order') ||
           text.includes('order does not exist');
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

  /**
   * Unsere Order-Art in die ccxt-Art uebersetzen.
   *
   * **Bei ccxt ist `type` die Ausfuehrungsart, nicht der Auslöser.**
   * Dass eine Order eine Trigger-Order ist, sagt allein `stopPrice`;
   * `type` sagt nur, wie sie ausgefuehrt wird, wenn der Trigger faellt
   * — zu Markt oder als Limit.
   *
   * Hier stand `'stop' → 'stop'` und `'stop_limit' → 'stop_limit'`.
   * ccxt kennt diese Arten nicht: Es schreibt den Wert gross und
   * vergleicht ihn gegen `'Market'`. Aus `'stop'` wurde `'Stop'`, das
   * ist nicht `'Market'`, und deshalb waehlte ccxt **`StopLimit`** —
   * eine Stop-Limit-Order **ohne Limitpreis**, denn den gibt eine
   * Stop-Market-Order nicht mit.
   *
   * Nachgemessen am 07.11.2026 an `BTC/USDT:USDT`, abgefangen vor dem
   * Absenden:
   *
   *   | uebergeben    | Phemex `ordType` | `priceRp` |
   *   |---------------|------------------|-----------|
   *   | `'stop'`      | `StopLimit`      | **fehlt** |
   *   | `'market'`    | `Stop`           | —         |
   *   | `'limit'`     | `StopLimit`      | gesetzt   |
   *
   * Der Stop-Loss des Bots ist eine Stop-**Market**-Order: Wenn er
   * faellt, soll geschlossen werden, nicht auf einen Preis gewartet.
   * Mit `StopLimit` ohne Limitpreis haette Phemex sie abgewiesen oder
   * mit Preis 0 angelegt — in keinem Fall das, was gemeint war.
   */
  private mapOrderTypeToCcxt(type: OrderParams['type']): string {
    switch (type) {
      case 'limit': return 'limit';
      case 'market': return 'market';
      // Der Trigger steckt in `stopPrice`; hier zaehlt nur, wie
      // ausgefuehrt wird, sobald er greift.
      case 'stop': return 'market';
      case 'stop_limit': return 'limit';
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
      ...gebuehrAusCcxt(order),
    };
  }

  private toPositionInfo(pos: Position, symbol: string): PositionInfo {
    return {
      symbol,
      // ccxt fuehrt die Richtung als 'long' | 'short', nicht als
      // 'buy' | 'sell'. Die Werte hier ungeprueft durchzureichen war
      // gefaehrlich: `pos.side === 'buy'` ist bei einem Long IMMER
      // falsch, und closePosition() leitete daraus einen Kauf ab — die
      // Position waere verdoppelt statt geschlossen worden.
      side: seiteAusCcxt(pos.side, pos.contracts),
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

/**
 * Uebersetzt die Richtungsangabe einer ccxt-Position.
 *
 * ccxt fuehrt sie als 'long' | 'short'; die Schnittstelle dieses Bots
 * als 'buy' | 'sell'. Fehlt die Angabe, entscheidet das Vorzeichen der
 * Kontraktzahl — negative Kontrakte sind ein Short.
 *
 * Die Verwechslung war real folgenschwer: 'long' === 'buy' ist nie
 * wahr, also galt JEDE Position als Short. `closePosition()` leitete
 * daraus einen Kauf ab und haette einen Long verdoppelt statt ihn zu
 * schliessen.
 */
function seiteAusCcxt(seite: unknown, kontrakte: number | undefined): 'buy' | 'sell' {
  const text = String(seite ?? '').toLowerCase();
  if (text === 'long' || text === 'buy') return 'buy';
  if (text === 'short' || text === 'sell') return 'sell';
  return (kontrakte ?? 0) < 0 ? 'sell' : 'buy';
}

/**
 * Liest die Gebuehr aus einer ccxt-Order.
 *
 * Ohne sie steht in der Ergebnisrechnung je Plan eine Null, waehrend
 * die Boerse sehr wohl abgerechnet hat — jeder Trade saehe besser aus,
 * als er war. Beim Beurteilen eines Signalgebers ist das keine
 * Kleinigkeit: Bei engen Zielen entscheidet die Gebuehr darueber, ob
 * ein Trade im Plus endete.
 *
 * ccxt fuehrt sie an zwei Stellen — `fee` fuer eine einzelne und
 * `fees` fuer mehrere Teilabrechnungen. Beide werden gelesen; die
 * Teilabrechnungen gewinnen, wenn es sie gibt, denn sie sind
 * vollstaendiger.
 */
function gebuehrAusCcxt(order: Order): { fees?: number; feeCurrency?: string } {
  const einzeln = order.fee;

  // `fees` steht nicht in den ccxt-Typen, wird von vielen Boersen aber
  // geliefert — daher der Umweg ueber eine eigene Beschreibung.
  const roh = (order as unknown as {
    fees?: Array<{ cost?: number | string; currency?: string }>;
  }).fees;
  const mehrere = Array.isArray(roh) ? roh : [];

  if (mehrere.length > 0) {
    const summe = mehrere.reduce((s, f) => s + (Number(f?.cost) || 0), 0);
    if (summe > 0) {
      return { fees: summe, feeCurrency: mehrere[0]?.currency ?? einzeln?.currency };
    }
  }

  const betrag = Number(einzeln?.cost);
  if (Number.isFinite(betrag) && betrag !== 0) {
    // Manche Boersen melden eine Gutschrift (Maker-Rabatt) als
    // negative Gebuehr. Der Betrag wird so uebernommen, wie er kommt —
    // die Ergebnisrechnung zieht ihn ab, und ein negativer Abzug ist
    // eine Gutschrift.
    return { fees: betrag, feeCurrency: einzeln?.currency };
  }

  return {};
}
