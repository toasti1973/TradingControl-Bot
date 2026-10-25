// ============================================================
// SignalService — nimmt externe Handelssignale an und setzt sie um
//
// Zwei Wege fuehren vom Signal zum Trade, und sie schliessen sich nicht
// aus:
//
//   Weg A — Freigabe (action: 'trigger')
//     Ein Plan liegt fertig im Bot und wartet. Das Signal gibt ihn frei.
//     Groesse, Hebel und Stops stehen schon im Plan; das Signal bestimmt
//     allein den Zeitpunkt. Wer die Positionsgroesse selbst festlegen und
//     nur das Einstiegssignal von aussen beziehen will, nimmt diesen.
//
//   Weg B — Vollplan (action: 'open')
//     Das Signal bringt den ganzen Trade mit, ausgelegt auf ein
//     vereinbartes Referenzkapital. Der Bot rechnet die Groesse auf das
//     vorhandene Kapital um und legt daraus einen Plan an.
//
// Beide muenden in `bot_trade_plans` und werden vom TradePlanMonitor
// ausgefuehrt — demselben, der auch die gespiegelten Journal-Plaene
// fuehrt. Die Bestaende bleiben getrennt ueber das Feld `source`.
//
// An das Journal geht nichts. Die Einbahnstrasse gilt auch hier: Was an
// der Boerse geschah, holt sich das Journal selbst.
// ============================================================

import { randomUUID } from 'node:crypto';
import {
  PlanBuilder, PositionScaler, SignalAuthenticator, SignalSchema,
  STANDARD_RISIKOPROFIL, pruefeUnveraendert,
} from '@tradingcontrol/signals';
import type {
  CapitalSnapshot, RawSignalPayload, RiskProfile, ScalingDecision, TradeSignal,
} from '@tradingcontrol/signals';
import type { TradePlan } from '@tradingcontrol/core';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Logger } from './log-service.js';
import type { TradePlanMonitor } from './trade-plan-monitor.js';
import type { CapitalService } from './capital-service.js';

export interface SignalServiceConfig {
  /** Gemeinsames Geheimnis fuer den Webhook. Leer = Webhook nimmt nichts an. */
  webhookSecret: string;
  /** HMAC-Signatur verlangen statt blossem Geheimnis. */
  requireSignature: boolean;
  /** Kapital, auf das sich Signale ohne eigene Angabe beziehen. */
  defaultReferenceCapital: number;
  /** Boerse fuer Signale, die keine nennen. */
  defaultExchange: string;
  /** Hoechstalter eines Signals in Sekunden. */
  maxAgeSeconds: number;
  /**
   * Duerfen aus Signalen entstandene Plaene sofort handeln?
   *
   * Voreingestellt nein. Der Plan wird angelegt und sichtbar, aber erst
   * nach Freigabe ausgefuehrt. Wer einen neuen Signalgeber anschliesst,
   * sollte ihm erst eine Weile zusehen.
   */
  autoStart: boolean;
  /** Wie lange ein Trigger-Signal (Weg A) gueltig bleibt. */
  triggerGueltigkeitMs: number;
  /** Die Grenzen, in denen gehandelt wird. */
  risikoprofil: RiskProfile;
}

export const STANDARD_SIGNAL_CONFIG: SignalServiceConfig = {
  webhookSecret: '',
  requireSignature: false,
  defaultReferenceCapital: 10_000,
  defaultExchange: 'paper',
  maxAgeSeconds: 300,
  autoStart: false,
  triggerGueltigkeitMs: 5 * 60_000,
  risikoprofil: STANDARD_RISIKOPROFIL,
};

export type SignalStatus =
  | 'accepted'          // angenommen und umgesetzt
  | 'rejected_auth'     // Herkunft nicht nachgewiesen
  | 'rejected_schema'   // Inhalt nicht schluessig
  | 'rejected_scaling'  // Umrechnung ergab keine handelbare Groesse
  | 'rejected_risk'     // eine Grenze des Risikoprofils stand entgegen
  | 'duplicate'         // Kennung war schon da
  | 'no_match';         // Trigger ohne wartenden Plan

export interface SignalAufnahme {
  status: SignalStatus;
  /** Antwortcode fuer den Webhook. */
  httpStatus: number;
  message: string;
  signalId?: string;
  planId?: string;
  matchedPlanIds?: string[];
  scaling?: ScalingDecision;
  errors?: string[];
  warnings?: string[];
}

