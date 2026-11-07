// ============================================================
// KursStrom — der laufende Kurs ueber WebSocket
//
// Bis hierher holte der Bot den Kurs per REST, im Zwei-Sekunden-Takt
// (`PRICE_POLL_INTERVAL`). Das hat zwei Maengel, und der zweite ist der
// schwerere:
//
//   1. Jede Abfrage kostet ein Rate-Limit-Kontingent. Bei zehn Plaenen
//      auf drei Boersen sind das 1.800 Abfragen je Minute.
//
//   2. **Zwischen zwei Abfragen ist der Bot blind.** Ein Docht, der in
//      dieser Luecke liegt, hat nie stattgefunden — fuer den Bot.
//
// Der zweite Punkt hat Geld gekostet. HYPEUSDT lief am 25.10.2026 in
// der Minute 13:17 auf 77,034 und schloss bei 76,957; Ziel 1 lag bei
// 76,9907 und wurde nie ausgeloest. Dass die Einstiege, Ziele und der
// Stop inzwischen als echte Orders im Orderbuch liegen (Regel 3aa),
// entschaerft das fuer sie — die Boerse sieht jeden Tick.
//
// **Zwei Dinge bleiben am Kurs haengen, den der Bot selbst sieht:**
//
//   - der Trailing-Stop. Er rechnet Prozente vom Hoechstkurs, und
//     diesen Hoechstkurs kennt niemand ausser dem Bot. Ein Docht
//     zwischen zwei Abfragen hob ihn nicht — der Stop blieb zu tief.
//   - Ziele und Einstiege mit Indikator-Trigger. Die Boerse kennt
//     keinen RSI, also laufen sie weiter ueber die Beobachtung.
//
// Deshalb sammelt diese Klasse nicht nur den letzten Preis, sondern
// **Hoch und Tief seit der letzten Abfrage**. Der Monitor fragt alle
// zwei Sekunden und bekommt trotzdem die ganze Spanne — kein Tick
// faellt mehr durch.
//
// **Gelesen werden beide Kanaele gleichzeitig**, und beide speisen
// dieselbe Spanne. Das ist gemessen, nicht geraten — und die erste
// Messung ging daneben: Sie zaehlte den Historien-Schwung mit, den der
// erste `watchTrades`-Aufruf liefert (1.000 Handel ueber 45 Minuten),
// und schrieb dessen Spanne den letzten 20 Sekunden zu.
//
// Mit verworfener Historie, Phemex, 60 Sekunden am 05.11.2026:
//
//   | Symbol        | Kanal   | Meldungen | Spanne |
//   |---------------|---------|-----------|--------|
//   | BTC/USDT:USDT | Trades  |        10 |  28,10 |
//   | BTC/USDT:USDT | Ticker  |        20 |  48,90 |
//   | SOL/USDT:USDT | Trades  |         5 |   0,02 |
//   | SOL/USDT:USDT | Ticker  |        20 |   0,05 |
//
// Der Trade-Strom dieser Kontrakte ist duenn — zehn Handel in einer
// Minute auf BTC. Der Ticker kommt dagegen verlaesslich alle drei
// Sekunden und sah deshalb die **groessere** Spanne, obwohl er ein
// geglaetteter Wert ist.
//
// Keiner der beiden ist also der bessere. Ein einzelner Handel zeigt
// einen Preis, den der Ticker nie meldet; ein Ticker-Takt faellt auch
// dann, wenn gerade niemand handelt. Deshalb laufen beide Schleifen,
// und `hoch`/`tief` nehmen das Aeusserste von allem, was ankommt.
// Zwei Abos je Symbol kosten nichts — eine verpasste Spitze kostet den
// Trailing-Stop.
//
// **Was der Umbau wirklich bringt** — 60 Sekunden BTC/USDT:USDT,
// Abfragen im Zwei-Sekunden-Takt wie im Monitor:
//
//   |                    | REST-Abfrage | Kursstrom |
//   |--------------------|--------------|-----------|
//   | Antwortzeit        |     2.321 ms |      1 ms |
//   | gesehene Spanne    |        37,30 |     37,40 |
//
// Die Spanne gewann 0,10 Punkte — an einem ruhigen Markt also fast
// nichts. **Der Gewinn steht in der ersten Zeile:** Die REST-Abfrage
// dauerte laenger als der Takt, in dem sie gestellt wurde. Der
// tatsaechliche Blindfleck war nie zwei Sekunden, sondern ueber vier —
// und bei mehreren Plaenen auf derselben Boerse mehr, weil sie sich das
// Rate-Limit teilen.
//
// Ob der Strom in einer wirklich bewegten Minute mehr von der Spanne
// zeigt, ist damit **nicht** gemessen. Plausibel ist es; behauptet wird
// es hier nicht.
//
// REST bleibt als Rueckfall. Eine Boerse ohne `watchTicker`, eine
// abgerissene Verbindung, ein Symbol ohne Tick: In jedem dieser Faelle
// antwortet diese Klasse mit `null` und der Aufrufer fragt per REST.
// Nie wird ein alter Wert als aktueller ausgegeben.
// ============================================================

