// ============================================================
// CapitalService — wieviel Kapital tatsaechlich da ist
//
// Die Umrechnung eines Signals steht und faellt mit dieser Zahl. Darum
// gilt hier eine einfache Regel: Lieber keine Zahl als eine geratene.
// Wer einen Trade auf einen veralteten Kontostand stuetzt, handelt
// moeglicherweise ein Vielfaches dessen, was er wollte.
//
// Die Boerse ist die Quelle. Der eingestellte Wert tritt nur ein, wenn
// sie keine Auskunft gibt — und auch das nur, wenn der Nutzer es
// ausdruecklich erlaubt hat.
// ============================================================

import type { CapitalSnapshot } from '@tradingcontrol/signals';
import type { BrokerRegistry } from './broker-factory.js';
import type { Logger } from './log-service.js';

export interface CapitalServiceConfig {
  /**
   * Wert, der gilt, wenn die Boerse keinen nennt. 0 heisst: kein
   * Ersatzwert, dann wird abgelehnt.
   */
  fallbackEquity: number;
  /**
   * Darf der Ersatzwert ueberhaupt einspringen? Voreingestellt nein.
   * Ein Trade auf einer geratenen Kontogroesse ist schlimmer als keiner.
   */
  allowFallback: boolean;
  /** Wie lange ein abgefragter Stand gilt (ms). */
  cacheTtlMs: number;
}

export const STANDARD_KAPITAL_CONFIG: CapitalServiceConfig = {
  fallbackEquity: 0,
  allowFallback: false,
  cacheTtlMs: 60_000,
};

interface CacheEintrag {
  snapshot: CapitalSnapshot;
  bis: number;
}

export class CapitalService {
  private cache = new Map<string, CacheEintrag>();

  constructor(
    private readonly brokers: BrokerRegistry,
    private readonly logger: Logger,
    private config: CapitalServiceConfig = STANDARD_KAPITAL_CONFIG,
  ) {}

  setConfig(config: Partial<CapitalServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.cache.clear();
  }

  getConfig(): CapitalServiceConfig {
    return { ...this.config };
  }

  /**
   * Kontostand in der genannten Waehrung auf der genannten Boerse.
   *
   * Wirft nicht: Wer keine Auskunft bekommt, erhaelt einen Schnappschuss
   * mit `equity: 0`. Der Umrechner lehnt daraufhin ab, und der Grund
   * steht im Eingangsbuch.
   */
  async hole(
    exchangeId: string,
    quoteCurrency: string,
    optionen: { frisch?: boolean } = {},
  ): Promise<CapitalSnapshot> {
    const schluessel = `${exchangeId}:${quoteCurrency}`;

    if (!optionen.frisch) {
      const zwischengespeichert = this.cache.get(schluessel);
      if (zwischengespeichert && Date.now() < zwischengespeichert.bis) {
        return zwischengespeichert.snapshot;
      }
    }

    const vonBoerse = await this.frageBoerse(exchangeId, quoteCurrency);
    if (vonBoerse) {
      this.cache.set(schluessel, { snapshot: vonBoerse, bis: Date.now() + this.config.cacheTtlMs });
      return vonBoerse;
    }

    if (this.config.allowFallback && this.config.fallbackEquity > 0) {
      this.logger.warn(
        { exchangeId, quoteCurrency, ersatzwert: this.config.fallbackEquity },
        'Kontostand nicht abrufbar — es gilt der eingestellte Ersatzwert',
      );
      return {
        equity: this.config.fallbackEquity,
        free: this.config.fallbackEquity,
        quoteCurrency,
        source: 'configured',
        at: new Date().toISOString(),
      };
    }

    this.logger.error(
      { exchangeId, quoteCurrency },
      'Kontostand nicht abrufbar und kein Ersatzwert erlaubt — Signale werden abgelehnt',
    );
    return {
      equity: 0,
      free: 0,
      quoteCurrency,
      source: 'fallback',
      at: new Date().toISOString(),
    };
  }

  /** Grenzen eines Marktes, soweit die Boerse sie nennt. */
  async holeMarktgrenzen(exchangeId: string, symbol: string): Promise<{
    minAmount?: number; minCost?: number; amountStep?: number; amountPrecision?: number;
  } | undefined> {
    try {
      const broker = await this.brokers.get(exchangeId);
      if (!broker.getMarketInfo) return undefined;

      const info = await broker.getMarketInfo(symbol);
      if (!info) return undefined;

      return {
        minAmount: info.minAmount,
        minCost: info.minCost,
        amountStep: info.amountStep,
        amountPrecision: info.amountPrecision,
      };
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err, exchangeId, symbol },
        'Marktgrenzen nicht abrufbar — es wird ohne Mindestgroessen gerechnet',
      );
      return undefined;
    }
  }

  /** Verwirft den zwischengespeicherten Stand, etwa nach einem Trade. */
  entwerte(exchangeId?: string): void {
    if (!exchangeId) {
      this.cache.clear();
      return;
    }
    for (const schluessel of this.cache.keys()) {
      if (schluessel.startsWith(`${exchangeId}:`)) this.cache.delete(schluessel);
    }
  }

  // ============================================================
  // Intern
  // ============================================================

  private async frageBoerse(exchangeId: string, quoteCurrency: string): Promise<CapitalSnapshot | null> {
    try {
      const broker = await this.brokers.get(exchangeId);
      if (!broker.getBalance) {
        this.logger.debug(
          { exchangeId },
          'Dieser Zugang fuehrt keinen Kontostand — etwa der Uebungsbetrieb',
        );
        return null;
      }

      const bestand = await broker.getBalance();
      const waehrung = quoteCurrency.toUpperCase();

      const gesamt = bestand.total[waehrung];
      const frei = bestand.free[waehrung];

      if (gesamt == null) {
        this.logger.warn(
          { exchangeId, waehrung, gefuehrteWaehrungen: Object.keys(bestand.total) },
          'Die Boerse fuehrt keinen Bestand in dieser Waehrung',
        );
        return null;
      }

      if (frei == null) {
        this.logger.warn(
          { exchangeId, waehrung },
          'Die Boerse nennt keinen freien Betrag — die Grenze der verfuegbaren Margin wird uebersprungen',
        );
      }

      return {
        equity: gesamt,
        // Nennt die Boerse keinen freien Betrag, wird hier 0 gemeldet
        // und NICHT der Gesamtbetrag eingesetzt.
        //
        // Der Umrechner ueberspringt die Grenze bei 0 und vermerkt das.
        // Setzte man stattdessen das Gesamtkapital ein, pruefte er gegen
        // eine erfundene Zahl: Ein Konto, dessen Margin laengst gebunden
        // ist, bekaeme eine Position in voller Groesse — nur weil der
        // freie Betrag unbekannt war.
        free: frei ?? 0,
        quoteCurrency: waehrung,
        source: 'exchange',
        at: new Date().toISOString(),
      };
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err, exchangeId },
        'Abfrage des Kontostands fehlgeschlagen',
      );
      return null;
    }
  }
}
