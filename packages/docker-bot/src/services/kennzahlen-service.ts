// ============================================================
// Wie gut ist der Signalgeber?
//
// Die Frage, auf die der ganze Uebungsbetrieb hinauslaeuft — und sie
// laesst sich nicht aus einer Summe beantworten. Ein Konto, das um
// 200 USDT gewachsen ist, kann aus zwanzig kleinen Gewinnen und einem
// grossen Verlust bestehen oder umgekehrt. Das eine ist eine
// Strategie, das andere Glueck.
//
// Gerechnet wird in R.
// ============================================================
//
// R ist das Risiko, das ein Trade am Stop-Loss eingeht. Die Signale
// dieses Bots riskieren durchweg 1 % des Referenzkapitals — in den
// Herkunftsdaten steht `scaled_risk` genau dafuer. Ein Trade, der
// +2,5 R brachte, hat das Zweieinhalbfache seines Einsatzrisikos
// verdient.
//
// Erst das macht ungleiche Trades vergleichbar: BTCUSDT mit Hebel 20
// und XRPUSDT mit Hebel 7 stehen in USDT auf voellig verschiedenen
// Skalen, in R auf derselben. Und der Erwartungswert in R sagt
// unmittelbar, ob eine Strategie traegt — unabhaengig davon, wie gross
// gehandelt wird.
// ============================================================

import type { SqliteStore } from '../store/sqlite-store.js';
import { ErgebnisService } from './ergebnis-service.js';

/** Ein abgeschlossener Trade, in R gemessen. */
export interface TradeInR {
  planId: string;
  symbol: string;
  richtung: 'long' | 'short';
  strategie: string;
  signalId: string;

  /**
   * Die Boerse, auf der dieser Trade lief.
   *
   * Noetig, um die Leistung je Boerse auszuweisen. Bisher stand sie
   * nur im Plan und wurde allein fuer die Kerzenabfrage gelesen —
   * damit liess sich nicht beantworten, ob Phemex besser laeuft als
   * Bybit.
   */
  boerse: string;

  /**
   * Woher der Plan kam: `tc`, `local` oder `signal`.
   *
   * Zusammen mit `strategie` ergibt das die Signalquelle. Ein
   * `signal`-Plan von Synaptrix und einer von TradingView
   * unterscheiden sich nur im Strategienamen.
   */
  quelle: string;

  /**
   * Lief dieser Trade im Uebungsbetrieb?
   *
   * **Uebungs- und Echtergebnisse duerfen nicht addiert werden.** Die
   * Summe aus beidem ist eine Zahl ohne Bedeutung: Das eine ist
   * Kapital, das andere eine Behauptung darueber, was geschehen
   * waere. Die Auswertung weist sie deshalb getrennt aus.
   */
  uebung: boolean;

  /** Wann der erste Einstieg gefuellt wurde. */
  begonnen: string | null;
  /** Wann zuletzt geschlossen wurde. */
  beendet: string | null;
  /** Haltedauer in Minuten, soweit beides bekannt ist. */
  dauerMinuten: number | null;

  /** Tatsaechlich eingestiegene Menge. */
  menge: number;
  /** Durchschnittlicher Einstiegspreis. */
  einstiegsPreis: number | null;

  /** Das eingegangene Risiko in Quote-Waehrung — ein R. */
  risiko: number | null;
  /** Realisiertes Ergebnis nach Gebuehren. */
  ergebnis: number;
  /** Ergebnis geteilt durch das Risiko. `null`, wenn R unbekannt ist. */
  rVielfaches: number | null;

  /** Wieviele Take-Profits griffen. */
  tpsErreicht: number;
  slGetroffen: boolean;
}

export interface Kennzahlen {
  trades: number;
  gewinner: number;
  verlierer: number;
  /** Anteil der Gewinner, in Prozent. */
  trefferquote: number;

  /** Summe aller Gewinne (brutto, nach Gebuehren). */
  bruttoGewinn: number;
  /** Summe aller Verluste, als positive Zahl. */
  bruttoVerlust: number;
  /**
   * Bruttogewinn geteilt durch Bruttoverlust.
   *
   * Die eine Zahl, die sagt, ob eine Strategie traegt: ueber 1 bringt
   * sie mehr ein, als sie kostet. `null`, wenn es keine Verluste gibt —
   * dann ist sie nicht aussagekraeftig, sondern unendlich.
   */
  profitFactor: number | null;

