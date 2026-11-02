/**
 * Rueckkanal an TC-Synaptrix: melden, was aus einem Signalplan wurde.
 *
 * Vertrag: `TC-Synaptrix/docs/RUECKKANAL-BOT.md`. Nur die Schnittstelle
 * stammt von dort — dieser Code ist eigenstaendig geschrieben und
 * uebernimmt keine Zeile aus jenem Projekt.
 *
 * ## Wozu
 *
 * TC-Synaptrix erzeugt die Plaene und muss messen, was daraus wurde.
 * Ohne diese Rueckmeldung kennt es nur den HTTP-Status der Annahme — und
 * ein Plan, dessen Limit-Orders nie erreicht wurden, sieht dort genauso
 * aus wie einer, der laeuft: beide "gesendet, HTTP 200".
 *
 * **Gegenueber dem Journal (TradingControl) aendert sich nichts.** Der
 * Bot meldet dorthin weiterhin nichts; das Journal fuehrt seine eigene
 * Buchhaltung ueber den Boersen-Import, und eine zweite Quelle dort
 * erzeugte genau den Abgleichkonflikt, den es zu vermeiden gilt.
 *
 * ## Drei Eigenschaften, die den Kanal tragen
 *
 * 1. **Erst in die Warteschlange, dann senden.** Ein Ereignis entsteht im
 *    Monitor-Takt; der Empfaenger kann gerade neu starten. Wer direkt
 *    sendet und den Fehlschlag verwirft, verliert genau die Ereignisse,
 *    die waehrend einer Stoerung anfielen — und niemand bemerkt es.
 * 2. **Wiederholen, bis es ankommt.** Die Warteschlange ueberlebt einen
 *    Neustart (SQLite, kein Arbeitsspeicher).
 * 3. **Eigene, dauerhafte Ereigniskennung.** Bricht die Verbindung nach
 *    dem Schreiben, aber vor der Antwort ab, wird erneut gesendet. Der
 *    Empfaenger verwirft, was er kennt. Ohne diesen Schluessel entstuenden
 *    Doppelbuchungen, und eine doppelt gezaehlte Ausfuehrung verfaelscht
 *    jede Auswertung.
 *
 * ## Standardmaessig aus
 *
 * Ohne `TC_RUECKKANAL_URL` meldet der Bot nichts und verhaelt sich wie
 * bisher. Die Warteschlange laeuft dann gar nicht erst an — eine, die
 * sich fuellt und nie geleert wird, waere ein stilles Leck.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { TradePlanMonitor } from './trade-plan-monitor.js';

/** Die Ereignisarten, die der Vertrag kennt. */
export type RueckkanalArt =
  | 'platziert'
  | 'teilausgefuehrt'
  | 'ausgefuehrt'
  | 'abgelehnt'
  | 'storniert'
  | 'sl_getroffen'
  | 'tp_getroffen'
  | 'position_geschlossen'
  | 'verfallen'
  | 'uebersprungen';

export interface RueckkanalEreignis {
  ereignis_id: string;
  /** Die Signalkennung von TC-Synaptrix — der gemeinsame Bezug. */
  signal_id: string;
  /** Unsere eigene Plan-Id. Hilfreich, aber nicht der Schluessel. */
  plan_id: string | null;
  art: RueckkanalArt;
  zeitpunkt: string;
  boerse: string;
  boersen_order_id: string | null;
  /**
   * Zahlen als ZEICHENKETTE.
   *
   * JSON kennt nur IEEE-754-Fliesskomma. Eine Menge mit acht
   * Nachkommastellen ueberlebt das nicht unbeschadet, und der Verlust
   * faellt nicht auf — er verschiebt nur jede Summe ein wenig. Der
   * Empfaenger weist Zahlen als Zahl ausdruecklich ab.
   */
  preis: string | null;
  menge: string | null;
  gebuehr: string | null;
  gebuehr_waehrung: string | null;
  grund: string | null;
  /**
   * Der Stand der Position zum Zeitpunkt des Ereignisses.
   *
   * Nur bei Ereignissen, die ihn veraendern — sonst `null`.
   *
   * ## Wozu
   *
   * Ohne diese Angabe kennt TC-Synaptrix den tatsaechlichen Einstand
   * nicht. Es weiss, welche Einstiege es GEPLANT hat, aber nicht,
   * welche davon gefuellt wurden; der Kanal meldet je Order einen
   * Fuellpreis, nie den gewichteten Durchschnitt. Wer daraus einen
   * Break-Even-Stop rechnet, rechnet ihn auf die geplante Staffel —
   * und verfehlt ihn, sobald nur ein Teil gefuellt hat.
   *
   * Genau das geschah am 26.10.2026 bei BNBUSDT: Stop auf 737,61
   * gesetzt (Durchschnitt aller vier geplanten Einstiege), gefuellt
   * war aber nur der erste zu 739,96. Trotz Take-Profit endete der
   * Plan mit −6,21 USDT.
   *
   * Zahlen wieder als Zeichenkette, aus demselben Grund wie oben.
   */
  position: RueckkanalPosition | null;
}

