// ============================================================
// Verlauf eines Trades — was ist tatsaechlich passiert?
//
// Aus den Eintraegen des Ausfuehrungsprotokolls wird hier eine lesbare
// Kette: "E1+E2 → TP1 → SL↑ → SL". Daran laesst sich die Guete eines
// Signalgebers beurteilen, und zwar an der einzigen Frage, auf die es
// ankommt: Wurde der Gewinn mitgenommen, bevor der Stop kam?
//
// Die Quelle ist bewusst das Protokoll und nicht der Zustand im
// Arbeitsspeicher. Der Zustand kennt nur das Jetzt; der Verlauf bleibt
// auch nach dem Abschluss des Plans erhalten — und genau dann wird er
// gebraucht.
// ============================================================

import type { SqliteStore } from '../store/sqlite-store.js';

/** Ein Ereignis im Leben eines Trades. */
export interface Ereignis {
  art: 'einstieg' | 'tp' | 'sl_nachgezogen' | 'trailing' | 'sl' | 'storniert' | 'abgelehnt';
  /** Laufende Nummer innerhalb der Art: Einstieg 1, TP 2 … */
  nummer?: number;
  preis?: number | null;
  menge?: number | null;
  /** Kurzzeichen fuer die Kette, z. B. "E1" oder "TP2". */
  zeichen: string;
  /** Ausformuliert fuer die Zeitleiste. */
  text: string;
  zeitpunkt: string;
  einzelheiten?: Record<string, unknown>;
}

export type Ausgang =
  | 'laeuft'            // noch offen
  | 'im_gewinn_beendet' // mindestens ein TP erreicht, dann Stop oder Abschluss
  | 'im_verlust_beendet'// Stop ohne vorherigen TP
  | 'vollstaendig'      // alle TPs erreicht
  | 'storniert'
  | 'nichts_geschehen'; // kein Einstieg kam zustande

export interface Verlauf {
  planId: string;
  ereignisse: Ereignis[];
  /** Die Kette als Text: "E1+E2 → TP1 → SL↑ → SL". */
  kette: string;
  ausgang: Ausgang;
  /** Wieviele Einstiege wurden platziert? */
  einstiege: number;
  /** Wieviele Take-Profits sind erreicht? */
  tpsErreicht: number;
  /** Wurde der Stop ausgeloest? */
  slGetroffen: boolean;
  /** Wurde der Stop nach einem TP nachgezogen? */
  slNachgezogen: boolean;
  /** Letzter bekannter Stop-Preis. */
  slAktuell: number | null;
}

export class VerlaufService {
  constructor(private readonly store: SqliteStore) {}

