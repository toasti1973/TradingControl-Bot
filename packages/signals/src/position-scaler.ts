// ============================================================
// PositionScaler — rechnet ein Signal auf das vorhandene Kapital um
//
// Der Signalgeber entwirft den Trade fuer ein vereinbartes
// Referenzkapital, ueblich 10.000 USDT. Wer mit 2.500 handelt, soll
// denselben Trade im Viertel fahren — nicht einen anderen.
//
// Darum wird hier ausschliesslich die Groesse angefasst:
//
//   angepasst:    total_size, total_margin, Groesse jeder Teil-Order,
//                 absolute Groessen in Take-Profits
//   unangetastet: Hebel, alle Preise, Stop-Loss, Take-Profit-Preise und
//                 -Anteile, Trailing-Einstellungen, Aktivierungsstufen
//
// Das ist keine Geschmacksfrage. Hebel und Stop bestimmen miteinander,
// wo die Liquidation liegt und wieviel Prozent des Einsatzes ein Trade
// kostet; die Take-Profit-Preise tragen die Marktmeinung. Wer daran
// dreht, handelt eine andere Strategie als die, die das Signal meinte —
// und kann sich auf deren Ergebnisse nicht mehr berufen.
//
// Die Grenzen des Risikoprofils wirken nur nach unten. Die einzige
// Ausnahme ist `multiplier`, den der Nutzer selbst setzt.
// ============================================================

import { getTpPercentage } from '@tradingcontrol/core';
import type { EntryOrder, TakeProfit } from '@tradingcontrol/core';
import type {
  CapitalSnapshot, LimitingFactor, MarketLimits, RiskProfile,
  ScalingDecision, ScalingResult, TradeSignal,
} from './types.js';
import { STANDARD_RISIKOPROFIL } from './types.js';

export interface ScaleInput {
  signal: TradeSignal;
  capital: CapitalSnapshot;
  profile?: Partial<RiskProfile>;
  /** Grenzen der Boerse. Fehlen sie, wird nichts gestrichen. */
  limits?: MarketLimits;
}

export class PositionScaler {