export interface RueckkanalPosition {
  /** Mengengewichteter Durchschnitt der GEFUELLTEN Einstiege. */
  einstand: string | null;
  /** Summe der gefuellten Einstiege. */
  eingestiegen: string;
  /** Was davon noch im Markt steht. */
  offen: string;
  /** Wieviele Einstiegsstufen gefuellt sind — und wieviele es gab. */
  einstiege_gefuellt: number;
  einstiege_gesamt: number;
}

export interface RueckkanalConfig {
  /** Leer = der Kanal ist zu, es wird nichts gemeldet. */
  url: string;
  token: string;
  /** Wie oft die Warteschlange geleert wird. */
  taktMs?: number;
  /** Hoechstzahl je Sendung — der Empfaenger nimmt 500. */
  buendelGroesse?: number;
  boerse: string;
}

const TAKT_VORGABE_MS = 15_000;
const BUENDEL_VORGABE = 100;
const EMPFAENGER_HOECHSTZAHL = 500;

/**
 * Nach so vielen Fehlversuchen wird ein Ereignis aufgegeben.
 *
 * Nicht unbegrenzt: Ein dauerhaft unzustellbares Ereignis (der Empfaenger
 * weist es mit 400 ab, weil sein Aufbau nicht passt) wuerde die
 * Warteschlange sonst fuer immer blockieren und bei jedem Takt erneut
 * scheitern. Aufgeben heisst hier **nicht** loeschen — der Eintrag bleibt
 * mit seinem letzten Fehler stehen, denn ein verschwundenes Ereignis ist
 * von einem nie entstandenen nicht zu unterscheiden.
 */
const HOECHSTVERSUCHE = 20;

