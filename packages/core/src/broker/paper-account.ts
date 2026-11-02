// ============================================================
// Uebungskonto — Buchfuehrung fuer den Uebungsbetrieb
//
// Der Bot rechnet die Groesse jedes Signals auf den Kontostand um. Im
// Uebungsbetrieb muss dieser Stand deshalb mitwandern: Ein Konto, das
// nach zehn Verlusttrades noch dasselbe behauptet, laesst den Bot
// weiter in voller Groesse handeln und macht die Uebung wertlos.
//
// Gefuehrt werden:
//   - das Startkapital
//   - realisierte Gewinne und Verluste
//   - Gebuehren, getrennt ausgewiesen
//   - die gebundene Margin offener Positionen
//
// Was hier NICHT geschieht: unrealisierte Gewinne in den Kontostand
// rechnen. Eine Boerse tut das zwar fuer die Margin-Berechnung, aber
// fuer die Groessenbestimmung des naechsten Trades waere es gefaehrlich
// — eine Position, die gerade gut dasteht, wuerde die naechste
// vergroessern, und beide fielen gemeinsam.
// ============================================================

/** Gebuehrenmodell einer Boerse, in Anteilen (0.0006 = 0,06 %). */
export interface FeeModel {
  /** Wer Liquiditaet nimmt — Market-Orders. */
  taker: number;
  /** Wer Liquiditaet stellt — Limit-Orders, die liegen bleiben. */
  maker: number;
}

/**
 * Voreinstellung nach den Saetzen von Phemex fuer USDT-Dauerkontrakte.
 * Sie sind die Kursquelle des Uebungsbetriebs; dann sollten auch die
 * Gebuehren von dort stammen.
 */
export const PHEMEX_FUTURES_GEBUEHREN: FeeModel = {
  taker: 0.0006,
  maker: 0.0001,
};

export type BuchungsArt =
  | 'einzahlung'
  | 'gebuehr'
  | 'gewinn'
  | 'verlust'
  | 'zuruecksetzung'
  /** Eine Order mit unbrauchbaren Werten — festgehalten, nicht verschwiegen. */
  | 'verworfen';

export interface Buchung {
  art: BuchungsArt;
  /** Betrag mit Vorzeichen: Was dem Konto zufliesst, ist positiv. */
  betrag: number;
  waehrung: string;
  symbol?: string;
  /** Menge, die den Besitzer wechselte. */
  menge?: number;
  preis?: number;
  /** Klartext fuers Kontoblatt. */
  notiz?: string;
  zeitpunkt: string;
}

export interface KontoStand {
  waehrung: string;
  startkapital: number;
  /** Summe aller realisierten Gewinne und Verluste, ohne Gebuehren. */
  realisiert: number;
  /** Summe aller gezahlten Gebuehren, positiv. */
  gebuehren: number;
  /** Startkapital + realisiert − gebuehren. */
  equity: number;
  /** Durch offene Positionen gebundene Margin. */
  gebunden: number;
  /** Was fuer neue Positionen bereitsteht. */
  frei: number;
  /** Anzahl abgeschlossener Trades. */
  trades: number;
  gewinne: number;
  verluste: number;
}

/**
 * Schluessel einer Position im Hedge-Modus.
 *
 * Symbol UND Richtung: Long und Short auf demselben Symbol sind zwei
 * Positionen, nicht eine. Nur das Symbol als Schluessel zu nehmen
 * liess einen Long-Einstieg einen bestehenden Short anknabbern.
 */
function positionsSchluessel(symbol: string, seite: 'buy' | 'sell'): string {
  return `${symbol}|${seite}`;
}

/** Offene Position, wie das Konto sie fuehrt. */
export interface OffenePosition {
  symbol: string;
  seite: 'buy' | 'sell';
  menge: number;
  einstiegspreis: number;
  hebel: number;
}

/**
 * Fuehrt das Uebungskonto.
 *
 * Reine Rechnerei ohne Aussenwelt — damit sie sich pruefen laesst. Wer
 * die Buchungen behalten will, haengt sich mit `beiBuchung` daran.
 */
export class PaperAccount {
  private startkapital: number;
  private realisiert = 0;
  private gebuehrenSumme = 0;
  private trades = 0;
  private gewinne = 0;
  private verluste = 0;

  private positionen = new Map<string, OffenePosition>();
  private beiBuchung: ((b: Buchung) => void) | null = null;

  constructor(
    startkapital: number,
    public readonly waehrung: string = 'USDT',
    private gebuehren: FeeModel = PHEMEX_FUTURES_GEBUEHREN,
  ) {
    this.startkapital = startkapital;
  }

  /** Rueckruf fuer jede Buchung — zum Speichern im Kontoblatt. */
  onBuchung(rueckruf: (b: Buchung) => void): void {
    this.beiBuchung = rueckruf;
  }