  scale(input: ScaleInput): ScalingResult {
    const profile: RiskProfile = { ...STANDARD_RISIKOPROFIL, ...input.profile };
    const { signal, capital, limits } = input;

    const warnings: string[] = [];
    const entries = signal.entry_orders;

    // --- Vorbedingungen ---
    if (entries.length === 0) {
      return this.ablehnen(signal, capital, 'Das Signal nennt keinen Einstieg');
    }
    if (capital.equity <= 0) {
      return this.ablehnen(signal, capital, 'Kein Kapital auf dem Konto ermittelbar');
    }
    if (signal.reference_capital <= 0) {
      return this.ablehnen(signal, capital, 'Das Signal nennt kein gueltiges Referenzkapital');
    }

    // --- Bezugsgroessen des Signals ---
    const notionalRef = entries.reduce((s, e) => s + e.size * e.price, 0);
    const marginRef = signal.total_margin ?? (notionalRef / signal.leverage);
    if (marginRef <= 0) {
      return this.ablehnen(signal, capital, 'Die Margin des Signals ergibt sich zu 0');
    }

    const riskRef = signal.stop_loss_price != null
      ? entries.reduce((s, e) => s + e.size * Math.abs(e.price - signal.stop_loss_price!), 0)
      : null;

    // --- Die einzelnen Obergrenzen ---
    const handelbaresKapital = capital.equity * profile.capitalFraction;
    const fKapital = (handelbaresKapital / signal.reference_capital) * profile.multiplier;

    const fRisiko = (riskRef != null && riskRef > 0 && profile.maxRiskPerTradePct > 0)
      ? (profile.maxRiskPerTradePct * capital.equity) / riskRef
      : null;

    const fMargin = profile.maxMarginPerTradePct > 0
      ? (profile.maxMarginPerTradePct * capital.equity) / marginRef
      : null;

    // Beim Uebungsbroker ist der freie Betrag haeufig 0, weil er nicht
    // gefuehrt wird. Dann wird diese Grenze uebersprungen statt alles zu
    // blockieren.
    const fFrei = capital.free > 0
      ? (capital.free * profile.usableFreeMarginPct) / marginRef
      : null;
    if (capital.free <= 0) {
      warnings.push('Kein freier Betrag bekannt — die Grenze der verfuegbaren Margin wurde uebersprungen');
    }

    if (riskRef == null) {
      warnings.push(
        'Das Signal nennt keinen Stop-Loss — die Grenze fuer den Hoechstverlust je Trade blieb wirkungslos',
      );
    }

    const kandidaten: Array<{ name: LimitingFactor; wert: number }> = [
      { name: 'capital', wert: fKapital },
    ];
    if (fRisiko != null) kandidaten.push({ name: 'risk_per_trade', wert: fRisiko });
    if (fMargin != null) kandidaten.push({ name: 'max_margin', wert: fMargin });
    if (fFrei != null) kandidaten.push({ name: 'free_margin', wert: fFrei });

    const kleinster = kandidaten.reduce((a, b) => (b.wert < a.wert ? b : a));
    const faktor = kleinster.wert;

    if (faktor <= 0) {
      return this.ablehnen(
        signal, capital,
        `Der Umrechnungsfaktor ergibt ${faktor} — es bleibt keine handelbare Groesse`,
        { kandidaten: { fKapital, fRisiko, fMargin, fFrei }, marginRef, riskRef, profile },
      );
    }

    if (kleinster.name !== 'capital') {
      warnings.push(
        `Die Groesse wurde von ${this.benenne(kleinster.name)} begrenzt: Faktor ${faktor.toFixed(4)} ` +
        `statt ${fKapital.toFixed(4)} nach reiner Kapitalproportion`,
      );
    }

    // --- Anwenden ---
    const { skalierteEntries, gestrichen } = this.skaliereEntries(
      entries, faktor, profile, limits, signal,
    );

    if (skalierteEntries.length === 0) {
      return this.ablehnen(
        signal, capital,
        gestrichen.length > 0
          ? `Alle ${gestrichen.length} Teil-Einstiege liegen nach der Umrechnung unter der Mindestgroesse der Boerse`
          : 'Nach der Umrechnung bleibt kein Einstieg uebrig',
        { kandidaten: { fKapital, fRisiko, fMargin, fFrei }, marginRef, riskRef, profile, faktor, gestrichen },
      );
    }

    if (profile.belowMinimum === 'reject' && gestrichen.length > 0) {
      return this.ablehnen(
        signal, capital,
        `${gestrichen.length} Teil-Einstieg(e) unter der Mindestgroesse, und das Profil verlangt ` +
        `in diesem Fall die Ablehnung des ganzen Signals`,
        { kandidaten: { fKapital, fRisiko, fMargin, fFrei }, marginRef, riskRef, profile, faktor, gestrichen },
      );
    }

    const sizeSoll = signal.total_size * faktor;
    const sizeIst = skalierteEntries.reduce((s, e) => s + e.size, 0);
    const anteilUebrig = sizeSoll > 0 ? sizeIst / sizeSoll : 0;

    if (anteilUebrig < profile.minRemainingFraction) {
      return this.ablehnen(
        signal, capital,
        `Nach dem Streichen zu kleiner Teil-Einstiege blieben nur ${(anteilUebrig * 100).toFixed(1)} % ` +
        `der geplanten Groesse uebrig (verlangt: ${(profile.minRemainingFraction * 100).toFixed(0)} %)`,
        { kandidaten: { fKapital, fRisiko, fMargin, fFrei }, marginRef, riskRef, profile, faktor, gestrichen },
      );
    }

    if (gestrichen.length > 0) {
      warnings.push(
        `${gestrichen.length} Teil-Einstieg(e) entfielen wegen der Mindestgroesse der Boerse — ` +
        `gehandelt werden ${(anteilUebrig * 100).toFixed(1)} % der geplanten Groesse`,
      );
    }

    // Die tatsaechlichen Werte aus dem, was uebrig blieb — nicht aus dem
    // Faktor hochgerechnet. Streichungen und Rundungen verschieben beides.
    const notionalIst = skalierteEntries.reduce((s, e) => s + e.size * e.price, 0);
    const marginIst = notionalIst / signal.leverage;
    const riskIst = signal.stop_loss_price != null
      ? skalierteEntries.reduce((s, e) => s + e.size * Math.abs(e.price - signal.stop_loss_price!), 0)
      : null;

    if (riskIst != null && capital.equity > 0) {
      const risikoAnteil = riskIst / capital.equity;
      if (profile.maxRiskPerTradePct > 0 && risikoAnteil > profile.maxRiskPerTradePct * 1.001) {
        // Darf nach der Rechnung nicht eintreten; wenn doch, ist Abbruch
        // die einzig vertretbare Antwort.
        return this.ablehnen(
          signal, capital,
          `Nachrechnung: Das Risiko betruege ${(risikoAnteil * 100).toFixed(2)} % des Kontos und ` +
          `ueberschritte die Grenze von ${(profile.maxRiskPerTradePct * 100).toFixed(2)} %`,
          { kandidaten: { fKapital, fRisiko, fMargin, fFrei }, marginRef, riskRef, profile, faktor, gestrichen },
        );
      }
    }

    const skaliertesSignal: TradeSignal = {
      ...signal,
      // Alles unten Stehende bleibt bewusst unberuehrt:
      //   leverage, stop_loss_price, stop_loss_type, trailing_*,
      //   take_profit-Preise und -Anteile, activation_conditions
      total_size: this.rundeMenge(sizeIst, limits),
      total_margin: marginIst,
      entry_orders: skalierteEntries,
      entry_zones: this.skaliereZonen(signal, skalierteEntries),
      // Absolute Take-Profit-Groessen muessen am TATSAECHLICHEN Ergebnis
      // haengen, nicht am rohen Faktor: Wurden Teil-Einstiege wegen der
      // Mindestgroesse gestrichen, ist die Position kleiner als
      // faktor x total_size. Mit dem rohen Faktor summierten die
      // Ausstiege dann auf mehr, als ueberhaupt da ist — im
      // unguenstigen Fall dreht die letzte Order die Position um.
      // Anteile in Prozent sind davon nicht betroffen, sie beziehen
      // sich ohnehin auf das, was tatsaechlich offen ist.
      take_profits: this.skaliereTakeProfits(
        signal.take_profits, this.wirksamerFaktor(signal, faktor, sizeIst), limits,
      ),
    };

    const decision: ScalingDecision = {
      accepted: true,
      factor: faktor,
      limitedBy: kleinster.name,
      candidates: {
        capital: fKapital,
        riskPerTrade: fRisiko,
        maxMargin: fMargin,
        freeMargin: fFrei,
      },
      capital,
      referenceCapital: signal.reference_capital,
      referenceMargin: marginRef,
      scaledMargin: marginIst,
      referenceRisk: riskRef,
      scaledRisk: riskIst,
      referenceSize: signal.total_size,
      scaledSize: sizeIst,
      droppedOrders: gestrichen,
      warnings,
    };

    return { decision, signal: skaliertesSignal };
  }