export class TcRueckkanalService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private laeuft = false;
  private readonly taktMs: number;
  private readonly buendelGroesse: number;

  constructor(
    private readonly store: SqliteStore,
    private readonly monitor: TradePlanMonitor,
    private readonly logger: Logger,
    private readonly config: RueckkanalConfig,
  ) {
    this.taktMs = config.taktMs ?? TAKT_VORGABE_MS;
    this.buendelGroesse = Math.min(
      config.buendelGroesse ?? BUENDEL_VORGABE,
      EMPFAENGER_HOECHSTZAHL,
    );
  }

  /** Ob der Kanal eingerichtet ist. Ohne Ziel wird nichts angelegt. */
  static istEingerichtet(url: string | undefined, token: string | undefined): boolean {
    return Boolean(url?.trim()) && Boolean(token?.trim());
  }

  starten(): void {
    if (this.timer !== null) return;

    // **Aufgegebenes zurueckholen, bevor der Takt anlaeuft.**
    //
    // Ein Neustart folgt fast immer auf einen Eingriff — und wenn der
    // den Fehler behoben hat, der zum Aufgeben fuehrte, sollen die
    // Ereignisse wieder laufen. Am 26.10.2026 scheiterten 29 Stueck an
    // einem fehlenden Stammdatensatz beim Empfaenger; nach dessen
    // Eintragen waeren alle durchgegangen, aber nichts holte sie zurueck.
    //
    // Nur behebbare Fehler (5xx, Timeout) — ein 4xx wird beim
    // einundzwanzigsten Versuch genauso scheitern wie beim ersten.
    const zurueckgeholt = this.store.rueckkanalWiederaufnehmen(HOECHSTVERSUCHE);
    if (zurueckgeholt > 0) {
      this.logger.warn(
        { anzahl: zurueckgeholt },
        'TC-Rueckkanal: aufgegebene Ereignisse wieder in die Warteschlange genommen — ' +
          'sie waren an einem Fehler des Empfaengers gescheitert',
      );
    }

    this.anschliessen();
    this.timer = setInterval(() => void this.warteschlangeLeeren(), this.taktMs);

    const zustand = this.zustand();
    this.logger.info(
      { ziel: this.config.url, taktMs: this.taktMs, offen: zustand.offen },
      'TC-Rueckkanal aktiv — Planereignisse werden gemeldet',
    );
    // Eine liegengebliebene Warteschlange gehoert beim Start gesagt,
    // nicht erst, wenn jemand danach sucht.
    if (zustand.aufgegeben > 0) {
      this.logger.error(
        { aufgegeben: zustand.aufgegeben, aeltestes: zustand.aeltestesIso },
        'TC-Rueckkanal: Ereignisse endgueltig aufgegeben (4xx) — TC-Synaptrix kennt ' +
          'diese Vorgaenge NICHT. Aufbau oder Token pruefen.',
      );
    }
  }

  beenden(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * An die Monitor-Ereignisse andocken.
   *
   * Der Monitor wird dafuer NICHT umgebaut: Er gibt seine Ereignisse
   * ohnehin aus, und ein Mithoerer kann nichts kaputt machen, was er
   * nicht anfasst. Haette der Rueckkanal in den Monitor hineingeschrieben,
   * waere jede Stoerung beim Melden eine Stoerung beim Handeln.
   */
  private anschliessen(): void {
    this.monitor.on('plan:activated', (planId: string) => {
      this.einreihen(planId, 'platziert', {});
    });

    // Bei allem, was die Position veraendert, geht ihr Stand mit.
    // Siehe `RueckkanalEreignis.position` — ohne ihn kann TC-Synaptrix
    // keinen Break-Even-Stop rechnen, der den Namen verdient.
    this.monitor.on(
      'plan:entry_filled',
      (planId: string, orderId: string, preis: number, menge: number) => {
        this.einreihen(planId, 'ausgefuehrt', {
          boersen_order_id: orderId || null,
          preis: zahlAlsText(preis),
          menge: zahlAlsText(menge),
          position: this.positionsStand(planId),
        });
      },
    );

    this.monitor.on('plan:tp_hit', (planId: string, index: number, preis: number) => {
      this.einreihen(planId, 'tp_getroffen', {
        preis: zahlAlsText(preis),
        grund: `Ziel ${index + 1} erreicht`,
        position: this.positionsStand(planId),
      });
    });

    this.monitor.on('plan:sl_hit', (planId: string, preis: number) => {
      this.einreihen(planId, 'sl_getroffen', {
        preis: zahlAlsText(preis),
        position: this.positionsStand(planId),
      });
    });

    this.monitor.on('plan:completed', (planId: string) => {
      this.einreihen(planId, 'position_geschlossen', {
        position: this.positionsStand(planId),
      });
    });

    this.monitor.on('plan:cancelled', (planId: string) => {
      this.einreihen(planId, 'storniert', { grund: 'Plan zurueckgenommen' });
    });

    // Ein Fehler ist eine Nicht-Ausfuehrung, und die ist genauso zu
    // melden wie eine Ausfuehrung: Kommt nichts an, haelt TC-Synaptrix
    // den Plan fuer offen und rechnet ihn weder als Treffer noch als
    // Fehlschlag. Die Trefferquote wird dadurch nicht falsch, sondern
    // unvollstaendig — und das ist schlimmer, weil sie wie eine Messung
    // aussieht.
    this.monitor.on('plan:error', (planId: string, fehler: string) => {
      this.einreihen(planId, 'uebersprungen', { grund: fehler });
    });
  }

  /**
   * Den Stand der Position aus den Orders rechnen.
   *
   * Aus den Orders, nicht aus dem Monitor-Zustand: Die Orders sind das
   * einzige, was ueberlebt — einen Neustart ebenso wie das Ende des
   * Plans. Dieselbe Quelle, aus der auch `ErgebnisService` und
   * `TradePlanMonitor.offenePosition()` rechnen.
   *
   * Scheitert die Rechnung, gibt es `null` statt einer halben Wahrheit.
   * Ein Ereignis ohne Positionsangabe ist fuer TC-Synaptrix lesbar; ein
   * Ereignis mit falscher waere es nicht.
   */
  private positionsStand(planId: string): RueckkanalPosition | null {
    try {
      const orders = this.store.getPlanOrders(planId);

      let eingestiegen = 0;
      let einstiegsWert = 0;
      let geschlossen = 0;
      let einstiegeGesamt = 0;
      let einstiegeGefuellt = 0;

      for (const o of orders) {
        const gefuellt = Number(o.filled_quantity ?? 0);
        const preis = Number(o.avg_fill_price ?? 0);

        if (o.role === 'entry') {
          einstiegeGesamt += 1;
          if (gefuellt > 0) {
            einstiegeGefuellt += 1;
            eingestiegen += gefuellt;
            // Ohne Fuellpreis nicht gewichtbar — die Menge zaehlt
            // trotzdem, denn sie steht im Markt.
            if (preis > 0) einstiegsWert += gefuellt * preis;
          }
        } else if (
          o.role === 'take_profit' || o.role === 'stop_loss' || o.role === 'trailing_stop'
        ) {
          if (gefuellt > 0) geschlossen += gefuellt;
        }
      }

      if (einstiegeGesamt === 0) return null;

      // Rechenrauschen abschneiden, wie im Monitor.
      //
      // 5.45596275 - 1.36399069 - 4.09197206 ergibt in IEEE-754 nicht
      // null, sondern 8,88e-16. Gemeldet wuerde daraus eine Position,
      // die offen aussieht, obwohl sie zu ist — und TC-Synaptrix
      // wartete auf einen Abschluss, der nie kaeme.
      const roh = eingestiegen - geschlossen;
      const offen = roh > 1e-9 ? Number(roh.toFixed(10)) : 0;
      const einstand = eingestiegen > 0 && einstiegsWert > 0
        ? einstiegsWert / eingestiegen
        : null;

      // Sind die Mengen nicht darstellbar — NaN aus einer beschaedigten
      // Order —, ist der ganze Stand unbrauchbar. Dann lieber gar keine
      // Angabe: Eine Position mit "0 offen" wuerde TC-Synaptrix fuer
      // geschlossen halten.
      const eingestiegenText = zahlAlsText(eingestiegen);
      const offenText = zahlAlsText(offen);
      if (eingestiegenText == null || offenText == null) return null;

      return {
        einstand: zahlAlsText(einstand),
        eingestiegen: eingestiegenText,
        offen: offenText,
        einstiege_gefuellt: einstiegeGefuellt,
        einstiege_gesamt: einstiegeGesamt,
      };
    } catch (err) {
      this.logger.warn({ err, planId }, 'Positionsstand fuer den Rueckkanal nicht ermittelbar');
      return null;
    }
  }

  /**
   * Ein Ereignis in die Warteschlange legen.
   *
   * Synchron und ohne Netz: Der Monitor darf durch eine langsame
   * Gegenstelle nicht aufgehalten werden. Gesendet wird im eigenen Takt.
   */
  private einreihen(
    planId: string,
    art: RueckkanalArt,
    felder: Partial<Omit<RueckkanalEreignis, 'ereignis_id' | 'signal_id' | 'plan_id' | 'art'>>,
  ): void {
    try {
      const signalKennung = this.store.getSignalKennungZuPlan(planId);
      // Plaene ohne Signalherkunft (von Hand angelegt, aus dem Journal
      // gespiegelt) gehoeren nicht in diesen Kanal: TC-Synaptrix kennt
      // sie nicht, und ein Ereignis ohne Gegenstueck erzeugte dort einen
      // Datensatz, der nie zugeordnet wird.
      if (!signalKennung) return;

      this.store.rueckkanalEinreihen({
        ereignis_id: `bot-${randomUUID()}`,
        signal_id: signalKennung,
        plan_id: planId,
        art,
        zeitpunkt: new Date().toISOString(),
        boerse: this.config.boerse,
        boersen_order_id: felder.boersen_order_id ?? null,
        preis: felder.preis ?? null,
        menge: felder.menge ?? null,
        gebuehr: felder.gebuehr ?? null,
        gebuehr_waehrung: felder.gebuehr_waehrung ?? null,
        grund: felder.grund ?? null,
        position: felder.position ?? null,
      });
    } catch (err) {
      // Lauter Fehler, aber kein Abbruch: Der Handel laeuft weiter, auch
      // wenn die Meldung nicht angelegt werden konnte. Still waere es
      // falsch — dann fehlte ein Ereignis, ohne dass irgendwo etwas
      // fehlt aussieht.
      this.logger.error({ err, planId, art }, 'Rueckkanal: Ereignis nicht einreihbar');
    }
  }

  /**
   * Alles Offene senden.
   *
   * Oeffentlich, damit das Herunterfahren noch einmal leeren kann —
   * sonst laegen die letzten Ereignisse bis zum naechsten Start.
   */
  async warteschlangeLeeren(): Promise<void> {
    // Kein zweiter Durchgang auf demselben Vorrat: Zwei gleichzeitige
    // Sendungen schickten dieselben Ereignisse doppelt. Der Empfaenger
    // faengt das ab, aber der Umweg ist vermeidbar.
    if (this.laeuft) return;
    this.laeuft = true;
    try {
      const offene = this.store.rueckkanalOffene(this.buendelGroesse, HOECHSTVERSUCHE);
      if (offene.length === 0) return;

      const antwort = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ ereignisse: offene.map((o) => o.ereignis) }),
        signal: AbortSignal.timeout(15_000),
      });

      if (antwort.status === 202) {
        this.store.rueckkanalErledigen(offene.map((o) => o.id));
        this.logger.debug({ anzahl: offene.length }, 'Rueckkanal: Ereignisse uebergeben');
        return;
      }

      // 400 und 401 sind endgueltig: Ein fehlerhafter Aufbau wird beim
      // zweiten Versuch genauso fehlerhaft sein, ein falsches Token
      // genauso falsch. Weiter zu versuchen hiesse, den Kanal mit einer
      // Sendung zu blockieren, die nie durchgeht.
      const text = await antwort.text().catch(() => '');
      const endgueltig = antwort.status === 400 || antwort.status === 401;
      this.store.rueckkanalFehlschlag(
        offene.map((o) => o.id),
        `HTTP ${antwort.status}: ${text.slice(0, 300)}`,
        endgueltig,
      );
      this.logger.warn(
        { status: antwort.status, antwort: text.slice(0, 300), anzahl: offene.length, endgueltig },
        'Rueckkanal: Sendung abgewiesen',
      );
    } catch (err) {
      // Netzfehler: nicht endgueltig. Der Empfaenger startet vielleicht
      // gerade neu, und ein Ereignis, das deshalb verloren geht, fehlt
      // fuer immer.
      const meldung = err instanceof Error ? err.message : String(err);
      this.store.rueckkanalFehlschlagAlle(meldung);
      this.logger.warn({ err }, 'Rueckkanal: Sendung gescheitert, wird wiederholt');
    } finally {
      this.laeuft = false;
    }
  }

  /** Fuer die Betriebsauskunft: Wie viel liegt, und wie lange schon. */
  zustand(): { offen: number; aufgegeben: number; aeltestesIso: string | null } {
    return this.store.rueckkanalZustand(HOECHSTVERSUCHE);
  }
}