  /** Ergebnis insgesamt. */
  ergebnis: number;

  /** Durchschnittliches R-Vielfaches je Trade — der Erwartungswert. */
  erwartungswertR: number | null;
  /** Durchschnitt der Gewinner in R. */
  schnittGewinnR: number | null;
  /** Durchschnitt der Verlierer in R (negativ). */
  schnittVerlustR: number | null;
  /**
   * Verhaeltnis von durchschnittlichem Gewinn zu durchschnittlichem
   * Verlust. Eine Strategie mit 40 % Treffern braucht mindestens 1,5,
   * um aufzugehen.
   */
  payoffRatio: number | null;

  bestesR: number | null;
  schlechtestesR: number | null;

  /** Summe aller R-Vielfachen — das Gesamtergebnis in R. */
  summeR: number | null;
  /** Wieviele Trades ein bekanntes Risiko trugen. */
  mitRisiko: number;

  /** Durchschnittliche Haltedauer in Minuten. */
  schnittDauerMinuten: number | null;
}

/** Ein Punkt der Kontoverlaufs-Kurve. */
/** Kennzahlen einer Gruppe — je Boerse, Quelle oder Strategie. */
export interface Gruppenzahl {
  name: string;
  nach: 'boerse' | 'quelle' | 'strategie';
  /** Uebten ALLE Trades dieser Gruppe? Dann nicht mit echten mischen. */
  uebung: boolean;
  /** Auf welchen Boersen lief diese Gruppe? Bei `nach: 'boerse'` genau eine. */
  boersen: string[];
  kennzahlen: Kennzahlen;
}

/** Ergebnis eines Kalendertags. */
export interface Tageszahl {
  /** YYYY-MM-DD, der Tag des Schliessens. */
  tag: string;
  trades: number;
  gewinner: number;
  /** Realisiertes Ergebnis in Quote-Waehrung. */
  ergebnis: number;
  /** Ergebnis bezogen auf das an diesem Tag eingegangene Risiko. */
  roiPct: number | null;
  /** Summe der R-Vielfachen, soweit bekannt. */
  summeR: number | null;
  uebung: boolean;
}

export interface EquityPunkt {
  zeitpunkt: string;
  /** Kontostand nach dieser Buchung. */
  stand: number;
  /** Was diese Buchung beitrug. */
  veraenderung: number;
  art: string;
  symbol: string | null;
}

export interface EquityVerlauf {
  punkte: EquityPunkt[];
  startkapital: number;
  endstand: number;

  /**
   * Groesster Rueckgang vom bisherigen Hoechststand, in Prozent.
   *
   * Aus der KURVE gerechnet, nicht aus Tagessummen: Ein Verlust von
   * 8 % am Vormittag, der bis zum Abend aufgeholt wird, taucht in der
   * Tagesbilanz nicht auf — im Kontoverlauf schon. Und er ist es, der
   * einen Handelsplan in der Wirklichkeit zu Fall bringt.
   */
  maxDrawdownPct: number;
  /** Derselbe Rueckgang in Quote-Waehrung. */
  maxDrawdown: number;
  /** Hoechststand, von dem aus der groesste Rueckgang begann. */
  drawdownVon: number;
  /** Tiefpunkt des groessten Rueckgangs. */
  drawdownBis: number;

  /** Laengste Folge von Verlust-Trades hintereinander. */
  laengsteVerlustserie: number;
  /** Laengste Folge von Gewinn-Trades. */
  laengsteGewinnserie: number;
}

const AUSSTIEGS_ROLLEN = new Set(['take_profit', 'stop_loss', 'trailing_stop']);

export class KennzahlenService {
  private readonly ergebnisService: ErgebnisService;

  constructor(private readonly store: SqliteStore) {
    this.ergebnisService = new ErgebnisService(store);
  }