export class SignalService {
  private readonly scaler = new PositionScaler();
  private schema: SignalSchema;
  private auth: SignalAuthenticator;
  private builder: PlanBuilder;

  constructor(
    private readonly store: SqliteStore,
    private readonly monitor: TradePlanMonitor,
    private readonly capital: CapitalService,
    private readonly logger: Logger,
    private config: SignalServiceConfig = STANDARD_SIGNAL_CONFIG,
  ) {
    this.schema = this.baueSchema();
    this.auth = this.baueAuth();
    this.builder = this.baueBuilder();

    // Das Gedaechtnis fuer gesehene Kennungen ueberlebt einen Neustart:
    // Sonst nimmt der Bot nach jedem Hochfahren Signale an, die er schon
    // einmal gehandelt hat.
    const fenster = 24 * 3600_000;
    this.auth.ladeBekannte(this.store.getSignalKennungen(Date.now() - fenster));
  }

  setConfig(config: Partial<SignalServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.schema = this.baueSchema();
    this.auth = this.baueAuth();
    this.builder = this.baueBuilder();
    this.auth.ladeBekannte(this.store.getSignalKennungen(Date.now() - 24 * 3600_000));
  }

  getConfig(): SignalServiceConfig {
    return { ...this.config };
  }

  istEingerichtet(): boolean {
    return this.auth.istEingerichtet();
  }

  // ============================================================
  // Eingang
  // ============================================================