/**
 * Das Stueck ccxt, das hier gebraucht wird.
 *
 * Absichtlich klein gehalten: So laesst sich der Strom mit einer
 * Attrappe pruefen, ohne eine Boerse anzufassen.
 */
export interface StromFaehigeBoerse {
  has?: Record<string, unknown>;
  watchTrades?(symbol: string): Promise<{ price?: number; timestamp?: number }[]>;
  watchTicker?(symbol: string): Promise<{ last?: number; close?: number; bid?: number; timestamp?: number }>;
  close?(): Promise<unknown>;
}

export interface KursStand {
  /** Der letzte gesehene Preis. */
  preis: number;
  /** Wann er ankam (ms seit 1970), nach der Uhr dieses Rechners. */
  zeit: number;
}

export interface KursSpanne {
  hoch: number;
  tief: number;
  /** Wie viele Ticks in diese Spanne eingingen. */
  ticks: number;
}

interface SymbolStand {
  preis: number;
  zeit: number;
  hoch: number;
  tief: number;
  ticks: number;
  /** Laeuft noch mindestens eine Beobachtungsschleife? */
  aktiv: boolean;
  /**
   * Wie viele Schleifen gerade laufen — eine je Kanal.
   *
   * Noetig, weil `aktiv` beide zusammen meint: Endet nur die eine,
   * darf das Abo nicht als tot gelten. Sonst startete `abonniere()`
   * beim naechsten Aufruf alles neu, und von dem noch laufenden Kanal
   * gaebe es anschliessend zwei Schleifen auf demselben Symbol.
   */
  schleifen: number;
  /** Aufeinanderfolgende Fehlversuche — steuert die Wartezeit. */
  fehler: number;
  /**
   * Ab welchem Boersen-Zeitstempel ein Trade zaehlt.
   *
   * **Der erste `watchTrades`-Aufruf liefert den ganzen
   * Zwischenspeicher** — gemessen 1.000 Trades ueber 45 Minuten. Ohne
   * diese Grenze waere die erste "Spanne seit der letzten Abfrage"
   * das Hoch und Tief einer Dreiviertelstunde, und der Trailing-Stop
   * sprang sofort auf 1,5 % unter das Stundenhoch.
   */
  abZeit: number;
  /** Der zuletzt verarbeitete Trade — gegen Doppelzaehlung. */
  letzterTradeTs: number;
  /**
   * Wie viele Handel mit genau `letzterTradeTs` schon verbucht sind.
   *
   * **Der Zeitstempel allein genuegt nicht.** Mehrere Handel in
   * derselben Millisekunde sind an einer Boerse die Regel; ein
   * Ausbruch besteht geradezu daraus. Ein Vergleich mit "neuer als"
   * verwirft von ihnen alles bis auf den ersten — und damit genau den
   * Docht, den der Strom sehen soll. Ein Vergleich mit "neuer oder
   * gleich" zaehlt sie dafuer bei jeder Wiederholung erneut.
   *
   * Dieser Zaehler loest beides: Von den Handeln auf der Grenz-
   * Millisekunde werden die bereits bekannten uebersprungen, der Rest
   * zaehlt.
   */
  gesehenAufLetzterMs: number;
}

/** Wie lange ein Tick als aktuell gilt. Darueber wird REST gefragt. */
export const STROM_HOECHSTALTER_MS = 15_000;

/** Wartezeit nach dem ersten Fehler; sie verdoppelt sich bis zur Grenze. */
const WARTE_GRUND_MS = 1_000;
const WARTE_HOECHSTENS_MS = 60_000;

export class KursStrom {
  private readonly staende = new Map<string, SymbolStand>();
  private gestoppt = false;

  constructor(
    private readonly boerse: StromFaehigeBoerse,
    private readonly bezeichnung: string,
    private readonly melde: (stufe: 'info' | 'warn', text: string, daten?: unknown) => void = () => {},
  ) {}

  /** Kann diese Boerse ueberhaupt einen Strom? */
  get moeglich(): boolean {
    return this.kannTrades || this.kannTicker;
  }