  /**
   * Alle abgeschlossenen Trades, in R gemessen.
   *
   * "Abgeschlossen" heisst: eingestiegen und wieder geschlossen. Ein
   * laufender Trade hat noch kein Ergebnis, und ein nie eingestiegener
   * gar keines — beide wuerden den Durchschnitt verfaelschen.
   */
  trades(): TradeInR[] {
    const liste: TradeInR[] = [];

    for (const bp of this.store.getBotTradePlans({})) {
      const planId = String(bp.id);
      const richtung: 'long' | 'short' = bp.direction === 'short' ? 'short' : 'long';
      const hebel = Number(bp.leverage) || 1;

      const e = this.ergebnisService.fuerPlan(planId, richtung, hebel, null);
      if (e.eingestiegen <= 0 || e.geschlossen <= 0) continue;

      const orders = this.store.getPlanOrders(planId);
      const herkunft = sicherParsen(bp.signal_origin) as {
        strategy?: string; signal_id?: string; scaled_risk?: number;
      } | null;

      const risiko = this.risikoVon(bp, herkunft, e.einstiegsPreis, e.eingestiegen);
      const begonnen = this.ersteFuellung(orders, 'entry');
      const beendet = this.letzteFuellung(orders);

      // 'unknown' liefert die Journal-Schnittstelle ohne zugeordnetes
      // Konto; leer bleibt es bei von Hand angelegten Plaenen.
      const boerseRoh = String(bp.exchange ?? '').trim().toLowerCase();
      const boerse = !boerseRoh || boerseRoh === 'unknown' ? 'paper' : boerseRoh;

      liste.push({
        planId,
        symbol: String(bp.symbol),
        richtung,
        strategie: String(herkunft?.strategy ?? '–'),
        signalId: String(herkunft?.signal_id ?? '–'),
        boerse,
        quelle: String(bp.source ?? 'local'),
        // Der Uebungsbroker laeuft unter 'paper'. Eine Boerse, die in
        // den Einstellungen auf Uebung steht, traegt ihren eigenen
        // Namen — dort kommt die Unterscheidung aus
        // `boersen_einstellung`, nicht aus dem Plan.
        uebung: boerse === 'paper' || this.store.boerseUebt(boerse),
        begonnen,
        beendet,
        dauerMinuten: minutenZwischen(begonnen, beendet),
        menge: e.eingestiegen,
        einstiegsPreis: e.einstiegsPreis,
        risiko,
        ergebnis: e.realisiert,
        rVielfaches: risiko != null && risiko > 0
          ? Math.round((e.realisiert / risiko) * 1000) / 1000
          : null,
        tpsErreicht: orders.filter(o =>
          o.role === 'take_profit' && (Number(o.filled_quantity) || 0) > 0).length,
        slGetroffen: orders.some(o =>
          (o.role === 'stop_loss' || o.role === 'trailing_stop') &&
          (Number(o.filled_quantity) || 0) > 0),
      });
    }

    liste.sort((a, b) => String(b.beendet ?? '').localeCompare(String(a.beendet ?? '')));
    return liste;
  }

  /**
   * Dieselben Kennzahlen, aufgeteilt nach einem Merkmal.
   *
   * Beantwortet die Frage, die sich mit mehreren Boersen und
   * Signalgebern zuerst stellt: **Welche laufen gut?** Die
   * Gesamtzahlen sagen das nicht — eine gute und eine schlechte
   * Quelle ergeben zusammen eine mittelmaessige.
   *
   * Gerechnet wird je Gruppe mit derselben Methode wie fuers Ganze;
   * es gibt keine zweite Rechnung, die auseinanderlaufen koennte.
   *
   * **Uebung und Echthandel werden nicht vermischt.** Jede Gruppe
   * traegt `uebung`, und die Oberflaeche weist sie getrennt aus. Die
   * Summe aus beidem waere eine Zahl ohne Bedeutung.
   *
   * Sortiert nach Ergebnis, absteigend — die Frage ist fast immer
   * "was laeuft am besten?".
   */
  gruppiert(trades: TradeInR[], nach: 'boerse' | 'quelle' | 'strategie'): Gruppenzahl[] {
    const koerbe = new Map<string, TradeInR[]>();

    for (const t of trades) {
      const schluessel = nach === 'boerse' ? t.boerse
        : nach === 'quelle' ? t.quelle
          : t.strategie;
      const korb = koerbe.get(schluessel);
      if (korb) korb.push(t); else koerbe.set(schluessel, [t]);
    }

    const gruppen: Gruppenzahl[] = [];
    for (const [name, eigene] of koerbe) {
      gruppen.push({
        name,
        nach,
        // Eine Gruppe gilt als Uebung, wenn ALLE ihre Trades uebten.
        // Gemischt kommt vor, wenn eine Boerse zwischendurch
        // umgestellt wurde — dann ist sie keine Uebungsgruppe mehr.
        uebung: eigene.every(t => t.uebung),
        boersen: [...new Set(eigene.map(t => t.boerse))].sort(),
        kennzahlen: this.kennzahlen(eigene),
      });
    }

    return gruppen.sort((a, b) => b.kennzahlen.ergebnis - a.kennzahlen.ergebnis);
  }

