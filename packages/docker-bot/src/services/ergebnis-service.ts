// ============================================================
// Was hat ein Plan eingebracht?
//
// Gerechnet wird aus den tatsaechlich abgeschickten Orders
// (bot_trade_plan_orders) — nicht aus dem Plan und nicht aus dem
// Zustand im Arbeitsspeicher. Der Plan sagt nur, was vorgesehen war;
// der Zustand kennt nur das Jetzt. Die Orders sind das einzige, was
// festhaelt, was wirklich geschah, und sie bleiben auch nach dem
// Abschluss des Plans erhalten.
//
// WICHTIG — die Grenzen dieser Zahl:
//
// Sie ist die Rechnung des Bots, nicht die der Boerse. Was an
// Teilfuellungen, Finanzierungskosten oder Abweichungen beim
// Ausfuehrungspreis hinzukommt, weiss allein die Boerse. Massgeblich
// fuer die Buchhaltung ist deshalb der API-Import des Journals (siehe
// CLAUDE.md, Regel 1) — diese Zahl ist zum Hinsehen da, nicht zum
// Abrechnen.
// ============================================================

import type { SqliteStore } from '../store/sqlite-store.js';

export interface Ergebnis {
  planId: string;

  /** Tatsaechlich eingestiegene Menge (Summe der gefuellten Einstiege). */
  eingestiegen: number;
  /** Durchschnittlicher Einstiegspreis der gefuellten Einstiege. */
  einstiegsPreis: number | null;

  /**
   * Wieviele Einstiegs-Orders abgeschickt wurden — und wieviele davon
   * gefuellt sind.
   *
   * Die Menge allein sagt das nicht: Bei einem gestaffelten Einstieg
   * sieht "die Haelfte der geplanten Menge" genauso aus, ob nun zwei von
   * vier Teil-Orders ganz oder vier zur Haelfte gefuellt wurden. Fuer
   * die Frage, wo der Trade gerade steht, ist die Zahl der Stufen die
   * aussagekraeftigere.
   */
  einstiegeAbgeschickt: number;
  einstiegeGefuellt: number;
  /** Wieder geschlossene Menge (Take-Profits, Stop, Trailing). */
  geschlossen: number;
  /** Was davon noch offen im Markt steht. */
  offen: number;

  /**
   * Eingesetzte Margin der gefuellten Einstiege (Wert / Hebel).
   *
   * Die Margin ueber die Lebensdauer des Trades — der bereits wieder
   * geschlossene Teil zaehlt mit, denn er WAR eingesetzt. Das ist die
   * Bezugsgroesse der Rendite. Was gerade noch gebunden ist, steht in
   * `einsatzOffen`.
   */
  einsatz: number | null;

  /**
   * Margin, die gerade noch im Markt gebunden ist (offene Menge / Hebel).
   *
   * Nicht dasselbe wie `einsatz`: Nach einem Take-Profit ist ein Teil
   * wieder frei. Fuers Dashboard ("wieviel Kapital liegt fest?") zaehlt
   * diese Zahl, fuer die Rendite die andere — sie zu verwechseln
   * ergaebe bei einem halb geschlossenen Trade die doppelte Rendite.
   */
  einsatzOffen: number | null;

  /** Realisiertes Ergebnis der geschlossenen Menge, vor Gebuehren. */
  realisiertBrutto: number;
  /** Angefallene Gebuehren aller Orders. */
  gebuehren: number;

  /**
   * Wieviele gefuellte Orders es gibt — und wieviele davon eine Gebuehr
   * melden.
   *
   * Ohne diese beiden Zahlen ist `gebuehren` nicht lesbar: Die Spalte
   * steht auf `DEFAULT 0`, und der Monitor schreibt sie nur, wenn die
   * Boerse sie zurueckgibt. Eine nicht gemeldete Gebuehr sieht damit
   * aus wie eine Gebuehr von null. Bei einem SOLUSDT-Short standen so
   * 0,22 USDT auf 9.078 USDT Umsatz — 0,002 %, also weit unter jedem
   * Taker-Satz — und die Oberflaeche zeigte es als Gesamtsumme.
   */
  fuellungen: number;
  fuellungenMitGebuehr: number;

  /** Realisiert nach Abzug der Gebuehren — die Zahl, auf die es ankommt. */
  realisiert: number;

  /**
   * Nicht realisiertes Ergebnis der offenen Menge zum uebergebenen Kurs.
   * `null`, wenn nichts offen ist oder kein Kurs vorliegt.
   */
  unrealisiert: number | null;
  /** Kurs, mit dem `unrealisiert` gerechnet wurde. */
  kurs: number | null;

  /** realisiert + unrealisiert. */
  gesamt: number;
  /** Gesamt bezogen auf den Einsatz, in Prozent. `null` ohne Einsatz. */
  renditePct: number | null;

  /** Waehrung der Gebuehren, soweit die Orders sie nennen. */
  waehrung: string | null;
}

const AUSSTIEGS_ROLLEN = new Set(['take_profit', 'stop_loss', 'trailing_stop']);

export class ErgebnisService {
  constructor(private readonly store: SqliteStore) {}