  /**
   * Baut den Verlauf eines Plans aus seinem Protokoll.
   *
   * Mehrfache Eintraege zu demselben Einstieg (erst "placed", spaeter
   * "filled") werden zu einem Ereignis zusammengefasst — sonst stuende
   * derselbe Einstieg zweimal in der Kette.
   */
  fuerPlan(planId: string): Verlauf {
    // Nach `id` sortiert, nicht nach Zeitstempel: Mehrere Ereignisse
    // desselben Durchlaufs tragen dieselbe Millisekunde, und dann waere
    // die Reihenfolge einer Zeitsortierung beliebig. Fuer einen Verlauf
    // ist sie das Entscheidende.
    const berichte = this.store.getExecutionReportsChronologisch(planId, 500);

    const ereignisse: Ereignis[] = [];
    const gesehenerEinstieg = new Set<string>();
    const gesehenerTp = new Set<number>();
    let slAktuell: number | null = null;
    let slNachgezogen = false;
    let slGetroffen = false;

    for (const b of berichte) {
      const meta = this.leseMeta(b.metadata_json);
      const rolle = String(meta.role ?? '');
      const status = String(b.status ?? '');
      const zeit = String(b.executed_at ?? '');

      // --- Einstieg ---
      if (rolle === 'entry' && (status === 'filled' || status === 'placed')) {
        // Je Einstieg nur einmal: "placed" und das spaetere "filled"
        // sind dasselbe Ereignis in zwei Stufen.
        const schluessel = String(b.entry_order_id ?? `${meta.entry_index ?? ereignisse.length}`);
        if (gesehenerEinstieg.has(schluessel)) continue;
        gesehenerEinstieg.add(schluessel);

        const nr = typeof meta.entry_index === 'number' ? meta.entry_index + 1 : gesehenerEinstieg.size;
        ereignisse.push({
          art: 'einstieg',
          nummer: nr,
          preis: this.zahl(b.fill_price) ?? this.zahl(meta.limit_price) ?? this.zahl(meta.entry_preis),
          menge: this.zahl(b.fill_quantity),
          zeichen: `E${nr}`,
          text: `Einstieg ${nr}` +
            (status === 'filled' ? ' gefuellt' : ' platziert') +
            (b.fill_price != null ? ` zu ${Number(b.fill_price).toFixed(2)}` : ''),
          zeitpunkt: zeit,
          einzelheiten: meta,
        });
        continue;
      }

      // --- Take-Profit ---
      if (rolle === 'take_profit' && status === 'filled') {
        const idx = typeof meta.tp_index === 'number' ? meta.tp_index : gesehenerTp.size;
        if (gesehenerTp.has(idx)) continue;
        gesehenerTp.add(idx);

        ereignisse.push({
          art: 'tp',
          nummer: idx + 1,
          preis: this.zahl(b.fill_price) ?? this.zahl(meta.tp_price),
          menge: this.zahl(b.fill_quantity),
          zeichen: `TP${idx + 1}`,
          text: `Take-Profit ${idx + 1} erreicht` +
            (b.fill_price != null ? ` zu ${Number(b.fill_price).toFixed(2)}` : ''),
          zeitpunkt: zeit,
          einzelheiten: meta,
        });
        continue;
      }

      // --- Stop nachgezogen ---
      if (rolle === 'sl_adjusted') {
        slAktuell = this.zahl(meta.sl_neu);
        slNachgezogen = true;
        ereignisse.push({
          art: 'sl_nachgezogen',
          preis: slAktuell,
          zeichen: 'SL↑',
          text: `Stop-Loss nachgezogen` +
            (meta.sl_vorher != null ? ` von ${Number(meta.sl_vorher).toFixed(2)}` : '') +
            (slAktuell != null ? ` auf ${slAktuell.toFixed(2)}` : ''),
          zeitpunkt: zeit,
          einzelheiten: meta,
        });
        continue;
      }

      // --- Trailing eingeschaltet ---
      if (rolle === 'trailing_activated') {
        ereignisse.push({
          art: 'trailing',
          preis: this.zahl(meta.ab_preis),
          zeichen: 'TS',
          text: `Trailing-Stop eingeschaltet` +
            (meta.trailing_pct != null ? ` mit ${meta.trailing_pct} %` : ''),
          zeitpunkt: zeit,
          einzelheiten: meta,
        });
        continue;
      }

      // --- Stop ausgeloest ---
      if ((rolle === 'stop_loss' || rolle === 'trailing_stop') && status === 'filled') {
        slGetroffen = true;
        ereignisse.push({
          art: 'sl',
          preis: this.zahl(b.fill_price),
          menge: this.zahl(b.fill_quantity),
          zeichen: 'SL',
          text: `Stop-Loss ausgeloest` +
            (b.fill_price != null ? ` zu ${Number(b.fill_price).toFixed(2)}` : ''),
          zeitpunkt: zeit,
          einzelheiten: meta,
        });
        continue;
      }

      // --- Zuruecknahme nach dem ersten TP ---
      if (status === 'cancelled' && meta.reason === 'kein_nachkauf_nach_tp') {
        // Nur einmal in die Kette, auch wenn mehrere Orders betroffen waren.
        if (!ereignisse.some(e => e.art === 'storniert')) {
          ereignisse.push({
            art: 'storniert',
            zeichen: '✂',
            text: 'Offene Kauf-Limits zurueckgenommen (kein Nachkauf nach dem Take-Profit)',
            zeitpunkt: zeit,
            einzelheiten: meta,
          });
        }
        continue;
      }

      // --- Abgelehnter Einstieg ---
      if (status === 'rejected') {
        ereignisse.push({
          art: 'abgelehnt',
          zeichen: '✗',
          text: `Nicht ausgefuehrt: ${String(meta.reason ?? 'ohne Angabe')}`,
          zeitpunkt: zeit,
          einzelheiten: meta,
        });
      }
    }

    const einstiege = ereignisse.filter(e => e.art === 'einstieg').length;
    const tpsErreicht = ereignisse.filter(e => e.art === 'tp').length;

    return {
      planId,
      ereignisse,
      kette: this.baueKette(ereignisse),
      ausgang: this.bestimmeAusgang(planId, { einstiege, tpsErreicht, slGetroffen }),
      einstiege,
      tpsErreicht,
      slGetroffen,
      slNachgezogen,
      slAktuell,
    };
  }

