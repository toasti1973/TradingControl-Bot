// ============================================================
// Verwaltung des Signal-Eingangs (hinter der Passwortabfrage)
//
// Hier wird eingestellt, eingesehen und geprobt — gehandelt wird ueber
// den Webhook. Die wichtigste Route ist `POST /api/signals/probe`: Sie
// rechnet ein Signal durch, ohne einen Plan anzulegen. Ein neuer
// Indikator gehoert erst dort durchgespielt, bevor er auf das Konto
// losgelassen wird.
// ============================================================

import { Router } from 'express';
import type { SignalService } from '../../services/signal-service.js';
import type { CapitalService } from '../../services/capital-service.js';
import type { SqliteStore } from '../../store/sqlite-store.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { Logger } from '../../services/log-service.js';
import { VerlaufService } from '../../services/verlauf-service.js';

export function createSignalsRouter(
  signals: SignalService,
  capital: CapitalService,
  store: SqliteStore,
  settings: SettingsService,
  logger: Logger,
): Router {
  const router = Router();
  const verlauf = new VerlaufService(store);
  void settings;

  // ============================================================
  // Eingangsbuch
  // ============================================================

  router.get('/api/signals', (req, res) => {
    const eintraege = signals.listeSignale({
      status: req.query.status as string | undefined,
      action: req.query.action as string | undefined,
      symbol: req.query.symbol as string | undefined,
      strategy: req.query.strategy as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 100,
    });

    // Zu jedem Signal, aus dem ein Plan wurde, auch dessen Verlauf: Erst
    // daran laesst sich ablesen, was das Signal wert war — ob der Gewinn
    // mitgenommen wurde, bevor der Stop kam.
    const angereichert = eintraege.map(zeile => {
      const aufbereitet = aufbereiten(zeile);
      const planId = zeile.created_plan_id as string | null;
      if (!planId) return aufbereitet;

      const v = verlauf.fuerPlan(planId);
      return {
        ...aufbereitet,
        verlauf: {
          kette: v.kette,
          ausgang: v.ausgang,
          einstiege: v.einstiege,
          tpsErreicht: v.tpsErreicht,
          slGetroffen: v.slGetroffen,
          slNachgezogen: v.slNachgezogen,
        },
      };
    });

    res.json({ signals: angereichert, count: angereichert.length });
  });

  router.get('/api/signals/einstellungen', (_req, res) => {
    const konfiguration = signals.getConfig();
    res.json({
      // Das Geheimnis selbst wird nicht herausgegeben, nur ob es da ist.
      geheimnis_hinterlegt: konfiguration.webhookSecret.length > 0,
      signatur_verlangt: konfiguration.requireSignature,
      referenzkapital: konfiguration.defaultReferenceCapital,
      boerse: konfiguration.defaultExchange,
      hoechstalter_sek: konfiguration.maxAgeSeconds,
      sofort_handeln: konfiguration.autoStart,
      trigger_gueltigkeit_sek: Math.round(konfiguration.triggerGueltigkeitMs / 1000),
      risikoprofil: konfiguration.risikoprofil,
      kapital: capital.getConfig(),
    });
  });

  /**
   * Aendert das Risikoprofil.
   *
   * Jede Zahl wird gegen ihre Grenzen geprueft, bevor sie wirksam wird.
   * Ein vertipptes `maxRiskPerTradePct: 20` statt `0.20` wuerde sonst den
   * zwanzigfachen Kontostand je Trade riskieren.
   */
  router.put('/api/signals/risikoprofil', (req, res) => {
    const eingabe = req.body as Record<string, unknown>;
    const fehler: string[] = [];

    const zahl = (name: string, min: number, max: number): number | undefined => {
      const wert = eingabe[name];
      if (wert === undefined) return undefined;
      const n = typeof wert === 'number' ? wert : Number(wert);
      if (!Number.isFinite(n)) {
        fehler.push(`${name} ist keine Zahl`);
        return undefined;
      }
      if (n < min || n > max) {
        fehler.push(`${name} muss zwischen ${min} und ${max} liegen (war ${n})`);
        return undefined;
      }
      return n;
    };

    const neu: Record<string, unknown> = {};
    const felder: Array<[string, number, number]> = [
      ['capitalFraction', 0, 1],
      ['multiplier', 0, 10],
      ['maxRiskPerTradePct', 0, 1],
      ['maxMarginPerTradePct', 0, 1],
      ['usableFreeMarginPct', 0, 1],
      ['minRemainingFraction', 0, 1],
    ];
    for (const [name, min, max] of felder) {
      const wert = zahl(name, min, max);
      if (wert !== undefined) neu[name] = wert;
    }

    if (eingabe.belowMinimum !== undefined) {
      if (eingabe.belowMinimum === 'drop' || eingabe.belowMinimum === 'reject') {
        neu.belowMinimum = eingabe.belowMinimum;
      } else {
        fehler.push('belowMinimum muss "drop" oder "reject" sein');
      }
    }

    if (fehler.length > 0) {
      return void res.status(400).json({ error: 'Ungueltige Werte', details: fehler });
    }

    const bisher = signals.getConfig().risikoprofil;
    const profil = { ...bisher, ...neu };
    signals.setConfig({ risikoprofil: profil });
    store.setBotState('setting:signalRisikoprofil', JSON.stringify(profil));

    logger.info({ profil }, 'Risikoprofil fuer Signale geaendert');
    res.json({ success: true, risikoprofil: profil });
  });

  /** Allgemeine Einstellungen des Signal-Eingangs. */
  router.put('/api/signals/einstellungen', (req, res) => {
    const eingabe = req.body as Record<string, unknown>;
    const aenderungen: Record<string, unknown> = {};

    if (typeof eingabe.webhookSecret === 'string') {
      if (eingabe.webhookSecret.length > 0 && eingabe.webhookSecret.length < 24) {
        return void res.status(400).json({
          error: 'Das Geheimnis muss mindestens 24 Zeichen haben — die Adresse ist oeffentlich erreichbar',
        });
      }
      aenderungen.webhookSecret = eingabe.webhookSecret;
      store.setBotState('setting:signalWebhookSecret', eingabe.webhookSecret);
    }
    if (typeof eingabe.requireSignature === 'boolean') {
      aenderungen.requireSignature = eingabe.requireSignature;
      store.setBotState('setting:signalRequireSignature', String(eingabe.requireSignature));
    }
    if (typeof eingabe.autoStart === 'boolean') {
      aenderungen.autoStart = eingabe.autoStart;
      store.setBotState('setting:signalAutoStart', String(eingabe.autoStart));
    }
    if (typeof eingabe.defaultReferenceCapital === 'number' && eingabe.defaultReferenceCapital > 0) {
      aenderungen.defaultReferenceCapital = eingabe.defaultReferenceCapital;
      store.setBotState('setting:signalReferenceCapital', String(eingabe.defaultReferenceCapital));
    }
    if (typeof eingabe.maxAgeSeconds === 'number' && eingabe.maxAgeSeconds >= 0) {
      aenderungen.maxAgeSeconds = eingabe.maxAgeSeconds;
      store.setBotState('setting:signalMaxAge', String(eingabe.maxAgeSeconds));
    }
    if (typeof eingabe.triggerGueltigkeitSek === 'number' && eingabe.triggerGueltigkeitSek > 0) {
      aenderungen.triggerGueltigkeitMs = eingabe.triggerGueltigkeitSek * 1000;
      store.setBotState('setting:signalTriggerTtl', String(eingabe.triggerGueltigkeitSek));
    }

    signals.setConfig(aenderungen);
    logger.info({ geaendert: Object.keys(aenderungen) }, 'Einstellungen des Signal-Eingangs geaendert');
    res.json({ success: true });
  });

  /** Einstellungen der Kapitalermittlung. */
  router.put('/api/signals/kapital', (req, res) => {
    const eingabe = req.body as Record<string, unknown>;
    const aenderungen: Record<string, unknown> = {};

    if (typeof eingabe.fallbackEquity === 'number' && eingabe.fallbackEquity >= 0) {
      aenderungen.fallbackEquity = eingabe.fallbackEquity;
      store.setBotState('setting:signalFallbackEquity', String(eingabe.fallbackEquity));
    }
    if (typeof eingabe.allowFallback === 'boolean') {
      aenderungen.allowFallback = eingabe.allowFallback;
      store.setBotState('setting:signalAllowFallback', String(eingabe.allowFallback));
    }
    if (typeof eingabe.cacheTtlMs === 'number' && eingabe.cacheTtlMs >= 0) {
      aenderungen.cacheTtlMs = eingabe.cacheTtlMs;
    }

    capital.setConfig(aenderungen);
    res.json({ success: true, kapital: capital.getConfig() });
  });

  /** Kontostand nachsehen — mit frischem Abruf bei der Boerse. */
  router.get('/api/signals/kapital/:exchange/:quote', async (req, res) => {
    const stand = await capital.hole(
      req.params.exchange!, req.params.quote!, { frisch: true },
    );
    res.json(stand);
  });

  // ============================================================
  // Probelauf
  // ============================================================

  /**
   * Rechnet ein Signal durch, ohne etwas anzulegen.
   *
   * Zeigt den Umrechnungsfaktor, die wirksame Grenze, die entstehende
   * Margin und das Risiko — und was der Plan enthielte.
   */
  router.post('/api/signals/probe', async (req, res) => {
    try {
      const ergebnis = await signals.probe(req.body as Record<string, unknown>);
      res.json(ergebnis);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Probelauf fehlgeschlagen',
      });
    }
  });

  // ============================================================
  // Weg A: Signal-Bedingung an einem Plan
  // ============================================================

  /**
   * Knuepft einen bestehenden Plan an ein Signal — oder loest die
   * Verknuepfung wieder (`trigger: null`).
   */
  router.put('/api/signals/plan-trigger/:planId', (req, res) => {
    const planId = req.params.planId!;
    const plan = store.getBotTradePlan(planId);
    if (!plan) return void res.status(404).json({ error: 'Plan nicht gefunden' });

    const eingabe = (req.body as { trigger?: unknown }).trigger;

    if (eingabe === null) {
      store.setPlanSignalTrigger(planId, null);
      logger.info({ planId }, 'Signal-Bedingung vom Plan entfernt');
      return void res.json({ success: true, trigger: null });
    }

    if (typeof eingabe !== 'object' || eingabe === undefined) {
      return void res.status(400).json({
        error: 'trigger muss ein Objekt sein oder null, um die Verknuepfung zu loesen',
      });
    }

    const roh = eingabe as Record<string, unknown>;
    const bedingung: Record<string, unknown> = {};

    for (const feld of ['strategy', 'symbol', 'tag']) {
      if (typeof roh[feld] === 'string' && (roh[feld] as string).trim() !== '') {
        bedingung[feld] = (roh[feld] as string).trim();
      }
    }
    if (typeof roh.max_age_sec === 'number' && roh.max_age_sec > 0) {
      bedingung.max_age_sec = roh.max_age_sec;
    }
    if (typeof roh.match_direction === 'boolean') {
      bedingung.match_direction = roh.match_direction;
    }

    // Eine Bedingung ohne jeden Filter passt auf jedes Signal — das ist
    // fast nie gemeint und waere gefaehrlich, weil dann ein beliebiger
    // Alarm diesen Plan oeffnete.
    if (Object.keys(bedingung).filter(k => k !== 'max_age_sec' && k !== 'match_direction').length === 0) {
      return void res.status(400).json({
        error: 'Die Bedingung braucht mindestens eines von strategy, symbol oder tag — ' +
               'sonst gaebe sie den Plan bei jedem beliebigen Signal frei',
      });
    }

    store.setPlanSignalTrigger(planId, JSON.stringify(bedingung));
    logger.info({ planId, bedingung }, 'Signal-Bedingung am Plan gesetzt');
    res.json({ success: true, trigger: bedingung });
  });

  /** Alle Plaene, die auf ein Signal warten. */
  router.get('/api/signals/wartende-plaene', (_req, res) => {
    const plaene = store.getBotTradePlans({})
      .filter(z => z.signal_trigger != null)
      .map(z => ({
        id: z.id,
        symbol: z.symbol,
        direction: z.direction,
        status: z.status,
        source: z.source,
        bot_enabled: !!z.bot_enabled,
        trigger: sicherParsen(z.signal_trigger as string | null),
      }));
    res.json({ plaene, count: plaene.length });
  });

  // ============================================================
  // Aufraeumen
  // ============================================================

  router.post('/api/signals/aufraeumen', (req, res) => {
    const tage = typeof (req.body as { tage?: number }).tage === 'number'
      ? (req.body as { tage: number }).tage
      : 30;
    const entfernt = signals.raeumeAuf(tage);
    res.json({ success: true, entfernt });
  });

  return router;
}

/**
 * Bereitet einen Eintrag des Eingangsbuchs fuer die Anzeige auf.
 *
 * Die JSON-Felder werden entpackt, damit die Oberflaeche sie nicht
 * zweimal auspacken muss.
 */
function aufbereiten(zeile: Record<string, unknown>): Record<string, unknown> {
  return {
    ...zeile,
    warnings: sicherParsen(zeile.warnings_json as string | null) ?? [],
    scaling: sicherParsen(zeile.scaling_json as string | null),
    matched_plan_ids: sicherParsen(zeile.matched_plan_ids as string | null) ?? [],
    raw_payload: sicherParsen(zeile.raw_payload as string | null) ?? zeile.raw_payload,
    warnings_json: undefined,
    scaling_json: undefined,
  };
}

function sicherParsen(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