  /**
   * Ergebnis je Kalendertag.
   *
   * Grundlage der Kalenderansicht. Ein Tag ist der Tag, an dem ein
   * Trade **geschlossen** wurde — dann wurde sein Ergebnis
   * realisiert. Der Einstieg kann Tage zurueckliegen.
   *
   * `roiPct` bezieht das Ergebnis auf das an diesem Tag eingegangene
   * Risiko. Die beiden Zahlen beantworten verschiedene Fragen: Die
   * Summe sagt, was herauskam; der Prozentwert, ob der Einsatz es
   * wert war.
   */
  jeTag(trades: TradeInR[]): Tageszahl[] {
    const tage = new Map<string, TradeInR[]>();

    for (const t of trades) {
      if (!t.beendet) continue;
      const tag = String(t.beendet).slice(0, 10);   // YYYY-MM-DD
      const liste = tage.get(tag);
      if (liste) liste.push(t); else tage.set(tag, [t]);
    }

    const ergebnis: Tageszahl[] = [];
    for (const [tag, eigene] of tage) {
      const summe = eigene.reduce((s, t) => s + t.ergebnis, 0);
      const risiko = eigene.reduce((s, t) => s + (t.risiko ?? 0), 0);
      const mitR = eigene.filter(t => t.rVielfaches != null);

      ergebnis.push({
        tag,
        trades: eigene.length,
        gewinner: eigene.filter(t => t.ergebnis > 0).length,
        ergebnis: runde2w(summe),
        // Ohne bekanntes Risiko keine Prozentangabe — eine erfundene
        // Bezugsgroesse waere schlechter als gar keine.
        roiPct: risiko > 0 ? runde2w((summe / risiko) * 100) : null,
        summeR: mitR.length > 0
          ? runde2w(mitR.reduce((s, t) => s + (t.rVielfaches ?? 0), 0))
          : null,
        uebung: eigene.every(t => t.uebung),
      });
    }

    return ergebnis.sort((a, b) => a.tag.localeCompare(b.tag));
  }

  /** Die Kennzahlen ueber eine Menge von Trades. */
  kennzahlen(trades: TradeInR[]): Kennzahlen {
    const leer: Kennzahlen = {
      trades: 0, gewinner: 0, verlierer: 0, trefferquote: 0,
      bruttoGewinn: 0, bruttoVerlust: 0, profitFactor: null, ergebnis: 0,
      erwartungswertR: null, schnittGewinnR: null, schnittVerlustR: null,
      payoffRatio: null, bestesR: null, schlechtestesR: null,
      summeR: null, mitRisiko: 0, schnittDauerMinuten: null,
    };
    if (trades.length === 0) return leer;

    const gewinner = trades.filter(t => t.ergebnis > 0);
    const verlierer = trades.filter(t => t.ergebnis < 0);

    const bruttoGewinn = gewinner.reduce((s, t) => s + t.ergebnis, 0);
    const bruttoVerlust = Math.abs(verlierer.reduce((s, t) => s + t.ergebnis, 0));

    // Die R-Kennzahlen nur ueber Trades mit bekanntem Risiko. Ein
    // Trade ohne Stop-Loss hat kein R — ihn mit 0 einzurechnen
    // verzerrte den Durchschnitt.
    const mitR = trades.filter(t => t.rVielfaches != null);
    const rWerte = mitR.map(t => t.rVielfaches!);
    const rGewinner = rWerte.filter(r => r > 0);
    const rVerlierer = rWerte.filter(r => r < 0);

    const dauern = trades.map(t => t.dauerMinuten).filter((d): d is number => d != null);

    const schnittGewinnR = mittel(rGewinner);
    const schnittVerlustR = mittel(rVerlierer);

    return {
      trades: trades.length,
      gewinner: gewinner.length,
      verlierer: verlierer.length,
      trefferquote: runde((gewinner.length / trades.length) * 100, 2),

      bruttoGewinn: runde(bruttoGewinn, 2),
      bruttoVerlust: runde(bruttoVerlust, 2),
      // Ohne Verluste ist die Kennzahl nicht aussagekraeftig, sondern
      // unendlich — dann lieber nichts behaupten.
      profitFactor: bruttoVerlust > 0 ? runde(bruttoGewinn / bruttoVerlust, 3) : null,
      ergebnis: runde(trades.reduce((s, t) => s + t.ergebnis, 0), 2),

      erwartungswertR: rWerte.length > 0 ? runde(mittel(rWerte)!, 3) : null,
      schnittGewinnR: schnittGewinnR != null ? runde(schnittGewinnR, 3) : null,
      schnittVerlustR: schnittVerlustR != null ? runde(schnittVerlustR, 3) : null,
      payoffRatio: (schnittGewinnR != null && schnittVerlustR != null && schnittVerlustR !== 0)
        ? runde(schnittGewinnR / Math.abs(schnittVerlustR), 3)
        : null,

      bestesR: rWerte.length > 0 ? runde(Math.max(...rWerte), 3) : null,
      schlechtestesR: rWerte.length > 0 ? runde(Math.min(...rWerte), 3) : null,
      summeR: rWerte.length > 0 ? runde(rWerte.reduce((s, r) => s + r, 0), 3) : null,
      mitRisiko: mitR.length,

      schnittDauerMinuten: dauern.length > 0 ? Math.round(mittel(dauern)!) : null,
    };
  }