  /** Einzelne Handel — echte Preise, aber je Kontrakt unterschiedlich dicht. */
  private get kannTrades(): boolean {
    return typeof this.boerse.watchTrades === 'function' &&
           this.boerse.has?.watchTrades === true;
  }

  /** Ein gedrosselter Wert, dafuer in verlaesslichem Takt. */
  private get kannTicker(): boolean {
    return typeof this.boerse.watchTicker === 'function' &&
           this.boerse.has?.watchTicker === true;
  }

  /** Welche Kanaele gelesen werden — fuer die Anzeige. */
  get kanaele(): ('trades' | 'ticker')[] {
    const k: ('trades' | 'ticker')[] = [];
    if (this.kannTrades) k.push('trades');
    if (this.kannTicker) k.push('ticker');
    return k;
  }

  /**
   * Ein Symbol beobachten.
   *
   * Mehrfach aufzurufen ist harmlos — die Schleife laeuft je Symbol nur
   * einmal. Genau darauf verlaesst sich der Aufrufer: Er ruft das bei
   * jeder Kursabfrage auf, ohne sich zu merken, was schon laeuft.
   */
  abonniere(symbol: string): void {
    if (!this.moeglich || this.gestoppt) return;
    const vorhanden = this.staende.get(symbol);
    if (vorhanden?.aktiv) return;

    const stand: SymbolStand = vorhanden ?? {
      preis: 0, zeit: 0, hoch: 0, tief: 0, ticks: 0, aktiv: false, fehler: 0,
      abZeit: Date.now(), letzterTradeTs: 0, gesehenAufLetzterMs: 0,
      schleifen: 0,
    };
    stand.aktiv = true;
    this.staende.set(symbol, stand);

    // Beide Kanaele, soweit die Boerse sie kann. Keiner ist dem anderen
    // verlaesslich voraus — siehe die Messung im Kopf.
    if (this.kannTrades) { stand.schleifen++; void this.schleife(symbol, stand, 'trades'); }
    if (this.kannTicker) { stand.schleifen++; void this.schleife(symbol, stand, 'ticker'); }
  }

  /**
   * Der letzte Kurs — oder `null`, wenn er zu alt ist.
   *
   * **Lieber keine Antwort als eine veraltete.** Der Aufrufer fragt
   * dann per REST. Ein stehengebliebener Kurs waere schlimmer als
   * keiner: Er sieht aus wie eine Tatsache und ist eine Erinnerung.
   */
  letzterKurs(symbol: string, jetzt = Date.now()): KursStand | null {
    const stand = this.staende.get(symbol);

    // **Nicht auf `ticks` pruefen.** Der Zaehler gehoert zur Spanne und
    // wird beim Lesen zurueckgesetzt; der Preis bleibt. Wer ihn hier
    // mitabfragte, bekaeme nach jedem `spanneSeitAbfrage()` ein `null`
    // und fiele unnoetig auf REST zurueck — obwohl der Kurs
    // sekundenfrisch dasteht.
    if (!stand || stand.zeit === 0 || stand.preis <= 0) return null;
    if (jetzt - stand.zeit > STROM_HOECHSTALTER_MS) return null;
    return { preis: stand.preis, zeit: stand.zeit };
  }

  /**
   * Hoch und Tief seit der letzten Abfrage — und setzt die Spanne
   * danach zurueck.
   *
   * **Das ist der eigentliche Gewinn gegenueber REST.** Der Monitor
   * fragt alle zwei Sekunden und erfaehrt trotzdem, was dazwischen
   * geschah. Fuer den Trailing-Stop ist das der Unterschied zwischen
   * dem wirklichen Hoechstkurs und dem hoechsten von Stichproben.
   *
   * Zurueckgesetzt wird **auf den letzten Preis**, nicht auf null: Der
   * naechste Zeitraum beginnt dort, wo dieser endete, sonst klaffte
   * zwischen zwei Abfragen eine Luecke.
   */
  spanneSeitAbfrage(symbol: string): KursSpanne | null {
    const stand = this.staende.get(symbol);
    if (!stand || stand.ticks === 0) return null;

    const spanne: KursSpanne = { hoch: stand.hoch, tief: stand.tief, ticks: stand.ticks };
    stand.hoch = stand.preis;
    stand.tief = stand.preis;
    stand.ticks = 0;
    return spanne;
  }

