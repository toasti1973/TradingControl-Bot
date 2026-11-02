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
import { ErgebnisService } from '../../services/ergebnis-service.js';

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

  // ============================================================
  // Auswertung: was aus den Signalen wurde
  //
  // Die Frage, auf die es ankommt: Taugt der Signalgeber? Dafuer
  // zaehlt vor allem eine Gruppe — die Trades, die in den Stop liefen,
  // OHNE vorher einen Take-Profit mitgenommen zu haben. Sie sind der
  // Vollverlust, und ihre Haeufigkeit entscheidet ueber die Guete
  // einer Strategie.
  //
  // Wer einen TP mitnahm und dann gestoppt wurde, gehoert nicht dazu:
  // Dort hat die Strategie funktioniert, nur nicht bis zum Ende.
  // ============================================================

  router.get('/api/signals/auswertung', (req, res) => {
    const nurFehlschlaege = req.query.nur === 'fehlschlaege';
    const zeilen = auswertungsZeilen(store, verlauf, nurFehlschlaege);

    // Die Kennzahlen immer ueber ALLE gehandelten Signale — sonst
    // bezoege sich die Trefferquote auf die Fehlschlaege allein.
    const alle = nurFehlschlaege ? auswertungsZeilen(store, verlauf, false) : zeilen;
    const gehandelt = alle.filter(z => z.eingestiegen > 0);
    const fehlschlaege = gehandelt.filter(z => z.istFehlschlag);

    res.json({
      zeilen,
      kennzahlen: {
        signaleGesamt: alle.length,
        gehandelt: gehandelt.length,
        fehlschlaege: fehlschlaege.length,
        fehlschlagQuote: gehandelt.length > 0
          ? Math.round((fehlschlaege.length / gehandelt.length) * 10000) / 100
          : 0,
        verlustDurchFehlschlaege:
          Math.round(fehlschlaege.reduce((s, z) => s + z.realisiert, 0) * 100) / 100,

        // Signale, die ins Leere liefen: Der Kurs stand beim Eingang
        // schon jenseits aller Einstiege. Sie kosten nichts, sagen
        // aber alles ueber die Rechtzeitigkeit eines Indikators —
        // und aus den Trades allein waeren sie unsichtbar, weil sie
        // gar keine erzeugen.
        nieInReichweite: alle.filter(z => z.ausserhalbBeiEingang).length,
        schnittAbstandBeiEingang: mittelwert(
          alle.map(z => z.abstandBeiEingang).filter((x): x is number => x != null),
        ),
        nichtEingestiegen: alle.filter(z => z.eingestiegen <= 0).length,
        ergebnisGesamt:
          Math.round(gehandelt.reduce((s, z) => s + z.gesamt, 0) * 100) / 100,
      },
    });
  });

  /**
   * Dieselben Daten als CSV — zur Auswertung ausserhalb des Bots.
   *
   * Semikolon als Trenner und Komma als Dezimalzeichen: So oeffnet
   * eine deutsche Tabellenkalkulation die Datei ohne Nachfragen.
   */
  router.get('/api/signals/auswertung.csv', (req, res) => {
    const nurFehlschlaege = req.query.nur === 'fehlschlaege';
    const zeilen = auswertungsZeilen(store, verlauf, nurFehlschlaege);

    const spalten = [
      'Zeitpunkt', 'Strategie', 'Signal-Kennung', 'Symbol', 'Richtung', 'Hebel',
      'Einstiege geplant', 'Einstiege gefuellt', 'Menge', 'Einstiegspreis',
      'Einsatz', 'TPs erreicht', 'TPs gesamt', 'Stop getroffen', 'Stop nachgezogen',
      'Verlauf', 'Ausgang', 'Fehlschlag', 'Realisiert', 'Gebuehren', 'Gesamt', 'Rendite %',
      'Abstand bei Eingang %', 'Nie in Reichweite',
    ];

    const inhalt = [
      spalten.join(';'),
      ...zeilen.map(z => [
        z.zeitpunkt, z.strategie, z.signalId, z.symbol, z.richtung, z.hebel,
        z.einstiegeGeplant, z.einstiegeGefuellt, z.menge, z.einstiegspreis,
        z.einsatz, z.tpsErreicht, z.tpsGesamt, z.slGetroffen ? 'ja' : 'nein',
        z.slNachgezogen ? 'ja' : 'nein', z.kette, z.ausgang,
        z.istFehlschlag ? 'ja' : 'nein', z.realisiert, z.gebuehren, z.gesamt, z.renditePct,
        z.abstandBeiEingang, z.ausserhalbBeiEingang ? 'ja' : 'nein',
      ].map(csvFeld).join(';')),
    ].join('\r\n');

    const name = nurFehlschlaege ? 'signale-fehlschlaege' : 'signale-auswertung';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    // Byte Order Mark, damit Excel die Umlaute richtig liest.
    res.send('﻿' + inhalt);
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

// ============================================================
// Auswertung der Signale
// ============================================================

/** Eine Zeile der Auswertung — ein Signal und was daraus wurde. */
interface AuswertungsZeile {
  zeitpunkt: string;
  strategie: string;
  signalId: string;
  planId: string;
  symbol: string;
  richtung: string;
  hebel: number;
  einstiegeGeplant: number;
  einstiegeGefuellt: number;
  eingestiegen: number;
  menge: number;
  einstiegspreis: number | null;
  einsatz: number | null;
  tpsErreicht: number;
  tpsGesamt: number;
  slGetroffen: boolean;
  slNachgezogen: boolean;
  kette: string;
  ausgang: string;
  /** In den Stop gelaufen, ohne vorher einen Take-Profit zu nehmen. */
  istFehlschlag: boolean;

  /**
   * Wie weit der Markt beim Signaleingang vom naechsten Einstieg
   * entfernt war, in Prozent. `null`, wenn nicht gemessen.
   */
  abstandBeiEingang: number | null;
  /** Lag der Kurs schon jenseits ALLER Einstiege? */
  ausserhalbBeiEingang: boolean;
  realisiert: number;
  gebuehren: number;
  gesamt: number;
  renditePct: number | null;
}

/**
 * Baut die Auswertung aus Signalen, Plaenen und deren Verlauf.
 *
 * Gerechnet wird aus den tatsaechlich abgeschickten Orders — nicht aus
 * dem, was der Plan vorsah. Nur sie wissen, was wirklich geschah.
 */
export function auswertungsZeilen(
  store: SqliteStore,
  verlauf: VerlaufService,
  nurFehlschlaege: boolean,
): AuswertungsZeile[] {
  const ergebnisService = new ErgebnisService(store);
  const zeilen: AuswertungsZeile[] = [];

  for (const bp of store.getBotTradePlans({})) {
    if (bp.source !== 'signal') continue;   // Nur, was aus Signalen kam.

    const planId = String(bp.id);
    const richtung = bp.direction === 'short' ? 'short' : 'long';
    const hebel = Number(bp.leverage) || 1;

    const e = ergebnisService.fuerPlan(planId, richtung, hebel, null);
    const v = verlauf.fuerPlan(planId);
    const herkunft = sicherParsen(bp.signal_origin as string | null) as {
      strategy?: string; signal_id?: string; received_at?: string;
      marktlage?: { abstandPct?: number; ausserhalb?: boolean };
    } | null;

    const tps = (sicherParsen(bp.take_profits as string | null) as unknown[] | null) ?? [];
    const entries = (sicherParsen(bp.entry_orders as string | null) as unknown[] | null) ?? [];

    // Take-Profits und Stop aus den ORDERS, nicht aus dem Protokoll.
    //
    // Der Verlauf-Dienst liest `bot_execution_reports`; die Orders sind
    // die verlaesslichere Quelle (CLAUDE.md: gerechnet wird aus den
    // tatsaechlich abgeschickten Orders). Bei einem Plan, dessen
    // Protokoll eine Luecke hat, bliebe ein Fehlschlag sonst
    // unerkannt — und genau die will diese Liste zeigen.
    const orders = store.getPlanOrders(planId);
    const tpsErreicht = orders.filter(o =>
      o.role === 'take_profit' && (Number(o.filled_quantity) || 0) > 0).length;
    const slGetroffen = orders.some(o =>
      (o.role === 'stop_loss' || o.role === 'trailing_stop') &&
      (Number(o.filled_quantity) || 0) > 0);

    // Der Fehlschlag: eingestiegen, in den Stop gelaufen, kein
    // einziger Take-Profit davor — UND mit Verlust geendet.
    //
    // Die letzte Bedingung ist keine Kosmetik. Nicht jede als
    // `stop_loss` verbuchte Order ist ein gerissener Stop: Auch das
    // Schliessen von Hand wird so eingetragen, denn ein Abbruch ist
    // kein erreichtes Ziel. Der BNBUSDT-Plan vom 25.10. endete so mit
    // +17,43 und stand trotzdem unter den Fehlschlaegen. Ein Trade im
    // Plus gehoert dort nicht hin, gleich wie seine Orders heissen.
    const istFehlschlag = e.eingestiegen > 0 && tpsErreicht === 0 &&
      slGetroffen && e.gesamt < 0;

    if (nurFehlschlaege && !istFehlschlag) continue;

    zeilen.push({
      zeitpunkt: String(herkunft?.received_at ?? bp.created_at ?? ''),
      strategie: String(herkunft?.strategy ?? '–'),
      signalId: String(herkunft?.signal_id ?? '–'),
      planId,
      symbol: String(bp.symbol),
      richtung,
      hebel,
      einstiegeGeplant: entries.length,
      einstiegeGefuellt: e.einstiegeGefuellt,
      eingestiegen: e.eingestiegen,
      menge: e.eingestiegen,
      einstiegspreis: e.einstiegsPreis,
      einsatz: e.einsatz,
      tpsErreicht,
      tpsGesamt: tps.length,
      slGetroffen,
      slNachgezogen: v.slNachgezogen,
      kette: v.kette,
      ausgang: v.ausgang,
      istFehlschlag,
      abstandBeiEingang: herkunft?.marktlage?.abstandPct ?? null,
      ausserhalbBeiEingang: herkunft?.marktlage?.ausserhalb === true,
      realisiert: e.realisiert,
      gebuehren: e.gebuehren,
      gesamt: e.gesamt,
      renditePct: e.renditePct,
    });
  }

  // Das Juengste zuerst.
  zeilen.sort((a, b) => b.zeitpunkt.localeCompare(a.zeitpunkt));
  return zeilen;
}

/**
 * Ein Feld fuer die CSV-Datei.
 *
 * Zahlen bekommen das deutsche Dezimalkomma, Texte mit Semikolon oder
 * Anfuehrungszeichen werden eingefasst. Ohne das zerfiele eine
 * Verlaufskette wie "E1+E2 → TP1" an einem Semikolon in zwei Spalten.
 */
export function csvFeld(wert: unknown): string {
  if (wert == null) return '';
  if (typeof wert === 'number') {
    return Number.isFinite(wert) ? String(wert).replace('.', ',') : '';
  }
  const text = String(wert);
  if (/[;"\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/** Mittelwert oder null — eine 0 waere hier eine Behauptung. */
function mittelwert(werte: number[]): number | null {
  if (werte.length === 0) return null;
  return Math.round((werte.reduce((s, w) => s + w, 0) / werte.length) * 100) / 100;
}