  /**
   * Fasst die Kette zusammen: "E1+E2 → TP1 → SL↑ → SL".
   *
   * Aufeinanderfolgende Einstiege werden mit + verbunden, weil sie
   * zusammen den Einstieg bilden. Alles andere ist ein eigener Schritt.
   */
  private baueKette(ereignisse: Ereignis[]): string {
    if (ereignisse.length === 0) return '–';

    const schritte: string[] = [];
    let einstiegsBlock: string[] = [];

    const blockAbschliessen = (): void => {
      if (einstiegsBlock.length > 0) {
        schritte.push(einstiegsBlock.join('+'));
        einstiegsBlock = [];
      }
    };

    for (const e of ereignisse) {
      if (e.art === 'einstieg') {
        einstiegsBlock.push(e.zeichen);
        continue;
      }
      // Stornierungen und Ablehnungen stehen nicht in der Kurzfassung —
      // sie wuerden sie zukleistern, ohne vom Ausgang zu erzaehlen.
      if (e.art === 'storniert' || e.art === 'abgelehnt') continue;

      blockAbschliessen();
      schritte.push(e.zeichen);
    }
    blockAbschliessen();

    return schritte.length > 0 ? schritte.join(' → ') : '–';
  }

  /**
   * Wie ist der Trade ausgegangen?
   *
   * Der Stop beendet den Trade — danach ist nichts mehr offen. Ob das
   * ein gutes oder ein schlechtes Ergebnis war, entscheidet sich daran,
   * ob vorher ein Take-Profit griff.
   */
  private bestimmeAusgang(
    planId: string,
    z: { einstiege: number; tpsErreicht: number; slGetroffen: boolean },
  ): Ausgang {
    const plan = this.store.getBotTradePlan(planId);
    const status = String(plan?.status ?? '');

    if (status === 'cancelled') return 'storniert';

    if (z.slGetroffen) {
      return z.tpsErreicht > 0 ? 'im_gewinn_beendet' : 'im_verlust_beendet';
    }

    if (z.einstiege === 0) {
      // Kein Einstieg kam zustande — weder Gewinn noch Verlust, aber
      // auch kein Beleg fuer die Guete des Signals.
      return status === 'completed' || status === 'cancelled' ? 'nichts_geschehen' : 'laeuft';
    }

    const tpsGesamt = this.anzahlTakeProfits(plan);
    if (tpsGesamt > 0 && z.tpsErreicht >= tpsGesamt) return 'vollstaendig';
    if (status === 'completed') {
      return z.tpsErreicht > 0 ? 'im_gewinn_beendet' : 'nichts_geschehen';
    }

    return 'laeuft';
  }

  private anzahlTakeProfits(plan: Record<string, unknown> | undefined): number {
    if (!plan) return 0;
    try {
      const tps = JSON.parse(String(plan.take_profits ?? '[]'));
      return Array.isArray(tps) ? tps.length : 0;
    } catch {
      return 0;
    }
  }

  private leseMeta(roh: unknown): Record<string, unknown> {
    if (!roh) return {};
    if (typeof roh === 'object') return roh as Record<string, unknown>;
    try {
      const geparst: unknown = JSON.parse(String(roh));
      return (typeof geparst === 'object' && geparst !== null)
        ? geparst as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private zahl(wert: unknown): number | null {
    if (typeof wert === 'number') return Number.isFinite(wert) ? wert : null;
    if (typeof wert === 'string') {
      const n = Number(wert);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