  /** Alle Schleifen beenden und die Verbindungen schliessen. */
  async stoppe(): Promise<void> {
    this.gestoppt = true;
    for (const stand of this.staende.values()) stand.aktiv = false;

    // `close()` loest die haengenden `watchTicker`-Zusagen. Ohne das
    // bliebe der Prozess am offenen Socket haengen.
    if (typeof this.boerse.close === 'function') {
      try { await this.boerse.close(); } catch { /* beim Schliessen ist das gleichgueltig */ }
    }
  }

  /** Was gerade beobachtet wird — fuer die Anzeige. */
  uebersicht(jetzt = Date.now()): { symbol: string; preis: number; alterMs: number; aktiv: boolean }[] {
    return [...this.staende.entries()].map(([symbol, s]) => ({
      symbol,
      preis: s.preis,
      alterMs: s.zeit > 0 ? jetzt - s.zeit : -1,
      aktiv: s.aktiv,
    }));
  }

  // ============================================================

  /**
   * Die Beobachtungsschleife eines Symbols — eine je Kanal.
   *
   * Beide laufen nebeneinander und schreiben in denselben Stand. Das
   * ist gewollt: Welcher Kanal die Spitze zuerst sieht, haengt am
   * Symbol und an der Tageszeit (siehe Messung im Kopf), und `hoch` /
   * `tief` sollen das Aeusserste von allem kennen.
   *
   * **Nebenlaeufig, aber nicht gleichzeitig.** JavaScript arbeitet
   * einen Ereignisstrang ab; zwischen dem Lesen und Schreiben von
   * `stand.hoch` kann kein anderer dazwischenkommen. Ein Schloss
   * braucht es hier also nicht.
   *
   * `watchTrades` und `watchTicker` kehren bei jeder Meldung zurueck.
   * Faellt die Verbindung, werfen sie — dann wird gewartet und neu
   * versucht, mit sich verdoppelnder Wartezeit bis zu einer Minute.
   *
   * **Die Schleife gibt niemals auf.** Eine Boerse ist auch mal eine
   * Stunde gestoert; danach soll der Strom von selbst wieder laufen,
   * ohne dass jemand den Bot neu startet. Bis dahin traegt REST.
   */
  private async schleife(
    symbol: string,
    stand: SymbolStand,
    kanal: 'trades' | 'ticker',
  ): Promise<void> {
    // Fehler und Wiederanlauf werden je Kanal gezaehlt. Sonst setzte
    // der laufende Kanal den Zaehler des abgerissenen bei jeder Meldung
    // zurueck, und der Abriss waere nie zu sehen.
    let fehler = 0;

    while (stand.aktiv && !this.gestoppt) {
      try {
        const preise = kanal === 'trades'
          ? await this.holeAusTrades(symbol, stand)
          : await this.holeAusTicker(symbol);
        if (!stand.aktiv || this.gestoppt) break;
        if (preise.length === 0) continue;

        if (fehler > 0) {
          this.melde('info', `Kursstrom (${kanal}) fuer ${symbol} wieder verbunden`, {
            boerse: this.bezeichnung, symbol, kanal, fehlversuche: fehler,
          });
          fehler = 0;
          stand.fehler = 0;
        }

        for (const preis of preise) {
          // Der erste Tick setzt die Spanne, jeder weitere weitet sie.
          if (stand.ticks === 0) {
            stand.hoch = preis;
            stand.tief = preis;
          } else {
            if (preis > stand.hoch) stand.hoch = preis;
            if (preis < stand.tief) stand.tief = preis;
          }
          stand.ticks++;
        }

        // Der letzte Preis im Schwung ist der aktuelle — die Boerse
        // liefert die Trades in zeitlicher Folge.
        stand.preis = preise[preise.length - 1]!;

        // **Die eigene Uhr, nicht die der Boerse.** Das Alter
        // entscheidet, ob der Wert noch gilt; eine abweichend gestellte
        // Boersenuhr liesse jeden Tick als zu alt oder als ewig frisch
        // erscheinen.
        stand.zeit = Date.now();
      } catch (err) {
        if (!stand.aktiv || this.gestoppt) break;

        fehler++;
        stand.fehler = fehler;
        const warte = Math.min(WARTE_GRUND_MS * 2 ** (fehler - 1), WARTE_HOECHSTENS_MS);

        // Nur den ersten Fehlschlag und dann jeden fuenften melden.
        // Eine Boerse, die eine Stunde stoert, soll das Protokoll nicht
        // zuschuetten — aber stillschweigend ausfallen soll sie auch
        // nicht.
        if (fehler === 1 || fehler % 5 === 0) {
          this.melde('warn', `Kursstrom (${kanal}) fuer ${symbol} abgerissen — der andere Kanal und REST tragen weiter`, {
            boerse: this.bezeichnung, symbol, kanal, fehlversuche: fehler, wartetMs: warte,
            fehler: err instanceof Error ? err.message : String(err),
          });
        }

        await new Promise((r) => setTimeout(r, warte));
      }
    }

    // Erst wenn die letzte Schleife geht, ist das Abo zu Ende.
    stand.schleifen--;
    if (stand.schleifen <= 0) stand.aktiv = false;
  }