  /**
   * Der Kontoverlauf samt groesstem Rueckgang.
   *
   * Quelle ist das Kontoblatt des Uebungskontos — es haelt jede
   * Buchung fest, auch die Gebuehren. Der Verlauf beginnt beim
   * Startkapital und folgt den Buchungen in ihrer Reihenfolge.
   */
  equityVerlauf(startkapital: number, trades?: TradeInR[]): EquityVerlauf {
    // Das Kontoblatt kommt absteigend; fuer eine Kurve braucht es die
    // umgekehrte Richtung.
    const buchungen = this.store.getPaperLedger(5000).slice().reverse();

    const punkte: EquityPunkt[] = [];
    let stand = startkapital;
    let hoch = startkapital;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    let drawdownVon = startkapital;
    let drawdownBis = startkapital;

    for (const b of buchungen) {
      const art = String(b.art);
      // Eine Zuruecksetzung beginnt eine neue Rechnung — der Verlauf
      // davor gehoert zu einem anderen Konto.
      if (art === 'zuruecksetzung') {
        const neu = Number(b.betrag) || 0;
        stand = neu; hoch = neu;
        maxDrawdown = 0; maxDrawdownPct = 0;
        drawdownVon = neu; drawdownBis = neu;
        punkte.length = 0;
        continue;
      }
      if (art === 'einzahlung') {
        // Eine Einzahlung ist kein Handelsergebnis: Sie hebt den
        // Stand UND die Messlatte, damit sie nicht als Erholung aus
        // einem Rueckgang erscheint.
        const betrag = Number(b.betrag) || 0;
        stand += betrag;
        hoch += betrag;
        continue;
      }

      const betrag = Number(b.betrag) || 0;
      stand += betrag;

      if (stand > hoch) {
        hoch = stand;
      } else {
        const rueckgang = hoch - stand;
        if (rueckgang > maxDrawdown) {
          maxDrawdown = rueckgang;
          maxDrawdownPct = hoch > 0 ? (rueckgang / hoch) * 100 : 0;
          drawdownVon = hoch;
          drawdownBis = stand;
        }
      }

      punkte.push({
        zeitpunkt: String(b.zeitpunkt ?? ''),
        stand: runde(stand, 2),
        veraenderung: runde(betrag, 2),
        art,
        symbol: (b.symbol as string | null) ?? null,
      });
    }

    const serien = this.serien(trades ?? this.trades());

    return {
      punkte,
      startkapital: runde(startkapital, 2),
      endstand: runde(stand, 2),
      maxDrawdownPct: runde(maxDrawdownPct, 2),
      maxDrawdown: runde(maxDrawdown, 2),
      drawdownVon: runde(drawdownVon, 2),
      drawdownBis: runde(drawdownBis, 2),
      ...serien,
    };
  }

