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
  /** Wieder geschlossene Menge (Take-Profits, Stop, Trailing). */
  geschlossen: number;
  /** Was davon noch offen im Markt steht. */
  offen: number;

  /** Eingesetzte Margin der gefuellten Einstiege (Wert / Hebel). */
  einsatz: number | null;

  /** Realisiertes Ergebnis der geschlossenen Menge, vor Gebuehren. */
  realisiertBrutto: number;
  /** Angefallene Gebuehren aller Orders. */
  gebuehren: number;
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

    for (const o of orders) {
      const menge = zahl(o.filled_quantity);
      const preis = zahl(o.avg_fill_price);

      // Gebuehren fallen auch auf Orders an, die nur teilweise gefuellt
      // wurden — sie werden unabhaengig von der Menge gezaehlt.
      gebuehren += zahl(o.fees);
      if (!waehrung && typeof o.fee_currency === 'string' && o.fee_currency) {
        waehrung = o.fee_currency;
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
    const vorzeichen = richtung === 'long' ? 1 : -1;

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

    const gesamt = realisiert + (unrealisiert ?? 0);
    const renditePct = einsatz != null && einsatz > 0 ? (gesamt / einsatz) * 100 : null;

    return {
      planId,
      eingestiegen: runden(eingestiegen),
      einstiegsPreis,
      geschlossen: runden(geschlossen),
      offen,
      einsatz: einsatz != null ? geld(einsatz) : null,
      realisiertBrutto: geld(realisiertBrutto),
      gebuehren: geld(gebuehren),
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
