// ============================================================
// Broker-Werkstatt
//
// Baut fuer eine Boerse den passenden Zugang und haelt ihn vor. Mehrere
// Plaene auf derselben Boerse teilen sich eine Verbindung — jede eigene
// kostet ein neues Laden aller Maerkte und ein eigenes Rate-Limit-Budget.
//
// Ein Plan traegt die Boerse mit sich (Feld `exchange`, aus dem Journal
// oder lokal gesetzt). Frueher handelte der Bot alles ueber die eine in
// der Konfiguration hinterlegte Boerse — ein Plan fuer Kraken lief dann
// stillschweigend auf Phemex.
// ============================================================

import {
  CcxtBroker,
  PaperBroker,
  getExchange,
  type BrokerAdapter,
  type BrokerMarketType,
  type PaperAccount,
} from '@tradingcontrol/core';
import type { BotConfig, ExchangeCredentials } from '../config.js';

export class KeineZugangsdatenError extends Error {
  constructor(exchangeId: string) {
    super(
      `Fuer "${exchangeId}" sind keine Zugangsdaten hinterlegt. ` +
      `In den Einstellungen ergaenzen oder den Plan einer anderen Boerse zuordnen.`,
    );
    this.name = 'KeineZugangsdatenError';
  }
}

/**
 * Baut einen Broker fuer die angegebene Boerse.
 *
 * `paper` liefert den Uebungsbroker; er handelt nichts, sondern rechnet
 * gegen Kurse. Alles andere braucht hinterlegte Zugangsdaten.
 *
 * ## Wer entscheidet ueber echten Handel
 *
 * Jede Boerse fuer sich — nicht mehr ein Schalter fuer alles. Die
 * Entscheidung faellt in `SqliteStore.boerseUebt()` und kommt hier
 * als `uebtDieseBoerse` an.
 *
 * `config.nurUebungsbetrieb` wirkt weiterhin, aber nur noch **nach
 * unten**: Steht es, uebt alles, unabhaengig von der Einstellung je
 * Boerse. Das ist kein Widerspruch zur Umstellung, sondern ihr
 * Rueckfall — eine bestehende Einrichtung, die den Schalter gesetzt
 * hat, soll durch das Update nicht ploetzlich echt handeln.
 *
 * **Ohne Auskunft wird geuebt.** Wird `uebtDieseBoerse` nicht
 * uebergeben, nimmt diese Funktion Uebungsbetrieb an. Jeder Aufrufer,
 * der die Frage nicht beantwortet, bekommt den sicheren Fall — nicht
 * den riskanten.
 */
export function createBroker(
  config: BotConfig,
  exchangeId: string,
  marketType?: BrokerMarketType,
  /**
   * Das fortgefuehrte Uebungskonto. Ohne Angabe legt der Broker ein
   * eigenes an — dann gehen Ergebnisse bei jedem Neuaufbau verloren.
   */
  konto?: PaperAccount,
  /**
   * Uebt diese Boerse? Fehlt die Angabe, gilt Uebungsbetrieb.
   *
   * Siehe `SqliteStore.boerseUebt()` — dort steht, warum jede
   * Unklarheit auf die sichere Seite faellt.
   */
  uebtDieseBoerse?: boolean,
): BrokerAdapter {
  const uebt = uebtDieseBoerse ?? true;

  if (config.nurUebungsbetrieb || uebt || exchangeId === 'paper') {
    return new PaperBroker({
      priceSource: 'phemex',
      startkapital: { [config.uebungsWaehrung]: config.uebungsKapital },
      konto,
    });
  }

  const credentials: ExchangeCredentials | undefined = config.exchanges[exchangeId];
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    throw new KeineZugangsdatenError(exchangeId);
  }

  const definition = getExchange(exchangeId);
  // Ohne ausdrueckliche Angabe die Marktart nehmen, die die Boerse kann.
  const effectiveMarketType: BrokerMarketType = marketType
    ?? credentials.marketType
    ?? (definition?.supportsFutures ? 'futures' : 'spot');

  return new CcxtBroker({
    exchange: exchangeId,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    password: credentials.password,
    testnet: credentials.testnet ?? false,
    marketType: effectiveMarketType,
  });
}

/**
 * Haelt je Boerse und Marktart einen Broker vor und gibt ihn wieder heraus.
 *
 * Verbindungen werden erst beim ersten Zugriff aufgebaut: Wer nur auf
 * Kraken handelt, soll sich nicht bei jeder anderen hinterlegten Boerse
 * anmelden muessen.
 */
export class BrokerRegistry {
  private readonly broker = new Map<string, BrokerAdapter>();
  private readonly verbunden = new Set<string>();