  setGebuehren(modell: FeeModel): void {
    this.gebuehren = { ...modell };
  }

  getGebuehren(): FeeModel {
    return { ...this.gebuehren };
  }

  /**
   * Setzt das Konto zurueck — neues Startkapital, keine Geschichte.
   *
   * Offene Positionen werden dabei verworfen, nicht glattgestellt: Es
   * ist ein Uebungskonto, und ein Neuanfang soll einer sein.
   */
  zuruecksetzen(startkapital: number): void {
    this.startkapital = startkapital;
    this.realisiert = 0;
    this.gebuehrenSumme = 0;
    this.trades = 0;
    this.gewinne = 0;
    this.verluste = 0;
    this.positionen.clear();
    this.buche({
      art: 'zuruecksetzung',
      betrag: startkapital,
      waehrung: this.waehrung,
      notiz: `Konto zurueckgesetzt auf ${startkapital} ${this.waehrung}`,
      zeitpunkt: new Date().toISOString(),
    });
  }

  /**
   * Stellt einen gespeicherten Stand wieder her.
   *
   * Ohne das begaenne das Uebungskonto nach jedem Neustart von vorn —
   * und eine Verlustserie waere mit einem Neustart aus der Welt.
   */
  wiederherstellen(stand: {
    startkapital: number; realisiert: number; gebuehren: number;
    trades: number; gewinne: number; verluste: number;
    /**
     * Offene Positionen. Ohne sie faellt die gebundene Margin nach
     * einem Neustart auf 0, und der gesamte Kontostand gilt wieder als
     * frei — der naechste Trade wuerde bemessen, als sei nichts
     * gebunden.
     */
    positionen?: Array<{ symbol: string; seite: 'buy' | 'sell'; menge: number; einstiegspreis: number; hebel: number }>;
  }): void {
    this.startkapital = stand.startkapital;
    this.realisiert = stand.realisiert;
    this.gebuehrenSumme = stand.gebuehren;
    this.trades = stand.trades;
    this.gewinne = stand.gewinne;
    this.verluste = stand.verluste;

    this.positionen.clear();
    for (const p of stand.positionen ?? []) {
      if (p.menge > 0) this.positionen.set(positionsSchluessel(p.symbol, p.seite), { ...p });
    }
  }

  // ============================================================
  // Buchungen aus dem Handel
  // ============================================================

  /**
   * Verbucht eine ausgefuehrte Order.
   *
   * Zurueck kommt, was dabei entstand: die Gebuehr und — wenn die Order
   * eine Position verkleinerte — der realisierte Gewinn oder Verlust.
   */
  ordnungAusgefuehrt(args: {
    symbol: string;
    seite: 'buy' | 'sell';
    menge: number;
    preis: number;
    /** Market-Orders zahlen den Taker-Satz, Limit-Orders den Maker-Satz. */
    orderArt: 'market' | 'limit' | 'stop' | 'stop_limit';
    hebel?: number;
    /**
     * Soll diese Order eine bestehende Position verkleinern?
     *
     * Entspricht `reduceOnly` der Boerse. Im Hedge-Modus ist das die
     * einzige Angabe, aus der sich ablesen laesst, welche der beiden
     * Positionen eines Symbols gemeint ist — die Richtung allein
     * genuegt nicht: Ein Kauf eroeffnet einen Long ODER schliesst
     * einen Short.
     */
    schliesst?: boolean;
  }): { gebuehr: number; realisiert: number; verworfen?: string } {
    const { symbol, seite, menge, preis } = args;

    // Unbrauchbare Werte werden nicht stillschweigend uebergangen.
    //
    // Frueher kam hier dasselbe Ergebnis zurueck wie bei einer Order
    // ohne Wirkung — der Aufrufer konnte beides nicht unterscheiden.
    // Reichte der Broker versehentlich eine Menge von 0 durch, bliebe
    // eine Position offen, die laengst geschlossen sein sollte, und
    // jede folgende Margin-Rechnung waere falsch. Jetzt steht es im
    // Rueckgabewert UND im Kontoblatt.
    if (!Number.isFinite(menge) || !Number.isFinite(preis) || menge <= 0 || preis <= 0) {
      const grund = `Order verworfen: Menge ${menge}, Preis ${preis} — beides muss positiv und endlich sein`;
      this.buche({
        art: 'verworfen',
        betrag: 0,
        waehrung: this.waehrung,
        symbol, menge, preis,
        notiz: grund,
        zeitpunkt: new Date().toISOString(),
      });
      return { gebuehr: 0, realisiert: 0, verworfen: grund };
    }

    const notional = menge * preis;
    // Stop-Orders loesen zum Marktpreis aus und zahlen deshalb den
    // Taker-Satz, auch wenn sie als Limit hinterlegt waren.
    const istTaker = args.orderArt !== 'limit';
    const satz = istTaker ? this.gebuehren.taker : this.gebuehren.maker;
    const gebuehr = notional * satz;
    this.gebuehrenSumme += gebuehr;

    // ERST die Position fortschreiben, DANN die Gebuehr buchen.
    //
    // Die Reihenfolge ist nicht beliebig: An jeder Buchung haengt ein
    // Rueckruf, der den Zustand wegschreibt. Kaeme die Gebuehr zuerst,
    // wuerde bei einer Eroeffnung der Stand VOR der neuen Position
    // gespeichert — nach einem Neustart fehlte sie, und die gebundene
    // Margin faellt auf 0. Genau das hat ein Durchlauf gezeigt.
    //
    // Beim Schliessen bucht `positionFortschreiben` selbst (Gewinn oder
    // Verlust); die Gebuehr danach schreibt den Stand ein zweites Mal
    // fort. Beide Male stimmt er.
    const realisiert = this.positionFortschreiben(
      symbol, seite, menge, preis, args.hebel ?? 1, args.schliesst === true,
    );

    this.buche({
      art: 'gebuehr',
      betrag: -gebuehr,
      waehrung: this.waehrung,
      symbol, menge, preis,
      notiz: `${istTaker ? 'Taker' : 'Maker'} ${(satz * 100).toFixed(3)} % auf ${notional.toFixed(2)}`,
      zeitpunkt: new Date().toISOString(),
    });

    return { gebuehr, realisiert };
  }