  /**
   * Nimmt ein Signal entgegen. Wirft nicht — jeder Ausgang wird
   * beantwortet und im Eingangsbuch festgehalten.
   */
  async nimmAn(args: {
    roherRumpf: string;
    payload: RawSignalPayload;
    geheimnisAusPfad?: string;
    signatur?: string;
    herkunftsAdresse?: string;
  }): Promise<SignalAufnahme> {
    // --- 1. Herkunft ---
    const herkunft = this.auth.pruefeHerkunft({
      geheimnisAusPfad: args.geheimnisAusPfad,
      geheimnisAusRumpf: typeof args.payload.secret === 'string' ? args.payload.secret : undefined,
      signatur: args.signatur,
      roherRumpf: args.roherRumpf,
    });

    if (!herkunft.ok) {
      // Bewusst nicht im Eingangsbuch festgehalten: Wer die Adresse
      // errät, koennte die Tabelle sonst mit Muell fuellen. Das Protokoll
      // genuegt.
      this.logger.warn(
        { grund: herkunft.failure, von: args.herkunftsAdresse },
        'Signal mit nicht nachgewiesener Herkunft abgewiesen',
      );
      return {
        status: 'rejected_auth',
        httpStatus: herkunft.failure === 'kein_geheimnis' ? 503 : 401,
        message: herkunft.message ?? 'Herkunft nicht nachgewiesen',
      };
    }

    // --- 2. Inhalt ---
    const geprueft = this.schema.parse(args.payload);
    if (!geprueft.valid || !geprueft.signal) {
      const kennung = typeof args.payload.signal_id === 'string' ? args.payload.signal_id : randomUUID();
      this.schreibeInsBuch({
        signalId: kennung,
        strategy: typeof args.payload.strategy === 'string' ? args.payload.strategy : 'unbekannt',
        action: typeof args.payload.action === 'string' ? args.payload.action : 'unbekannt',
        symbol: typeof args.payload.symbol === 'string' ? args.payload.symbol : '',
        roherRumpf: args.roherRumpf,
        status: 'rejected_schema',
        grund: geprueft.errors.join('; '),
        warnungen: geprueft.warnings,
        herkunftsAdresse: args.herkunftsAdresse,
      });

      this.logger.warn({ fehler: geprueft.errors }, 'Signal inhaltlich zurueckgewiesen');
      return {
        status: 'rejected_schema',
        httpStatus: 400,
        message: 'Das Signal ist inhaltlich nicht schluessig',
        errors: geprueft.errors,
        warnings: geprueft.warnings,
      };
    }

    const signal = geprueft.signal;

    // --- 3. Schon dagewesen? ---
    const wiederholung = this.auth.pruefeWiedereinspielung(signal.signal_id);
    if (!wiederholung.ok) {
      this.logger.info({ signalId: signal.signal_id }, 'Signal war schon da — verworfen');
      return {
        status: 'duplicate',
        httpStatus: 200,
        message: wiederholung.message ?? 'Signal bereits verarbeitet',
        signalId: signal.signal_id,
      };
    }

    // --- 4. Je nach Absicht ---
    try {
      switch (signal.action) {
        case 'open':
          return await this.legePlanAn(signal, args);
        case 'trigger':
          return this.gibFrei(signal, args);
        case 'close':
        case 'cancel':
          return await this.beende(signal, args);
      }
    } catch (err) {
      const nachricht = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, signalId: signal.signal_id }, 'Verarbeitung des Signals fehlgeschlagen');
      this.schreibeInsBuch({
        signalId: signal.signal_id,
        strategy: signal.strategy,
        action: signal.action,
        symbol: signal.symbol,
        direction: signal.direction,
        roherRumpf: args.roherRumpf,
        status: 'rejected_scaling',
        grund: `Verarbeitung fehlgeschlagen: ${nachricht}`,
        herkunftsAdresse: args.herkunftsAdresse,
      });
      return {
        status: 'rejected_scaling',
        httpStatus: 500,
        message: `Verarbeitung fehlgeschlagen: ${nachricht}`,
        signalId: signal.signal_id,
      };
    }
  }

  // ============================================================
  // Weg B — Vollplan aus dem Signal
  // ============================================================

  private async legePlanAn(
    signal: TradeSignal,
    args: { roherRumpf: string; herkunftsAdresse?: string },
  ): Promise<SignalAufnahme> {
    const boerse = signal.exchange ?? this.config.defaultExchange;

    // Kontostand und Marktgrenzen. Beide duerfen fehlen — dann lehnt der
    // Umrechner ab beziehungsweise rechnet ohne Mindestgroessen.
    const [kapital, grenzen] = await Promise.all([
      this.capital.hole(boerse, signal.quote_currency),
      this.capital.holeMarktgrenzen(boerse, signal.symbol),
    ]);

    const { decision, signal: skaliert } = this.scaler.scale({
      signal,
      capital: kapital,
      profile: this.config.risikoprofil,
      limits: grenzen,
    });

    if (!decision.accepted || !skaliert) {
      this.schreibeInsBuch({
        signalId: signal.signal_id,
        strategy: signal.strategy,
        action: signal.action,
        symbol: signal.symbol,
        direction: signal.direction,
        roherRumpf: args.roherRumpf,
        status: 'rejected_scaling',
        grund: decision.reason ?? 'Umrechnung ergab keine handelbare Groesse',
        warnungen: decision.warnings,
        rechnung: decision,
        herkunftsAdresse: args.herkunftsAdresse,
      });
      this.auth.merkeVor(signal.signal_id);

      this.logger.warn(
        { signalId: signal.signal_id, grund: decision.reason },
        'Signal nach der Umrechnung abgelehnt',
      );
      return {
        status: 'rejected_scaling',
        httpStatus: 200,
        message: decision.reason ?? 'Keine handelbare Groesse',
        signalId: signal.signal_id,
        scaling: decision,
      };
    }

    // Letzte Kontrolle vor dem Anlegen: Hat die Umrechnung wirklich nur
    // Groessen angefasst? Faende sich hier eine Abweichung, waere der
    // Umrechner kaputt — dann wird nicht gehandelt.
    const abweichungen = pruefeUnveraendert(signal, skaliert);
    if (abweichungen.length > 0) {
      this.logger.error(
        { signalId: signal.signal_id, abweichungen },
        'Die Umrechnung hat Felder veraendert, die unberuehrt bleiben muessen — Signal verworfen',
      );
      this.schreibeInsBuch({
        signalId: signal.signal_id,
        strategy: signal.strategy,
        action: signal.action,
        symbol: signal.symbol,
        direction: signal.direction,
        roherRumpf: args.roherRumpf,
        status: 'rejected_scaling',
        grund: `Umrechnung unzulaessig: ${abweichungen.join(', ')}`,
        rechnung: decision,
        herkunftsAdresse: args.herkunftsAdresse,
      });
      this.auth.merkeVor(signal.signal_id);
      return {
        status: 'rejected_scaling',
        httpStatus: 500,
        message: 'Die Umrechnung hat unzulaessige Felder veraendert',
        signalId: signal.signal_id,
        errors: abweichungen,
      };
    }

    const { plan, herkunft } = this.builder.build(skaliert, decision);
    this.speicherePlan(plan, herkunft);

    // Der Monitor fuehrt ihn nur aus, wenn er auch handeln darf.
    if (plan.bot_enabled && plan.status !== 'planned') {
      this.monitor.registerPlan(plan);
    }

    this.schreibeInsBuch({
      signalId: signal.signal_id,
      strategy: signal.strategy,
      action: signal.action,
      symbol: signal.symbol,
      direction: signal.direction,
      roherRumpf: args.roherRumpf,
      status: 'accepted',
      warnungen: decision.warnings,
      rechnung: decision,
      planId: plan.id,
      herkunftsAdresse: args.herkunftsAdresse,
    });
    this.auth.merkeVor(signal.signal_id);

    this.logger.info({
      signalId: signal.signal_id,
      planId: plan.id,
      symbol: plan.symbol,
      faktor: decision.factor,
      begrenztDurch: decision.limitedBy,
      margin: `${decision.referenceMargin.toFixed(2)} → ${decision.scaledMargin.toFixed(2)}`,
      risiko: decision.scaledRisk != null ? decision.scaledRisk.toFixed(2) : 'unbekannt',
      sofortAktiv: plan.bot_enabled && plan.status !== 'planned',
    }, 'Signal angenommen — Plan angelegt');

    return {
      status: 'accepted',
      httpStatus: 200,
      message: plan.status === 'planned'
        ? 'Plan angelegt, wartet auf Freigabe'
        : 'Plan angelegt und in Ausfuehrung',
      signalId: signal.signal_id,
      planId: plan.id,
      scaling: decision,
      warnings: decision.warnings,
    };
  }

  // ============================================================
  // Weg A — Freigabe wartender Plaene
  // ============================================================

  /**
   * Haelt die Freigabe fest. Die Plaene holen sie sich selbst ab, wenn
   * ihr Preis erreicht ist — der Monitor fragt bei jedem Durchlauf nach.
   *
   * Das ist mit Absicht so herum: Wuerde das Signal die Einstiege
   * unmittelbar ausloesen, kaufte der Bot zum Marktpreis statt an der im
   * Plan vorgesehenen Stelle.
   */
  private gibFrei(
    signal: TradeSignal,
    args: { roherRumpf: string; herkunftsAdresse?: string },
  ): SignalAufnahme {
    const wartende = this.findeWartendePlaene(signal);

    this.schreibeInsBuch({
      signalId: signal.signal_id,
      strategy: signal.strategy,
      action: signal.action,
      symbol: signal.symbol,
      roherRumpf: args.roherRumpf,
      // Auch ohne wartenden Plan 'accepted': Der Plan koennte in den
      // naechsten Sekunden noch angelegt werden, und solange der Trigger
      // gilt, findet er ihn dann vor.
      status: 'accepted',
      grund: wartende.length === 0 ? 'Zurzeit wartet kein Plan auf dieses Signal' : null,
      matchedPlanIds: wartende,
      herkunftsAdresse: args.herkunftsAdresse,
    });
    this.auth.merkeVor(signal.signal_id);

    this.logger.info({
      signalId: signal.signal_id,
      strategie: signal.strategy,
      symbol: signal.symbol,
      marke: signal.tag,
      wartendePlaene: wartende.length,
      gueltigBis: new Date(Date.now() + this.config.triggerGueltigkeitMs).toISOString(),
    }, 'Freigabe-Signal vorgemerkt');

    return {
      status: wartende.length > 0 ? 'accepted' : 'no_match',
      httpStatus: 200,
      message: wartende.length > 0
        ? `Freigabe vorgemerkt, ${wartende.length} Plan/Plaene warten darauf`
        : 'Freigabe vorgemerkt, zurzeit wartet kein Plan darauf',
      signalId: signal.signal_id,
      matchedPlanIds: wartende,
    };
  }

  /**
   * Welche Plaene haben eine Signal-Bedingung, auf die dieses Signal
   * passt? Nur zur Auskunft — verbraucht wird der Trigger erst, wenn ein
   * Plan ihn tatsaechlich heranzieht.
   *
   * Die Regeln muessen denen in `TradePlanMonitor.holeSignalFreigabe`
   * entsprechen. Waere die Auskunft grosszuegiger, meldete sie Treffer,
   * die spaeter keine Freigabe ergeben — und man suchte den Fehler an
   * der falschen Stelle.
   */
  private findeWartendePlaene(signal: TradeSignal): string[] {
    if (signal.target_plan_id) {
      const plan = this.store.getBotTradePlan(signal.target_plan_id);
      return plan ? [signal.target_plan_id] : [];
    }

    const treffer: string[] = [];
    for (const zeile of this.store.getBotTradePlans({})) {
      const roh = zeile.signal_trigger as string | null;
      if (!roh) continue;

      try {
        const bedingung = JSON.parse(roh) as {
          strategy?: string; symbol?: string; tag?: string; match_direction?: boolean;
        };

        if (bedingung.strategy && bedingung.strategy !== signal.strategy) continue;

        // Ohne eigene Angabe gilt das Symbol des Plans — ein Signal zu
        // ETHUSDT soll keinen BTCUSDT-Plan oeffnen.
        const erwartetesSymbol = bedingung.symbol ?? (zeile.symbol as string);
        if (erwartetesSymbol && erwartetesSymbol !== signal.symbol) continue;

        if (bedingung.tag && bedingung.tag !== signal.tag) continue;

        // Die Richtung wird nur verglichen, wenn das Signal eine traegt.
        // Ein reines Freigabe-Signal hat haeufig keine; dann steht sie im
        // Plan und es gibt nichts zu pruefen.
        if (bedingung.match_direction !== false && signal.action !== 'trigger') {
          if (signal.direction !== (zeile.direction as string)) continue;
        }

        treffer.push(zeile.id as string);
      } catch {
        this.logger.warn({ planId: zeile.id }, 'Signal-Bedingung des Plans ist unlesbar');
      }
    }
    return treffer;
  }

  // ============================================================
  // Schliessen und Abbrechen
  // ============================================================

  private async beende(
    signal: TradeSignal,
    args: { roherRumpf: string; herkunftsAdresse?: string },
  ): Promise<SignalAufnahme> {
    const betroffene = signal.target_plan_id
      ? [signal.target_plan_id]
      : this.store.getBotTradePlans({ source: 'signal', symbol: signal.symbol })
          .filter(z => ['active', 'monitoring', 'executing', 'planned'].includes(z.status as string))
          .map(z => z.id as string);

    for (const planId of betroffene) {
      // Der Monitor nimmt offene Orders beim naechsten Durchlauf
      // zurueck, sobald er den Plan auf 'cancelled' sieht.
      this.store.updateBotTradePlanStatus(planId, 'cancelled');
      const zustand = this.monitor.getState(planId);
      if (zustand) zustand.plan.status = 'cancelled';
    }

    this.schreibeInsBuch({
      signalId: signal.signal_id,
      strategy: signal.strategy,
      action: signal.action,
      symbol: signal.symbol,
      roherRumpf: args.roherRumpf,
      status: betroffene.length > 0 ? 'accepted' : 'no_match',
      grund: betroffene.length === 0 ? 'Kein passender Plan gefunden' : null,
      matchedPlanIds: betroffene,
      herkunftsAdresse: args.herkunftsAdresse,
    });
    this.auth.merkeVor(signal.signal_id);

    this.logger.info(
      { signalId: signal.signal_id, action: signal.action, plaene: betroffene },
      'Signal zum Beenden umgesetzt',
    );

    return {
      status: betroffene.length > 0 ? 'accepted' : 'no_match',
      httpStatus: 200,
      message: betroffene.length > 0
        ? `${betroffene.length} Plan/Plaene werden beendet`
        : 'Kein passender Plan gefunden',
      signalId: signal.signal_id,
      matchedPlanIds: betroffene,
    };
  }

  // ============================================================
  // Abfragen fuer die Weboberflaeche
  // ============================================================

  listeSignale(filter?: {
    status?: string; action?: string; symbol?: string; strategy?: string; limit?: number;
  }): Array<Record<string, unknown>> {
    return this.store.getSignals(filter);
  }

  /**
   * Probelauf: Was wuerde aus diesem Signal werden?
   *
   * Legt nichts an und merkt sich nichts. Gedacht zum Pruefen eines
   * neuen Indikators, bevor er auf das Konto losgelassen wird.
   */
  async probe(payload: RawSignalPayload): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
    signal: TradeSignal | null;
    capital?: CapitalSnapshot;
    decision?: ScalingDecision;
    scaled?: TradeSignal | null;
    plan?: Partial<TradePlan>;
  }> {
    const geprueft = this.schema.parse(payload);
    if (!geprueft.valid || !geprueft.signal) {
      return {
        valid: false,
        errors: geprueft.errors,
        warnings: geprueft.warnings,
        signal: null,
      };
    }

    const signal = geprueft.signal;
    if (signal.action !== 'open') {
      return { valid: true, errors: [], warnings: geprueft.warnings, signal };
    }

    const boerse = signal.exchange ?? this.config.defaultExchange;
    const [kapital, grenzen] = await Promise.all([
      this.capital.hole(boerse, signal.quote_currency),
      this.capital.holeMarktgrenzen(boerse, signal.symbol),
    ]);

    const { decision, signal: skaliert } = this.scaler.scale({
      signal, capital: kapital, profile: this.config.risikoprofil, limits: grenzen,
    });

    const plan = skaliert ? this.builder.build(skaliert, decision).plan : undefined;

    return {
      valid: true,
      errors: [],
      warnings: geprueft.warnings,
      signal,
      capital: kapital,
      decision,
      scaled: skaliert,
      plan,
    };
  }

  /** Entfernt alte Eintraege aus dem Eingangsbuch. */
  raeumeAuf(aelterAlsTage = 30): number {
    return this.store.raeumeSignaleAuf(aelterAlsTage * 86_400_000);
  }

  // ============================================================
  // Intern
  // ============================================================

  private speicherePlan(plan: TradePlan, herkunft: unknown): void {
    this.store.upsertBotTradePlan({
      id: plan.id,
      source: 'signal',
      exchange: plan.exchange ?? null,
      exchange_account_id: plan.exchange_account_id ?? null,
      symbol: plan.symbol,
      asset_symbol: plan.asset_symbol ?? null,
      quote_currency: plan.quote_currency ?? 'USDT',
      market_type: plan.market_type,
      direction: plan.direction,
      leverage: plan.leverage,
      total_size: plan.total_size,
      total_margin: plan.total_margin ?? null,
      entry_strategy: plan.entry_strategy,
      entry_orders: JSON.stringify(plan.entry_orders),
      entry_zones: plan.entry_zones ? JSON.stringify(plan.entry_zones) : null,
      take_profits: JSON.stringify(plan.take_profits),
      stop_loss_price: plan.stop_loss_price,
      stop_loss_type: plan.stop_loss_type,
      trailing_stop_pct: plan.trailing_stop_pct,
      trailing_stop_activation: plan.trailing_stop_activation,
      trailing_stop_size_pct: plan.trailing_stop_size_pct ?? null,
      activation_conditions: JSON.stringify(plan.activation_conditions ?? []),
      executed_orders: '[]',
      execution_mode: 'all_limit',
      status: plan.status,
      bot_enabled: plan.bot_enabled,
      notes: plan.notes ?? null,
      signal_origin: JSON.stringify(herkunft),
    });
  }

  private schreibeInsBuch(eintrag: {
    signalId: string;
    strategy: string;
    action: string;
    symbol: string;
    direction?: string;
    roherRumpf: string;
    status: SignalStatus;
    grund?: string | null;
    warnungen?: string[];
    rechnung?: ScalingDecision;
    planId?: string;
    matchedPlanIds?: string[];
    herkunftsAdresse?: string;
  }): void {
    try {
      const neu = this.store.insertSignal({
        id: randomUUID(),
        signal_id: eintrag.signalId,
        strategy: eintrag.strategy,
        action: eintrag.action,
        symbol: eintrag.symbol,
        direction: eintrag.direction ?? null,
        source_ip: eintrag.herkunftsAdresse ?? null,
        raw_payload: eintrag.roherRumpf.slice(0, 20_000),
        status: eintrag.status,
        reason: eintrag.grund ?? null,
        warnings: eintrag.warnungen ?? [],
        scaling: eintrag.rechnung,
        created_plan_id: eintrag.planId ?? null,
        matched_plan_ids: eintrag.matchedPlanIds ?? [],
      });

      if (!neu) {
        this.logger.info(
          { signalId: eintrag.signalId },
          'Signal stand schon im Eingangsbuch — der Riegel in der Datenbank hat gegriffen',
        );
      }
    } catch (err) {
      // Ein misslungener Eintrag darf einen bereits angelegten Plan nicht
      // rueckgaengig machen. Protokollieren und weiter.
      this.logger.error({ err, signalId: eintrag.signalId }, 'Eintrag ins Eingangsbuch fehlgeschlagen');
    }
  }

  private baueSchema(): SignalSchema {
    return new SignalSchema({
      defaultReferenceCapital: this.config.defaultReferenceCapital,
      defaultExchange: this.config.defaultExchange,
      maxAgeSeconds: this.config.maxAgeSeconds,
    });
  }

  private baueAuth(): SignalAuthenticator {
    return new SignalAuthenticator({
      secret: this.config.webhookSecret,
      requireSignature: this.config.requireSignature,
    });
  }

  private baueBuilder(): PlanBuilder {
    return new PlanBuilder({
      defaultExchange: this.config.defaultExchange,
      autoStart: this.config.autoStart,
    });
  }
}
