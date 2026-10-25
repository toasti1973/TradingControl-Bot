// ============================================================
// PlanBuilder — aus einem umgerechneten Signal wird ein Handelsplan
//
// Der entstehende Plan traegt `source: 'signal'`. Das ist mehr als eine
// Beschriftung: Der Abgleich mit dem Journal raeumt nur Plaene mit
// `source: 'tc'` auf, und die einfache TradingEngine sieht allein
// `local_plans`. Drei Bestaende, drei Zustaendigkeiten, keine
// Ueberschneidung — und deshalb keine Order, die zweimal herausgeht.
// ============================================================

import { randomUUID } from 'node:crypto';
import type { TradePlan } from '@tradingcontrol/core';
import type { ScalingDecision, TradeSignal } from './types.js';

export interface PlanBuildOptions {
  /** Boerse, wenn weder Signal noch Plan eine nennen. */
  defaultExchange: string;
  /**
   * Soll der Plan sofort handeln duerfen?
   *
   * `false` legt ihn auf `planned` — er wird sichtbar, aber nicht
   * ausgefuehrt, bis jemand ihn freigibt. Das ist die Voreinstellung
   * fuer den Anfang: erst zusehen, dann zulassen.
   */
  autoStart: boolean;
}

/** Herkunftsnachweis, der am Plan haengen bleibt. */
export interface SignalHerkunft {
  signal_id: string;
  strategy: string;
  emitted_at: string;
  received_at: string;
  reference_capital: number;
  factor: number;
  limited_by: string;
  reference_margin: number;
  scaled_margin: number;
  reference_risk: number | null;
  scaled_risk: number | null;
  capital_equity: number;
  capital_source: string;
  dropped_orders: number;
  warnings: string[];
}

export class PlanBuilder {

  constructor(private readonly options: PlanBuildOptions) {}

  /**
   * Baut den Plan. `signal` muss das bereits umgerechnete sein — der
   * Builder rechnet nicht, er traegt nur ein.
   */
  build(signal: TradeSignal, decision: ScalingDecision): {
    plan: TradePlan;
    herkunft: SignalHerkunft;
  } {
    const jetzt = new Date().toISOString();
    const id = randomUUID();

    const herkunft: SignalHerkunft = {
      signal_id: signal.signal_id,
      strategy: signal.strategy,
      emitted_at: signal.emitted_at,
      received_at: jetzt,
      reference_capital: decision.referenceCapital,
      factor: decision.factor,
      limited_by: decision.limitedBy,
      reference_margin: decision.referenceMargin,
      scaled_margin: decision.scaledMargin,
      reference_risk: decision.referenceRisk,
      scaled_risk: decision.scaledRisk,
      capital_equity: decision.capital.equity,
      capital_source: decision.capital.source,
      dropped_orders: decision.droppedOrders.length,
      warnings: decision.warnings,
    };

    const plan: TradePlan = {
      id,
      exchange: signal.exchange ?? this.options.defaultExchange,
      symbol: signal.symbol,
      asset_symbol: signal.asset_symbol,
      quote_currency: signal.quote_currency,
      market_type: signal.market_type,
      direction: signal.direction,
      leverage: signal.leverage,
      total_size: signal.total_size,
      total_margin: signal.total_margin,
      entry_strategy: signal.entry_strategy,
      entry_orders: signal.entry_orders,
      entry_zones: signal.entry_zones,
      take_profits: signal.take_profits,
      stop_loss_price: signal.stop_loss_price,
      stop_loss_type: signal.stop_loss_type,
      trailing_stop_pct: signal.trailing_stop_pct,
      trailing_stop_activation: signal.trailing_stop_activation,
      trailing_stop_size_pct: signal.trailing_stop_size_pct,
      activation_conditions: signal.activation_conditions,
      status: this.options.autoStart ? 'active' : 'planned',
      bot_enabled: this.options.autoStart,
      notes: this.schreibeNotiz(signal, decision),
      executed_orders: [],
      source: 'signal',
      created_at: jetzt,
      updated_at: jetzt,
    };

    return { plan, herkunft };
  }

  /**
   * Die Notiz am Plan.
   *
   * Sie steht in der Weboberflaeche gleich neben dem Plan und soll die
   * eine Frage beantworten, die beim Nachschauen zuerst kommt: Warum ist
   * diese Position so gross, wie sie ist?
   */
  private schreibeNotiz(signal: TradeSignal, d: ScalingDecision): string {
    const zeilen: string[] = [];

    zeilen.push(`Signal "${signal.strategy}" (${signal.signal_id})`);
    zeilen.push(
      `Umgerechnet von ${this.geld(d.referenceCapital)} Referenzkapital auf ` +
      `${this.geld(d.capital.equity)} Kontostand — Faktor ${this.zahl(d.factor, 4)}`,
    );
    zeilen.push(`Margin: ${this.geld(d.referenceMargin)} → ${this.geld(d.scaledMargin)}`);

    if (d.referenceRisk != null && d.scaledRisk != null) {
      const anteil = d.capital.equity > 0 ? (d.scaledRisk / d.capital.equity) * 100 : 0;
      zeilen.push(
        `Risiko am Stop-Loss: ${this.geld(d.referenceRisk)} → ${this.geld(d.scaledRisk)} ` +
        `(${this.zahl(anteil, 2)} % des Kontos)`,
      );
    } else {
      zeilen.push('Risiko am Stop-Loss: nicht bezifferbar, das Signal nennt keinen Stop-Loss');
    }

    if (d.limitedBy !== 'capital') {
      zeilen.push(`Begrenzt durch: ${d.limitedBy}`);
    }
    if (d.droppedOrders.length > 0) {
      zeilen.push(`${d.droppedOrders.length} Teil-Einstieg(e) entfielen wegen der Mindestgroesse`);
    }
    for (const w of d.warnings) {
      zeilen.push(`Hinweis: ${w}`);
    }
    if (signal.notes) {
      zeilen.push(`Vom Signalgeber: ${signal.notes}`);
    }

    zeilen.push('Hebel, Stop-Loss, Take-Profits und Trailing stammen unveraendert aus dem Signal.');

    return zeilen.join('\n');
  }

  private geld(betrag: number): string {
    return betrag.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  }

  /**
   * Zahl mit fester Nachkommastellenzahl, deutsch geschrieben.
   *
   * `toFixed` setzt einen Punkt; in einer Zeile, die daneben
   * "10.000 Kontostand" schreibt, liest sich das als Tausendertrennung.
   */
  private zahl(wert: number, nachkomma: number): string {
    return wert.toLocaleString('de-DE', {
      minimumFractionDigits: nachkomma,
      maximumFractionDigits: nachkomma,
    });
  }
}