  /**
   * Die Preise aller neuen Handel.
   *
   * **Zwei Siebe, und beide sind noetig:**
   *
   *   - `abZeit` wirft die Historie weg. Der erste Aufruf liefert den
   *     ganzen Zwischenspeicher der Boerse; gemessen waren das 1.000
   *     Trades ueber 45 Minuten. Deren Hoch als "Spanne der letzten
   *     zwei Sekunden" auszugeben, zoege den Trailing-Stop sofort auf
   *     1,5 % unter das Stundenhoch — und damit mitten in den Markt.
   *
   *   - `letzterTradeTs` zusammen mit `gesehenAufLetzterMs` verhindert,
   *     dass derselbe Handel zweimal zaehlt — ohne die Handel zu
   *     verlieren, die sich die Millisekunde mit ihm teilen. Fuer Hoch
   *     und Tief waere eine Doppelzaehlung harmlos (ein Maximum aendert
   *     sich nicht, wenn dieselbe Zahl noch einmal kommt), fuer den
   *     Tick-Zaehler nicht: Nach ihm entscheidet der Aufrufer, ob er
   *     der Spanne ueberhaupt glaubt.
   *
   * **Die Reihenfolge im Schwung wird als zeitlich gelesen.** ccxt
   * liefert die Handel in der Folge, in der sie eintrafen; nur deshalb
   * ist "die ersten N auf der Grenz-Millisekunde ueberspringen"
   * dasselbe wie "die bereits bekannten ueberspringen".
   */
  private async holeAusTrades(symbol: string, stand: SymbolStand): Promise<number[]> {
    const trades = await this.boerse.watchTrades!(symbol);
    if (!Array.isArray(trades) || trades.length === 0) return [];

    const grenze = Math.max(stand.abZeit, stand.letzterTradeTs);

    // Nur wenn die Grenze wirklich vom letzten Handel kommt, sind dort
    // schon welche verbucht. Setzt `abZeit` die Grenze, ist sie neu.
    const schonVerbucht = stand.letzterTradeTs >= stand.abZeit ? stand.gesehenAufLetzterMs : 0;
    let uebersprungen = 0;

    const preise: number[] = [];
    let neuesterTs = stand.letzterTradeTs;
    let aufNeuestem = 0;

    for (const t of trades) {
      const ts = Number(t?.timestamp ?? 0);
      const preis = Number(t?.price ?? 0);
      if (!Number.isFinite(preis) || preis <= 0) continue;

      // Ein Handel ohne Zeitstempel laesst sich nicht einordnen. Ihn
      // mitzunehmen hiesse, bei jedem Aufruf die ganze Historie
      // mitzunehmen — denn ohne Zeit greift kein Sieb.
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (ts < grenze) continue;

      // Auf der Grenz-Millisekunde die bereits bekannten weglassen.
      if (ts === stand.letzterTradeTs && uebersprungen < schonVerbucht) {
        uebersprungen++;
        continue;
      }

      preise.push(preis);

      if (ts > neuesterTs) { neuesterTs = ts; aufNeuestem = 1; }
      else if (ts === neuesterTs) aufNeuestem++;
    }

    // Kam kein neuerer Zeitstempel, zaehlen die alten auf derselben
    // Millisekunde weiter mit.
    if (neuesterTs === stand.letzterTradeTs) aufNeuestem += schonVerbucht;

    stand.letzterTradeTs = neuesterTs;
    stand.gesehenAufLetzterMs = aufNeuestem;
    return preise;
  }

  /**
   * Der Ticker — ein Punktwert je Meldung.
   *
   * Ein geglaetteter Wert, aber in verlaesslichem Takt: bei Phemex
   * alle drei Sekunden, auch wenn gerade niemand handelt. Gemessen sah
   * er deshalb die groessere Spanne als der Trade-Strom (siehe Kopf) —
   * ein Rueckfall ist er also nicht, sondern die zweite Haelfte.
   */
  private async holeAusTicker(symbol: string): Promise<number[]> {
    const ticker = await this.boerse.watchTicker!(symbol);
    const preis = ticker?.last ?? ticker?.close ?? ticker?.bid ?? 0;
    return Number.isFinite(preis) && preis > 0 ? [preis] : [];
  }
}