  // ============================================================
  // Teil-Einstiege
  // ============================================================

  private skaliereEntries(
    entries: EntryOrder[],
    faktor: number,
    profile: RiskProfile,
    limits: MarketLimits | undefined,
    signal: TradeSignal,
  ): {
    skalierteEntries: EntryOrder[];
    gestrichen: ScalingDecision['droppedOrders'];
  } {
    const skalierteEntries: EntryOrder[] = [];
    const gestrichen: ScalingDecision['droppedOrders'] = [];

    for (const entry of entries) {
      const roh = entry.size * faktor;
      const menge = this.rundeMenge(roh, limits);

      const grund = this.unterMindestgroesse(menge, entry.price, limits);
      if (grund) {
        gestrichen.push({ id: entry.id ?? '', price: entry.price, size: roh, reason: grund });
        continue;
      }

      skalierteEntries.push({
        ...entry,
        size: menge,
        // Der Anteil am Ganzen bleibt, was er war — er ist eine
        // Verhaeltniszahl und wandert nicht mit der Groesse.
        percentage: entry.percentage,
      });
    }

    void profile;
    void signal;
    return { skalierteEntries, gestrichen };
  }

  /**
   * Faellt die Menge unter das, was die Boerse annimmt?
   *
   * Zurueck kommt der Grund im Klartext oder nichts.
   */
  private unterMindestgroesse(
    menge: number, preis: number, limits: MarketLimits | undefined,
  ): string | null {
    if (menge <= 0) {
      return 'Menge ist nach dem Abrunden 0';
    }
    if (limits?.minAmount != null && menge < limits.minAmount) {
      return `Menge ${menge} unter der Mindestmenge ${limits.minAmount}`;
    }
    if (limits?.minCost != null && menge * preis < limits.minCost) {
      return `Auftragswert ${(menge * preis).toFixed(2)} unter dem Mindestwert ${limits.minCost}`;
    }
    return null;
  }