  /**
   * Schreibt die Position fort und gibt den dabei realisierten Betrag
   * zurueck.
   *
   * HEDGE-MODUS: Long und Short auf demselben Symbol werden getrennt
   * gefuehrt — so, wie Phemex es im Hedge-Modus tut.
   *
   * Entscheidend ist nicht die Richtung der Order, sondern ob sie
   * eroeffnen oder schliessen soll (`schliesst`, aus `reduceOnly`):
   *
   *   Kauf,  eroeffnend → vergroessert die Long-Position
   *   Kauf,  schliessend → verkleinert die Short-Position
   *   Verkauf, eroeffnend → vergroessert die Short-Position
   *   Verkauf, schliessend → verkleinert die Long-Position
   *
   * Im frueheren Netting-Modus gab es nur eine Position je Symbol. Ein
   * Long-Einstieg traf dann auf eine bestehende Short-Position und
   * schloss sie teilweise — statt eine eigene zu eroeffnen. Genau das
   * geschah am 25.10. mit BTCUSDT: Der Long-Plan realisierte 0,65 USDT
   * Verlust auf dem Short-Plan, ohne dass ein Stop gelaufen waere.
   * Beide Plaene handelten ein anderes Geschaeft als das, das sie
   * meinten.
   */
  private positionFortschreiben(
    symbol: string, seite: 'buy' | 'sell', menge: number, preis: number, hebel: number,
    schliesst: boolean,
  ): number {
    // Welche Position ist gemeint? Eine schliessende Order zielt auf
    // die Gegenrichtung, eine eroeffnende auf die eigene.
    const zielSeite: 'buy' | 'sell' = schliesst
      ? (seite === 'buy' ? 'sell' : 'buy')
      : seite;

    const schluessel = positionsSchluessel(symbol, zielSeite);
    const offen = this.positionen.get(schluessel);

    if (!schliesst) {
      if (!offen || offen.menge === 0) {
        this.positionen.set(schluessel, { symbol, seite: zielSeite, menge, einstiegspreis: preis, hebel });
      } else {
        const gesamt = offen.menge + menge;
        offen.einstiegspreis = (offen.einstiegspreis * offen.menge + preis * menge) / gesamt;
        offen.menge = gesamt;
        offen.hebel = hebel || offen.hebel;
      }
      return 0;
    }

    // Schliessend, aber nichts da: Im Hedge-Modus wird daraus KEINE
    // Gegenposition. Der Broker weist solche Orders ohnehin ab; kaeme
    // eine durch, entstuende hier sonst ein Bestand aus dem Nichts.
    if (!offen || offen.menge === 0) return 0;

    const geschlossen = Math.min(menge, offen.menge);
    const richtung = offen.seite === 'buy' ? 1 : -1;
    const ergebnis = (preis - offen.einstiegspreis) * geschlossen * richtung;

    this.realisiert += ergebnis;
    this.trades++;
    // Eine Null-Runde ist kein Gewinn.
    //
    // Mit `>= 0` floss jeder Abschluss ohne Ergebnis in die
    // Trefferquote ein und schoente sie. Bei einem Uebungskonto, das
    // der Beurteilung eines Signalgebers dient, ist das die falsche
    // Richtung zu irren.
    if (ergebnis > 0) this.gewinne++;
    else if (ergebnis < 0) this.verluste++;

    this.buche({
      art: ergebnis >= 0 ? 'gewinn' : 'verlust',
      betrag: ergebnis,
      waehrung: this.waehrung,
      symbol,
      menge: geschlossen,
      preis,
      notiz: `${offen.seite === 'buy' ? 'Long' : 'Short'} geschlossen: ` +
             `${offen.einstiegspreis.toFixed(2)} → ${preis.toFixed(2)}`,
      zeitpunkt: new Date().toISOString(),
    });

    // Gleitkomma: 0.2 − 0.08 ergibt 0.12000000000000001, und davon
    // 0.12 abgezogen einen Rest von 1e-17. Ohne Toleranz bliebe eine
    // laengst geschlossene Position als Staubkorn stehen — mitsamt
    // ihrer gebundenen Margin, die dann nie wieder frei wuerde.
    const verbleibend = this.saeubere(offen.menge - geschlossen);

    if (verbleibend <= 0) {
      this.positionen.delete(schluessel);
    } else {
      offen.menge = verbleibend;
    }

    // Was ueber die Position hinausging, verfaellt: Mehr schliessen
    // als offen ist, ergibt im Hedge-Modus keine Gegenposition.
    return ergebnis;
  }