  /**
   * Das Ergebnis eines Plans.
   *
   * `kurs` wird fuer das nicht realisierte Ergebnis gebraucht und kommt
   * vom Monitor. Fehlt er, bleibt nur das realisierte stehen — lieber
   * eine Luecke als eine erfundene Zahl.
   */
  fuerPlan(planId: string, richtung: 'long' | 'short', hebel: number, kurs?: number | null): Ergebnis {
    const orders = this.store.getPlanOrders(planId);

    let eingestiegen = 0;
    let einstiegsWert = 0;
    let geschlossen = 0;
    let ausstiegsWert = 0;
    let gebuehren = 0;
    let waehrung: string | null = null;
    let einstiegeAbgeschickt = 0;
    let einstiegeGefuellt = 0;
    let fuellungen = 0;
    let fuellungenMitGebuehr = 0;

    for (const o of orders) {
      const menge = zahl(o.filled_quantity);
      const preis = zahl(o.avg_fill_price);

      // Gezaehlt wird vor dem Ausstieg unten, sonst blieben
      // zurueckgenommene Einstiege ungezaehlt — und gerade sie sind die
      // Antwort auf "warum wurde nicht die ganze Groesse gekauft?".
      if (o.role === 'entry') {
        einstiegeAbgeschickt += 1;
        if (menge > 0) einstiegeGefuellt += 1;
      }

      // Gebuehren fallen auch auf Orders an, die nur teilweise gefuellt
      // wurden — sie werden unabhaengig von der Menge gezaehlt.
      const gebuehr = zahl(o.fees);
      gebuehren += gebuehr;
      if (!waehrung && typeof o.fee_currency === 'string' && o.fee_currency) {
        waehrung = o.fee_currency;
      }

      // Gezaehlt wird, wovon tatsaechlich etwas gefuellt wurde: Nur
      // dort MUSS eine Gebuehr angefallen sein, und nur dort ist ihr
      // Fehlen eine Luecke statt einer Selbstverstaendlichkeit.
      if (menge > 0) {
        fuellungen += 1;
        if (gebuehr > 0) fuellungenMitGebuehr += 1;
      }

      // Ohne Fuellpreis laesst sich nichts rechnen. Die Menge trotzdem
      // mitzuzaehlen wuerde den Durchschnitt verfaelschen.
      if (menge <= 0 || preis <= 0) continue;

      if (o.role === 'entry') {
        eingestiegen += menge;
        einstiegsWert += menge * preis;
      } else if (AUSSTIEGS_ROLLEN.has(String(o.role))) {
        geschlossen += menge;
        ausstiegsWert += menge * preis;
      }
    }

    const einstiegsPreis = eingestiegen > 0 ? einstiegsWert / eingestiegen : null;
    const offen = runden(Math.max(0, eingestiegen - geschlossen));

    // Beim Long ist der Einstieg ein Kauf und der Ausstieg ein Verkauf,
    // beim Short umgekehrt — das Vorzeichen dreht sich mit.
    // Auf SHORT geprueft, nicht auf LONG.
    //
    // Der Unterschied zeigt sich nur bei einem unerwarteten Wert — und
    // genau dann ist er gefaehrlich: Hier stand `=== 'long' ? 1 : -1`,
    // womit alles, was nicht buchstabengenau 'long' heisst, als SHORT
    // gerechnet wurde. Alle anderen Stellen im Bot normalisieren
    // umgekehrt (`=== 'short' ? 'short' : 'long'`). Ein 'LONG' aus
    // einer fremden Quelle haette hier das umgekehrte Vorzeichen
    // ergeben wie im Dashboard — dieselbe Position, zwei Wahrheiten.
    const vorzeichen = richtung === 'short' ? -1 : 1;

    const realisiertBrutto = einstiegsPreis != null && geschlossen > 0
      ? vorzeichen * (ausstiegsWert - einstiegsPreis * geschlossen)
      : 0;

    // Die Gebuehren werden in voller Hoehe abgezogen, auch die auf die
    // noch offene Menge: Gezahlt ist gezahlt. Wer das Brutto sehen will,
    // findet es daneben.
    const realisiert = realisiertBrutto - gebuehren;

    const unrealisiert = (offen > 0 && einstiegsPreis != null && kurs != null && kurs > 0)
      ? vorzeichen * (kurs - einstiegsPreis) * offen
      : null;

    const sicherHebel = hebel > 0 ? hebel : 1;
    const einsatz = einstiegsPreis != null ? einstiegsWert / sicherHebel : null;

    // Was noch gebunden ist — zum Einstiegspreis, nicht zum aktuellen
    // Kurs: Die Margin wurde beim Einstieg gestellt und wandert nicht
    // mit dem Kurs. Dieselbe Formel stand bisher in dashboard.ts von
    // Hand; sie gehoert hierher, damit es eine Fassung bleibt.
    const einsatzOffen = einstiegsPreis != null && offen > 0
      ? (offen * einstiegsPreis) / sicherHebel
      : null;

    const gesamt = realisiert + (unrealisiert ?? 0);
    const renditePct = einsatz != null && einsatz > 0 ? (gesamt / einsatz) * 100 : null;

    return {
      planId,
      eingestiegen: runden(eingestiegen),
      einstiegsPreis,
      einstiegeAbgeschickt,
      einstiegeGefuellt,
      geschlossen: runden(geschlossen),
      offen,
      einsatz: einsatz != null ? geld(einsatz) : null,
      einsatzOffen: einsatzOffen != null ? geld(einsatzOffen) : null,
      realisiertBrutto: geld(realisiertBrutto),
      gebuehren: geld(gebuehren),
      fuellungen,
      fuellungenMitGebuehr,
      realisiert: geld(realisiert),
      unrealisiert: unrealisiert != null ? geld(unrealisiert) : null,
      kurs: kurs ?? null,
      gesamt: geld(gesamt),
      renditePct: renditePct != null ? Math.round(renditePct * 100) / 100 : null,
      waehrung,
    };
  }
}

function zahl(wert: unknown): number {
  const n = Number(wert ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Mengen: Rechenrauschen abschneiden, wie im Monitor ueblich. */
function runden(menge: number): number {
  return menge > 1e-9 ? Number(menge.toFixed(10)) : 0;
}

/** Betraege auf Cent. */
function geld(betrag: number): number {
  return Math.round(betrag * 100) / 100;
}