  /**
   * Laengste Gewinn- und Verlustserie.
   *
   * Eine Strategie mit 50 % Trefferquote kann acht Verlierer
   * hintereinander haben. Wer das nicht weiss, bricht beim fuenften ab.
   */
  private serien(trades: TradeInR[]): {
    laengsteVerlustserie: number; laengsteGewinnserie: number;
  } {
    // Chronologisch, nicht nach Juengstem zuerst.
    const chronologisch = trades.slice().sort((a, b) =>
      String(a.beendet ?? '').localeCompare(String(b.beendet ?? '')));

    let verlust = 0, gewinn = 0, maxVerlust = 0, maxGewinn = 0;

    for (const t of chronologisch) {
      if (t.ergebnis < 0) {
        verlust++; gewinn = 0;
        maxVerlust = Math.max(maxVerlust, verlust);
      } else if (t.ergebnis > 0) {
        gewinn++; verlust = 0;
        maxGewinn = Math.max(maxGewinn, gewinn);
      }
      // Eine Null-Runde unterbricht keine Serie und beginnt keine.
    }

    return { laengsteVerlustserie: maxVerlust, laengsteGewinnserie: maxGewinn };
  }

  /**
   * Das Risiko eines Trades — ein R.
   *
   * Erste Wahl ist `scaled_risk` aus der Herkunft: Es ist das, was der
   * Signalgeber bei der Umrechnung tatsaechlich eingegangen ist.
   * Fehlt es (lokale Plaene, aeltere Eintraege), wird aus
   * Durchschnittseinstieg und Stop-Loss gerechnet.
   */
  private risikoVon(
    bp: Record<string, unknown>,
    herkunft: { scaled_risk?: number } | null,
    einstiegsPreis: number | null,
    menge: number,
  ): number | null {
    const ausSignal = Number(herkunft?.scaled_risk);
    if (Number.isFinite(ausSignal) && ausSignal > 0) return runde(ausSignal, 4);

    const sl = Number(bp.stop_loss_price);
    if (einstiegsPreis != null && Number.isFinite(sl) && sl > 0 && menge > 0) {
      const abstand = Math.abs(einstiegsPreis - sl);
      if (abstand > 0) return runde(abstand * menge, 4);
    }

    // Ohne Stop gibt es kein bezifferbares Risiko. Eine Null waere
    // hier die schlechteste Antwort — sie liesse jedes Ergebnis als
    // unendliches R erscheinen.
    return null;
  }

  private ersteFuellung(orders: Array<Record<string, unknown>>, rolle: string): string | null {
    const zeiten = orders
      .filter(o => o.role === rolle && (Number(o.filled_quantity) || 0) > 0)
      .map(o => String(o.updated_at ?? o.placed_at ?? ''))
      .filter(Boolean)
      .sort();
    return zeiten[0] ?? null;
  }

  private letzteFuellung(orders: Array<Record<string, unknown>>): string | null {
    const zeiten = orders
      .filter(o => AUSSTIEGS_ROLLEN.has(String(o.role)) && (Number(o.filled_quantity) || 0) > 0)
      .map(o => String(o.updated_at ?? o.placed_at ?? ''))
      .filter(Boolean)
      .sort();
    return zeiten[zeiten.length - 1] ?? null;
  }
}

// ============================================================
// Kleinkram
// ============================================================

/** Auf Cent — fuer Betraege, die angezeigt werden. */
function runde2w(wert: number): number {
  return Math.round(wert * 100) / 100;
}

function mittel(werte: number[]): number | null {
  if (werte.length === 0) return null;
  return werte.reduce((s, w) => s + w, 0) / werte.length;
}

function runde(wert: number, stellen: number): number {
  const faktor = Math.pow(10, stellen);
  return Math.round(wert * faktor) / faktor;
}

/**
 * Minuten zwischen zwei Zeitpunkten.
 *
 * SQLite liefert "YYYY-MM-DD HH:MM:SS" in UTC ohne Zonenangabe — ohne
 * das angehaengte Z laese JavaScript sie als Ortszeit, und die Dauer
 * waere um den Zonenversatz daneben.
 */
function minutenZwischen(von: string | null, bis: string | null): number | null {
  if (!von || !bis) return null;

  const alsZeit = (s: string): number => {
    const roh = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
    return new Date(roh).getTime();
  };

  const a = alsZeit(von);
  const b = alsZeit(bis);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;

  return Math.round((b - a) / 60000);
}