  /** Einzahlung oder Abhebung von Hand. */
  einzahlen(betrag: number, notiz?: string): void {
    this.startkapital += betrag;
    this.buche({
      art: 'einzahlung',
      betrag,
      waehrung: this.waehrung,
      notiz: notiz ?? (betrag >= 0 ? 'Einzahlung' : 'Abhebung'),
      zeitpunkt: new Date().toISOString(),
    });
  }

  // ============================================================
  // Auskunft
  // ============================================================

  /**
   * Gebundene Margin aller offenen Positionen.
   *
   * Gerechnet auf den Einstiegspreis, nicht auf den aktuellen Kurs —
   * das ist der Betrag, der beim Eroeffnen hinterlegt wurde.
   */
  gebundeneMargin(): number {
    let summe = 0;
    for (const p of this.positionen.values()) {
      summe += (p.menge * p.einstiegspreis) / (p.hebel || 1);
    }
    return summe;
  }

  stand(): KontoStand {
    const equity = this.startkapital + this.realisiert - this.gebuehrenSumme;
    const gebunden = this.gebundeneMargin();
    return {
      waehrung: this.waehrung,
      startkapital: this.startkapital,
      realisiert: this.realisiert,
      gebuehren: this.gebuehrenSumme,
      equity,
      gebunden,
      frei: Math.max(0, equity - gebunden),
      trades: this.trades,
      gewinne: this.gewinne,
      verluste: this.verluste,
    };
  }

  offenePositionen(): Array<{ symbol: string; seite: string; menge: number; einstiegspreis: number; hebel: number }> {
    return [...this.positionen.values()].map(p => ({ ...p }));
  }

  /**
   * Die offene Position zu einem Symbol, oder null.
   *
   * Hierauf stuetzt sich der PaperBroker, wenn er entscheidet, ob eine
   * Nur-Schliessen-Order etwas zu schliessen hat. Er fuehrte frueher
   * eine eigene zweite Liste — die ueberlebte keinen Neustart, weil nur
   * dieses Konto gespeichert wird. Ein Take-Profit nach dem Hochfahren
   * fand dort keine Position und wurde abgewiesen, obwohl eine offen
   * war. Eine Tatsache, zwei Buecher: Das ging schief, wie es musste.
   */
  position(symbol: string, seite?: 'buy' | 'sell'): OffenePosition | null {
    if (seite) {
      const p = this.positionen.get(positionsSchluessel(symbol, seite));
      return p && p.menge > 0 ? { ...p } : null;
    }

    // Ohne Richtung: die erste offene zu diesem Symbol. Nur fuer
    // Aufrufer gedacht, denen die Richtung gleich ist — wer im
    // Hedge-Modus die richtige Position braucht, nennt sie.
    for (const p of this.positionen.values()) {
      if (p.symbol === symbol && p.menge > 0) return { ...p };
    }
    return null;
  }

  /**
   * Haengt die Reste der Gleitkomma-Rechnung ab.
   *
   * Mengen werden im Bot auf acht Nachkommastellen gefuehrt; was
   * darunter liegt, ist Rechenrauschen und keine Position.
   */
  private saeubere(wert: number): number {
    const gerundet = Number(wert.toFixed(10));
    return Math.abs(gerundet) < 1e-9 ? 0 : gerundet;
  }

  private buche(b: Buchung): void {
    this.beiBuchung?.(b);
  }
}