  /**
   * Rundet die Menge auf das Raster der Boerse — immer nach unten.
   *
   * Aufrunden wuerde die Position ueber das heben, was das Risikoprofil
   * zulaesst. Lieber ein Krumen weniger handeln als eine Grenze reissen.
   */
  private rundeMenge(menge: number, limits: MarketLimits | undefined): number {
    if (!Number.isFinite(menge) || menge <= 0) return 0;

    if (limits?.amountStep != null && limits.amountStep > 0) {
      const schritte = Math.floor(menge / limits.amountStep);
      return this.saeubere(schritte * limits.amountStep);
    }

    if (limits?.amountPrecision != null && limits.amountPrecision >= 0) {
      const faktor = Math.pow(10, limits.amountPrecision);
      return this.saeubere(Math.floor(menge * faktor) / faktor);
    }

    // Ohne Angabe der Boerse: acht Nachkommastellen, wie im uebrigen Bot.
    return this.saeubere(Math.floor(menge * 1e8) / 1e8);
  }

  /** Haengt die Reste der Gleitkomma-Rechnung ab (0.30000000000000004). */
  private saeubere(wert: number): number {
    return Number(wert.toFixed(10));
  }

  // ============================================================
  // Take-Profits und Zonen
  // ============================================================

  /**
   * Das Verhaeltnis zwischen der tatsaechlich entstandenen Position und
   * der des Signals.
   *
   * Ohne Streichungen ist das genau der Umrechnungsfaktor. Entfielen
   * Teil-Einstiege, liegt es darunter — und nur dieser kleinere Wert
   * darf auf absolute Ausstiegsmengen angewandt werden.
   */
  private wirksamerFaktor(signal: TradeSignal, faktor: number, sizeIst: number): number {
    const referenz = signal.entry_orders.reduce((s, e) => s + e.size, 0) || signal.total_size;
    if (referenz <= 0) return faktor;
    const wirksam = sizeIst / referenz;
    // Nie groesser als der Faktor: Rundungen duerfen nicht nach oben wirken.
    return Math.min(faktor, wirksam);
  }

  /**
   * Take-Profits bleiben, wie sie sind — bis auf absolute Mengenangaben.
   *
   * Preis und Anteil kommen vom Signalgeber. Wer mit einem Viertel des
   * Kapitals handelt, nimmt an denselben Preisen dieselben Anteile mit.
   */
  private skaliereTakeProfits(
    tps: TakeProfit[], faktor: number, limits: MarketLimits | undefined,
  ): TakeProfit[] {
    return tps.map(tp => (
      tp.size != null
        ? { ...tp, size: this.rundeMenge(tp.size * faktor, limits) }
        : { ...tp }
    ));
  }

  /**
   * Zonen tragen nur Preise und Anteile; umgerechnet werden muessen
   * allein die ausdruecklich aufgefuehrten Teil-Orders einer
   * `custom`-Zone.
   */
  private skaliereZonen(signal: TradeSignal, skalierteEntries: EntryOrder[]): TradeSignal['entry_zones'] {
    if (!signal.entry_zones) return null;

    const nachId = new Map(skalierteEntries.map(e => [e.id, e]));
    return signal.entry_zones.map(zone => {
      if (!zone.customOrders || zone.customOrders.length === 0) return { ...zone };
      return {
        ...zone,
        customOrders: zone.customOrders
          .map(o => nachId.get(o.id))
          .filter((o): o is EntryOrder => o != null),
      };
    });
  }

  // ============================================================
  // Ablehnung
  // ============================================================

  private ablehnen(
    signal: TradeSignal,
    capital: CapitalSnapshot,
    grund: string,
    kontext?: {
      kandidaten?: { fKapital: number; fRisiko: number | null; fMargin: number | null; fFrei: number | null };
      marginRef?: number;
      riskRef?: number | null;
      profile?: RiskProfile;
      faktor?: number;
      gestrichen?: ScalingDecision['droppedOrders'];
    },
  ): ScalingResult {
    return {
      signal: null,
      decision: {
        accepted: false,
        reason: grund,
        factor: kontext?.faktor ?? 0,
        limitedBy: 'capital',
        candidates: {
          capital: kontext?.kandidaten?.fKapital ?? 0,
          riskPerTrade: kontext?.kandidaten?.fRisiko ?? null,
          maxMargin: kontext?.kandidaten?.fMargin ?? null,
          freeMargin: kontext?.kandidaten?.fFrei ?? null,
        },
        capital,
        referenceCapital: signal.reference_capital,
        referenceMargin: kontext?.marginRef ?? 0,
        scaledMargin: 0,
        referenceRisk: kontext?.riskRef ?? null,
        scaledRisk: null,
        referenceSize: signal.total_size,
        scaledSize: 0,
        droppedOrders: kontext?.gestrichen ?? [],
        warnings: [],
      },
    };
  }