function sicherParsen(wert: unknown): unknown {
  if (wert == null) return null;
  if (typeof wert === 'object') return wert;
  if (typeof wert !== 'string') return null;
  try {
    return JSON.parse(wert);
  } catch {
    return null;
  }
}

// ============================================================
// MAE und MFE — wie weit lief es gegen uns, wie weit fuer uns?
//
// MAE (Maximum Adverse Excursion): der schlechteste Punkt, den ein
// Trade durchlief, bevor er endete. MFE (Maximum Favorable
// Excursion): der beste.
//
// Beides in R gemessen beantwortet eine Frage, die aus dem Ergebnis
// allein nicht hervorgeht: Sitzt der Stop zu eng? Wenn die
// Fehlschlaege im Mittel bei −0,9 R gestoppt wurden und der Kurs
// danach drehte, liegt das Problem nicht beim Signalgeber, sondern
// beim Stop. Und wenn die Gewinner regelmaessig +3 R erreichten, aber
// bei +1,2 R geschlossen wurden, sind die Ziele zu nah.
//
// Gerechnet wird aus den echten Kerzen der Boerse. Das kostet je
// Trade eine Abfrage, deshalb steht es getrennt von den uebrigen
// Kennzahlen: Wer sie nur ueberfliegen will, soll nicht darauf warten.
// ============================================================

/** Ein Trade samt seiner Ausschlaege. */
export interface TradeMitAusschlag extends TradeInR {
  /** Schlechtester Punkt in R (negativ oder 0). */
  maeR: number | null;
  /** Bester Punkt in R (positiv oder 0). */
  mfeR: number | null;
  /** Dieselben Werte als Kurs. */
  schlechtesterKurs: number | null;
  besterKurs: number | null;
  /** Wieviele Kerzen die Rechnung stuetzen — 0 heisst: keine Aussage. */
  kerzen: number;
}

export interface AusschlagAuswertung {
  trades: TradeMitAusschlag[];

  /** Wie weit liefen die VERLIERER im Mittel gegen uns? */
  schnittMaeVerlierer: number | null;
  /** Wie weit liefen die GEWINNER gegen uns, bevor sie aufgingen? */
  schnittMaeGewinner: number | null;
  /** Wie weit liefen die Gewinner maximal fuer uns? */
  schnittMfeGewinner: number | null;

  /**
   * Verlierer, deren schlechtester Punkt den Stop nur knapp riss.
   *
   * Sie sind die Kandidaten fuer einen weiteren Stop: Bei ihnen lag
   * der Tiefpunkt dicht am Stop, und ein wenig mehr Luft haette den
   * Trade am Leben gelassen. Ob er dann aufgegangen waere, sagt diese
   * Zahl NICHT — dafuer muesste man wissen, wie es weiterging.
   */
  knappGestoppt: number;

  /**
   * Gewinner, die deutlich weiter liefen, als am Ende herauskam.
   *
   * Ein Hinweis auf zu nahe Ziele.
   */
  zuFruehGeschlossen: number;

  /** Wieviele Trades sich auswerten liessen. */
  ausgewertet: number;
  /** Wieviele mangels Kerzen oder Risiko unbewertet blieben. */
  ohneDaten: number;
}

/** Holt Kerzen fuer einen Zeitraum — vom KerzenService bereitgestellt. */
export type KerzenQuelle = (
  boerse: string, symbol: string, marktart: 'spot' | 'futures',
) => Promise<Array<{ timestamp: number; high: number; low: number }>>;

/**
 * Rechnet MAE und MFE fuer eine Liste von Trades aus.
 *
 * Die Kerzen kommen von aussen (KerzenQuelle), damit dieser Teil
 * pruefbar bleibt, ohne eine Boerse zu befragen.
 */