/**
 * Eine Zahl als Text, ohne Exponentialschreibweise.
 *
 * `(0.00000001).toString()` liefert `"1e-8"` — der Empfaenger weist das
 * als "keine Zahl" ab, denn sein Muster erlaubt nur Ziffern und einen
 * Punkt. Bei Mengen mit acht Nachkommastellen ist das kein Randfall.
 *
 * **`toFixed` ist hier der falsche erste Griff**, und das ist gemessen:
 * `(80659.4).toFixed(12)` ergibt `"80659.399999999994"` — es macht die
 * IEEE-754-Darstellung sichtbar, statt sie zu verbergen. Aus einem
 * Fuellpreis wuerde eine Zahl, die so nie gehandelt wurde.
 *
 * Richtig ist die kuerzeste exakte Darstellung (`String`), und `toFixed`
 * nur dort, wo sie einen Exponenten liefert — also bei sehr kleinen
 * Mengen, wo die zusaetzlichen Stellen tatsaechlich Nullen sind.
 */
export function zahlAlsText(wert: number | null | undefined): string | null {
  if (wert === null || wert === undefined || !Number.isFinite(wert)) return null;

  const kurz = String(wert);
  if (!kurz.includes('e') && !kurz.includes('E')) return kurz;

  // Exponent aufloesen. 20 Stellen ist die Obergrenze von `toFixed` und
  // reicht fuer jede Boersenmenge; nachlaufende Nullen fallen weg.
  const lang = wert.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return lang === '' || lang === '-' ? '0' : lang;
}