  private benenne(faktor: LimitingFactor): string {
    switch (faktor) {
      case 'risk_per_trade': return 'der Grenze fuer den Hoechstverlust je Trade';
      case 'max_margin': return 'der Grenze fuer die Margin je Trade';
      case 'free_margin': return 'der frei verfuegbaren Margin';
      case 'capital': return 'der Kapitalproportion';
    }
  }
}

// ============================================================
// Nachweis, dass nur Groessen angefasst wurden
// ============================================================

/**
 * Vergleicht Original und Umrechnung in allen Feldern, die sich nicht
 * aendern duerfen.
 *
 * Gedacht fuer Tests und fuer eine Pruefung vor dem Anlegen des Plans:
 * Sollte der Umrechner je an einem Stop-Loss drehen, faellt es hier auf
 * und nicht erst an der Boerse.
 */
export function pruefeUnveraendert(vorher: TradeSignal, nachher: TradeSignal): string[] {
  const abweichungen: string[] = [];

  const vergleiche = (feld: string, a: unknown, b: unknown): void => {
    if (a !== b) abweichungen.push(`${feld}: ${String(a)} → ${String(b)}`);
  };

  vergleiche('leverage', vorher.leverage, nachher.leverage);
  vergleiche('stop_loss_price', vorher.stop_loss_price, nachher.stop_loss_price);
  vergleiche('stop_loss_type', vorher.stop_loss_type, nachher.stop_loss_type);
  vergleiche('trailing_stop_pct', vorher.trailing_stop_pct, nachher.trailing_stop_pct);
  vergleiche('trailing_stop_activation', vorher.trailing_stop_activation, nachher.trailing_stop_activation);
  vergleiche('trailing_stop_size_pct', vorher.trailing_stop_size_pct, nachher.trailing_stop_size_pct);
  vergleiche('direction', vorher.direction, nachher.direction);
  vergleiche('symbol', vorher.symbol, nachher.symbol);
  vergleiche('market_type', vorher.market_type, nachher.market_type);

  if (vorher.take_profits.length !== nachher.take_profits.length) {
    abweichungen.push(
      `Anzahl der Take-Profits: ${vorher.take_profits.length} → ${nachher.take_profits.length}`,
    );
  } else {
    vorher.take_profits.forEach((tp, i) => {
      const neu = nachher.take_profits[i]!;
      vergleiche(`take_profits[${i}].price`, tp.price, neu.price);
      vergleiche(`take_profits[${i}].percentage`, getTpPercentage(tp), getTpPercentage(neu));
      vergleiche(`take_profits[${i}].sl_adjust`, tp.sl_adjust, neu.sl_adjust);
      vergleiche(`take_profits[${i}].sl_new_price`, tp.sl_new_price, neu.sl_new_price);
      vergleiche(`take_profits[${i}].activate_trailing`, tp.activate_trailing, neu.activate_trailing);
      vergleiche(`take_profits[${i}].trailing_pct`, tp.trailing_pct, neu.trailing_pct);
    });
  }

  // Einstiegspreise: Jeder verbliebene Einstieg muss seinen Preis behalten.
  const preiseVorher = new Map(vorher.entry_orders.map(e => [e.id, e.price]));
  for (const e of nachher.entry_orders) {
    const alt = preiseVorher.get(e.id);
    if (alt != null && alt !== e.price) {
      abweichungen.push(`entry_orders[${e.id}].price: ${alt} → ${e.price}`);
    }
  }

  const bedingungenVorher = JSON.stringify(vorher.activation_conditions);
  const bedingungenNachher = JSON.stringify(nachher.activation_conditions);
  if (bedingungenVorher !== bedingungenNachher) {
    abweichungen.push('activation_conditions wurden veraendert');
  }

  return abweichungen;
}