export async function ausschlaegeErmitteln(
  trades: TradeInR[],
  kerzenHolen: KerzenQuelle,
  boerseVon: (planId: string) => { boerse: string; marktart: 'spot' | 'futures' },
  einstiegsPreisVon: (planId: string) => number | null,
): Promise<AusschlagAuswertung> {
  const ergebnis: TradeMitAusschlag[] = [];

  for (const t of trades) {
    const leer: TradeMitAusschlag = {
      ...t, maeR: null, mfeR: null,
      schlechtesterKurs: null, besterKurs: null, kerzen: 0,
    };

    const einstieg = t.einstiegsPreis ?? einstiegsPreisVon(t.planId);
    if (t.risiko == null || t.risiko <= 0 || einstieg == null ||
        t.menge <= 0 || !t.begonnen || !t.beendet) {
      ergebnis.push(leer);
      continue;
    }

    const von = alsMillis(t.begonnen);
    const bis = alsMillis(t.beendet);
    if (von == null || bis == null) { ergebnis.push(leer); continue; }

    let kerzen: Array<{ timestamp: number; high: number; low: number }>;
    try {
      const { boerse, marktart } = boerseVon(t.planId);
      kerzen = await kerzenHolen(boerse, t.symbol, marktart);
    } catch {
      ergebnis.push(leer);
      continue;
    }

    // Nur die Kerzen aus der Haltedauer. Eine Kerze, die den Zeitraum
    // ueberlappt, zaehlt mit — ihr Hoch oder Tief kann im Trade
    // gelegen haben.
    const imZeitraum = kerzen.filter(k => k.timestamp >= von - 60_000 && k.timestamp <= bis);
    if (imZeitraum.length === 0) { ergebnis.push(leer); continue; }

    const hoechster = Math.max(...imZeitraum.map(k => k.high));
    const tiefster = Math.min(...imZeitraum.map(k => k.low));

    // Beim Long ist das Tief der schlechteste Punkt, beim Short das
    // Hoch. Die Menge faellt heraus, weil R dieselbe Menge enthaelt:
    // R = |einstieg − stop| × menge, und die Auslenkung ist
    // |einstieg − extrem| × menge.
    const gegen = t.richtung === 'long' ? einstieg - tiefster : hoechster - einstieg;
    const fuer = t.richtung === 'long' ? hoechster - einstieg : einstieg - tiefster;

    // Auf die Menge beziehen — `risiko` ist ein Geldbetrag, die
    // Auslenkung dagegen ein Kursabstand.
    const jeEinheit = t.risiko / t.menge;

    ergebnis.push({
      ...leer,
      kerzen: imZeitraum.length,
      schlechtesterKurs: t.richtung === 'long' ? tiefster : hoechster,
      besterKurs: t.richtung === 'long' ? hoechster : tiefster,
      maeR: jeEinheit > 0 ? -Math.max(0, runde(gegen / jeEinheit, 3)) : null,
      mfeR: jeEinheit > 0 ? Math.max(0, runde(fuer / jeEinheit, 3)) : null,
    });
  }

  const bewertet = ergebnis.filter(t => t.maeR != null);
  const verlierer = bewertet.filter(t => t.ergebnis < 0);
  const gewinner = bewertet.filter(t => t.ergebnis > 0);

  return {
    trades: ergebnis,
    schnittMaeVerlierer: mittelOderNull(verlierer.map(t => t.maeR!)),
    schnittMaeGewinner: mittelOderNull(gewinner.map(t => t.maeR!)),
    schnittMfeGewinner: mittelOderNull(gewinner.map(t => t.mfeR!)),

    // "Knapp" heisst: Der Tiefpunkt lag zwischen −1,0 R und −1,15 R.
    // Weiter unten war es kein knapper Fall mehr, sondern ein klarer.
    knappGestoppt: verlierer.filter(t =>
      t.slGetroffen && t.maeR != null && t.maeR <= -1 && t.maeR > -1.15).length,

    // Ein Gewinner, der mehr als doppelt so weit lief, wie am Ende
    // herauskam — und mindestens 1 R ueber dem Ergebnis.
    zuFruehGeschlossen: gewinner.filter(t =>
      t.mfeR != null && t.rVielfaches != null &&
      t.mfeR > t.rVielfaches * 2 && t.mfeR - t.rVielfaches >= 1).length,

    ausgewertet: bewertet.length,
    ohneDaten: ergebnis.length - bewertet.length,
  };
}

function mittelOderNull(werte: number[]): number | null {
  if (werte.length === 0) return null;
  return runde(werte.reduce((s, w) => s + w, 0) / werte.length, 3);
}

function alsMillis(zeit: string): number | null {
  const roh = zeit.includes('T') ? zeit : zeit.replace(' ', 'T') + 'Z';
  const ms = new Date(roh).getTime();
  return Number.isFinite(ms) ? ms : null;
}