  constructor(
    private config: BotConfig,
    /**
     * Das fortgefuehrte Uebungskonto. Alle Uebungsbroker teilen es sich
     * — sonst fuehrte jeder seine eigene Kasse, und der Kontostand
     * haenge davon ab, welcher Zugang gerade gefragt wird.
     */
    private readonly uebungskonto?: PaperAccount,
    /**
     * Liefert die Orders, die noch an der Boerse liegen sollten.
     *
     * Nur fuer den Uebungsbroker von Belang: Er haelt sein Orderbuch
     * im Arbeitsspeicher und kennt nach einem Neustart keine Order
     * mehr. Eine echte Boerse verliert ihr Orderbuch nicht, wenn der
     * Bot neu startet — dieser Zugang darf es auch nicht.
     */
    private readonly liegendeOrders?: () => Array<{
      brokerOrderId: string;
      clientOrderId?: string | null;
      symbol: string;
      side: 'buy' | 'sell';
      type: 'limit' | 'market' | 'stop' | 'stop_limit';
      quantity: number;
      price?: number | null;
      stopPrice?: number | null;
      reduceOnly?: boolean;
      leverage?: number | null;
    }>,
    /**
     * Uebt diese Boerse?
     *
     * Kommt aus `SqliteStore.boerseUebt()`. Fehlt die Auskunft,
     * nimmt die Registry Uebungsbetrieb an — dieselbe Einbahn wie in
     * `createBroker()`: Wer nicht antwortet, bekommt den sicheren Fall.
     */
    private readonly uebtBoerse?: (exchangeId: string) => boolean,
  ) {}

  /**
   * Sind fuer diese Boerse Zugangsdaten hinterlegt?
   *
   * Fuer die Oberflaeche: Echter Handel ohne Zugangsdaten endet bei
   * jedem Plan in einem Fehler — das gehoert gesagt, bevor jemand
   * umstellt, nicht danach.
   */
  hatZugangsdaten(exchangeId: string): boolean {
    if (exchangeId === 'paper') return true;
    const c = this.config.exchanges[exchangeId];
    return Boolean(c?.apiKey && c?.apiSecret);
  }

  /** Uebt diese Boerse? Ohne Auskunftgeber: ja. */
  uebt(exchangeId: string): boolean {
    if (this.config.nurUebungsbetrieb) return true;
    if (!this.uebtBoerse) return true;
    try {
      return this.uebtBoerse(exchangeId);
    } catch {
      return true;
    }
  }

  /** Nach einer Aenderung der Einstellungen: alles verwerfen und neu aufbauen. */
  async reconfigure(config: BotConfig): Promise<void> {
    await this.disconnectAll();
    this.config = config;
  }

  /**
   * Broker fuer eine Boerse — beim ersten Aufruf wird er aufgebaut und
   * verbunden. Wirft, wenn Zugangsdaten fehlen oder die Boerse die
   * Marktart nicht bedient.
   */
  async get(exchangeId: string, marketType?: BrokerMarketType): Promise<BrokerAdapter> {
    const uebt = this.uebt(exchangeId);

    // **Alle uebenden Boersen teilen sich EINEN Zugang.**
    //
    // Sonst entstuende je angefragter Boerse ein eigener Uebungsbroker
    // mit eigenem Positionsbestand — und ein Plan auf "bybit" saehe
    // die Positionen eines Plans auf "okx" nicht. Das Uebungskonto ist
    // eines; sein Kapital laesst sich nicht sinnvoll aufteilen, ohne
    // dass die Groessenbemessung jedes Trades fragwuerdig wird.
    //
    // Echte Boersen bekommen je Marktart ihren eigenen Zugang.
    const key = uebt ? 'paper:auto' : `${exchangeId}:${marketType ?? 'auto'}`;

    let broker = this.broker.get(key);
    if (!broker) {
      broker = createBroker(this.config, exchangeId, marketType, this.uebungskonto, uebt);

      // Dem frisch gebauten Uebungsbroker sein Orderbuch zurueckgeben.
      if (broker instanceof PaperBroker && this.liegendeOrders) {
        try {
          const zahl = broker.ordersWiederherstellen(this.liegendeOrders());
          if (zahl > 0) {
            // Ueber console, weil die Registry keinen Logger hat — und
            // weil ein stiller Wiederaufbau niemandem hilft.
            console.info(`[Uebungsbroker] ${zahl} liegende Order(s) wieder aufgenommen`);
          }
        } catch (err) {
          console.warn('[Uebungsbroker] Orderbuch nicht wiederherstellbar:', err);
        }
      }

      this.broker.set(key, broker);
    }

    if (!this.verbunden.has(key)) {
      await broker.connect();
      this.verbunden.add(key);
    }

    return broker;
  }

  /** Bereits aufgebaute Broker, ohne neue anzulegen. */
  listActive(): BrokerAdapter[] {
    return [...this.broker.values()];
  }

  async disconnectAll(): Promise<void> {
    for (const broker of this.broker.values()) {
      try {
        await broker.disconnect();
      } catch {
        // Ein misslungenes Trennen soll das Herunterfahren nicht aufhalten.
      }
    }
    this.broker.clear();
    this.verbunden.clear();
  }
}
