// ============================================================
// Kerzen fuer die Chart-Ansicht
//
// Holt Kursverlaeufe von der Boerse, auf der ein Plan laeuft — ueber
// ccxt und ohne Zugangsdaten, denn Marktdaten sind oeffentlich.
//
// Warum nicht der vorhandene KlineFetcher aus `indicators`? Der holt
// von Binance. Fuer die Indikator-Auswertung ist das in Ordnung, fuer
// die Darstellung eines Trades nicht: Gezeigt werden muessen die Kerzen
// der Boerse, gegen die auch gehandelt wurde. Zwischen Binance und
// Phemex liegen bei denselben Dochten mitunter mehrere Promille — und
// genau an solchen Dochten entscheidet sich, ob ein Stop lag oder
// nicht.
//
// Warum nicht die Kline-API von Phemex von Hand? Sie verlangt dort ein
// vorangestelltes "s" (sBTCUSDT) — anders als die Ticker-API derselben
// Boerse — und liefert Preise um 1e8 skaliert, mit je Produkt
// unterschiedlichem Faktor. ccxt kennt diese Eigenheiten.
// ============================================================

import ccxt from 'ccxt';
import type { Exchange } from 'ccxt';
import type { Logger } from './log-service.js';

export interface Kerze {
  /** Zeitstempel in Millisekunden. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Zeitraster, die die Oberflaeche anbietet. */
export const ERLAUBTE_INTERVALLE = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type Intervall = typeof ERLAUBTE_INTERVALLE[number];

/** Marktart des Plans — bestimmt, welcher Markt gemeint ist. */
export type Marktart = 'spot' | 'futures';

/**
 * Stufen, die Phemex fuer die Anzahl der Kerzen annimmt.
 *
 * Dazwischen liegende Werte weist die Boerse mit
 * `{"code":30000,"msg":"Please double check input arguments"}` ab —
 * also mit einer Meldung, die auf alles Moegliche hindeutet, nur nicht
 * auf die Anzahl. Ausgerechnet 200, der naheliegende Standardwert,
 * gehoert nicht dazu.
 *
 * Gefragt wird deshalb immer mit der naechstgroesseren Stufe und
 * anschliessend zugeschnitten. Andere Boersen nehmen beliebige Werte;
 * eine zu grosse Anfrage schadet dort nicht.
 */
const PHEMEX_STUFEN = [5, 10, 50, 100, 500, 1000] as const;

export class KerzenService {
  /** Je Boerse ein Zugang, ohne Zugangsdaten — nur fuer Marktdaten. */
  private zugaenge = new Map<string, Exchange>();

  /** Kurzzeitiger Zwischenspeicher, damit ein offenes Fenster nicht dauernd abfragt. */
  private zwischenspeicher = new Map<string, { kerzen: Kerze[]; bis: number }>();

  private readonly haltbarkeitMs = 30_000;

  constructor(private readonly logger: Logger) {}

  /**
   * Kerzen zu einem Markt.
   *
   * Wirft nicht: Bei einem Fehlschlag kommt eine leere Liste und der
   * Grund steht im Protokoll. Ein fehlender Chart darf die
   * Detailansicht nicht verhindern.
   */
  async hole(
    boerse: string,
    symbol: string,
    intervall: Intervall = '15m',
    anzahl = 200,
    marktart: Marktart = 'futures',
  ): Promise<{ kerzen: Kerze[]; quelle: string; markt?: string; fehler?: string }> {
    // Im Uebungsbetrieb wird gegen Phemex-Kurse gerechnet; dann sollen
    // auch die Kerzen von dort kommen.
    const quelle = (boerse === 'paper' || !boerse) ? 'phemex' : boerse.toLowerCase();
    const schluessel = `${quelle}|${symbol}|${intervall}|${anzahl}|${marktart}`;

    const gemerkt = this.zwischenspeicher.get(schluessel);
    if (gemerkt && Date.now() < gemerkt.bis) {
      return { kerzen: gemerkt.kerzen, quelle };
    }

    try {
      const zugang = this.zugang(quelle);

      // Das Marktverzeichnis MUSS geladen sein, bevor das Symbol
      // aufgeloest wird — sonst wird es geraten. Bei BTCUSDT traf die
      // Vermutung zufaellig zu, bei anderen Maerkten nicht.
      await this.ladeMaerkte(zugang, quelle);

      const gewuenscht = Math.min(Math.max(anzahl, 1), 1000);
      const markt = this.ccxtSymbol(zugang, symbol, marktart);
      const ohlcv = await zugang.fetchOHLCV(
        markt, intervall, undefined, this.erlaubteAnzahl(quelle, gewuenscht),
      );

      const kerzen: Kerze[] = ohlcv
        .filter(c => c[0] != null && c[4] != null)
        .map(c => ({
          timestamp: Number(c[0]),
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5] ?? 0),
        }))
        // Auf die gewuenschte Anzahl zuschneiden, die juengsten behalten.
        .slice(-gewuenscht);

      this.zwischenspeicher.set(schluessel, {
        kerzen, bis: Date.now() + this.haltbarkeitMs,
      });
      // Der verwendete Markt gehoert in die Antwort: Nur so laesst sich
      // in der Oberflaeche nachsehen, welcher Verlauf da eigentlich
      // gezeigt wird.
      return { kerzen, quelle, markt };
    } catch (err) {
      const grund = err instanceof Error ? err.message : String(err);
      this.logger.warn({ quelle, symbol, intervall, err: grund }, 'Kerzen nicht abrufbar');

      // Der zuletzt bekannte Stand ist besser als nichts — ein Chart von
      // vor einer Minute sagt mehr als eine leere Flaeche.
      if (gemerkt) return { kerzen: gemerkt.kerzen, quelle, fehler: grund };
      return { kerzen: [], quelle, fehler: grund };
    }
  }

  /**
   * Anzahl, die die Boerse annimmt — mindestens die gewuenschte.
   *
   * Nur Phemex ist hier waehlerisch; fuer alle anderen bleibt der Wert,
   * wie er ist.
   */
  private erlaubteAnzahl(boerse: string, gewuenscht: number): number {
    if (boerse !== 'phemex') return gewuenscht;
    for (const stufe of PHEMEX_STUFEN) {
      if (stufe >= gewuenscht) return stufe;
    }
    return 1000;
  }

  /**
   * Laedt das Marktverzeichnis einmal je Boerse.
   *
   * Ohne das raet `ccxtSymbol` die Schreibweise. Scheitert das Laden,
   * wird trotzdem fortgefahren — dann greift eben der Rateweg, und ein
   * Versuch ist besser als gar keiner.
   */
  private geladen = new Set<string>();

  private async ladeMaerkte(zugang: Exchange, boerse: string): Promise<void> {
    if (this.geladen.has(boerse)) return;
    try {
      await zugang.loadMarkets();
      this.geladen.add(boerse);
    } catch (err) {
      this.logger.warn(
        { boerse, err: err instanceof Error ? err.message : err },
        'Marktverzeichnis nicht ladbar — die Symbol-Schreibweise wird geraten',
      );
    }
  }

  /** Zugang je Boerse, erst beim ersten Zugriff aufgebaut. */
  private zugang(boerse: string): Exchange {
    let vorhanden = this.zugaenge.get(boerse);
    if (vorhanden) return vorhanden;

    const Klasse = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[boerse];
    if (!Klasse) throw new Error(`ccxt kennt die Boerse "${boerse}" nicht`);

    vorhanden = new Klasse({
      enableRateLimit: true,
      timeout: 12_000,
      // Bewusst ohne Zugangsdaten: Kerzen sind oeffentlich, und was
      // nicht hinterlegt ist, kann auch nicht versehentlich handeln.
      options: { defaultType: 'swap' },
    });
    this.zugaenge.set(boerse, vorhanden);
    return vorhanden;
  }

  /**
   * Symbol in der Schreibweise der Boerse.
   *
   * Der Bot fuehrt "BTCUSDT", ccxt erwartet "BTC/USDT:USDT" fuer
   * Dauerkontrakte. Laesst sich das Marktverzeichnis nicht laden, wird
   * die Schreibweise geraten — besser ein Versuch als gar keiner.
   */
  private ccxtSymbol(zugang: Exchange, symbol: string, marktart: Marktart = 'futures'): string {
    const roh = symbol.toUpperCase().replace(/[/\-_]/g, '').replace(/\.P$/, '');

    const maerkte = zugang.markets;
    if (maerkte) {
      // Gesucht wird in der Schreibweise der Boerse, OHNE sie
      // gleichzumachen — und mit der Marktart als Bedingung.
      //
      // Beides ist noetig, und zwar wegen eines Falls, der sonst still
      // das Falsche liefert: Bei Phemex heisst der Dauerkontrakt auf SOL
      // "SOLUSDT", die Kasse auf OL aber "sOLUSDT". Gross geschrieben
      // sind beide "SOLUSDT". Ein Vergleich ueber toUpperCase traf
      // deshalb den OL-Markt — und der Chart eines SOL-Trades zeigte den
      // Verlauf einer ganz anderen Muenze, ohne dass irgendwo ein Fehler
      // erschien.
      const gesuchteArten = marktart === 'spot'
        ? ['spot']
        : ['swap', 'future', 'futures'];

      let ersatz: string | null = null;

      for (const m of Object.values(maerkte)) {
        if (!m) continue;
        const eintrag = m as { id?: string; symbol: string; type?: string };
        const id = String(eintrag.id ?? '');
        const art = String(eintrag.type ?? '');

        // Genaue Entsprechung bei passender Marktart — der Normalfall.
        if (id === roh && gesuchteArten.includes(art)) return eintrag.symbol;

        // Kasse mit vorangestelltem s, falls kein Kontrakt zu finden ist.
        if (id === `s${roh}` && art === 'spot' && ersatz === null) {
          ersatz = eintrag.symbol;
        }
      }

      if (ersatz) {
        this.logger.warn(
          { symbol, marktart, genommen: ersatz },
          'Kein Kontrakt zu diesem Markt gefunden — es werden die Kerzen der Kasse gezeigt',
        );
        return ersatz;
      }
    }

    for (const quote of ['USDT', 'USDC', 'USD']) {
      if (roh.endsWith(quote)) {
        const basis = roh.slice(0, -quote.length);
        return `${basis}/${quote}:${quote}`;
      }
    }
    return roh;
  }
}
