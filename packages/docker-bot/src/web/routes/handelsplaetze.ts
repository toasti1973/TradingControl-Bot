// ============================================================
// Signalquellen und Boersen (hinter der Passwortabfrage)
//
// Zwei Fragen werden hier beantwortet:
//
//   1. Welche Boerse gilt fuer welchen Signalgeber?
//   2. Uebt diese Boerse — oder geht ein Auftrag wirklich hinaus?
//
// Die zweite ist die gewichtigere. Frueher entschied sie ein einziger
// Schalter (NUR_UEBUNGSBETRIEB) fuer alles; seit jede Boerse fuer sich
// entscheidet, ist dieser eine Hebel entfallen. Was an seine Stelle
// tritt, ist die Vorgabe: Was nicht ausdruecklich auf echten Handel
// gestellt ist, uebt — siehe `SqliteStore.boerseUebt()`.
//
// Deshalb verlangt das Umstellen auf echten Handel hier eine
// ausdrueckliche Bestaetigung und wird im Protokoll als Warnung
// festgehalten. Ein stiller Wechsel waere kein Wechsel, den jemand
// bemerkt.
// ============================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../../store/sqlite-store.js';
import type { BrokerRegistry } from '../../services/broker-factory.js';
import type { Logger } from '../../services/log-service.js';
import { listExchanges } from '@tradingcontrol/core';

export function createHandelsplaetzeRouter(
  store: SqliteStore,
  brokers: BrokerRegistry,
  logger: Logger,
): Router {
  const router = Router();

  // ============================================================
  // Boersen
  // ============================================================

  /**
   * Alle Boersen mit ihrem Zustand.
   *
   * Aufgefuehrt werden auch die, die noch keinen Eintrag haben — sonst
   * saehe man nur, was schon eingerichtet ist, und uebersaehe die
   * Boerse, auf der ein Plan gerade landet.
   */
  router.get('/api/handelsplaetze/boersen', (_req, res) => {
    const eingerichtet = new Map(
      store.boersenEinstellungen().map(e => [String(e.exchange), e]),
    );

    // Boersen, auf die Plaene verweisen — auch ohne Eintrag.
    const ausPlaenen = new Set(
      store.getBotTradePlans({})
        .map(p => String(p.exchange ?? '').trim().toLowerCase())
        .filter(e => e && e !== 'unknown'),
    );

    const bekannt = new Set<string>([
      'paper',
      ...listExchanges().map(e => e.id),
      ...eingerichtet.keys(),
      ...ausPlaenen,
    ]);

    const liste = [...bekannt].sort().map(id => {
      const e = eingerichtet.get(id);
      return {
        exchange: id,
        uebungsbetrieb: store.boerseUebt(id),
        eingerichtet: Boolean(e),
        aktiv: e ? e.aktiv !== 0 : true,
        notiz: e?.notiz ?? null,
        in_benutzung: ausPlaenen.has(id),
        zugangsdaten_hinterlegt: brokers.hatZugangsdaten(id),
        geaendert_am: e?.geaendert_am ?? null,
      };
    });

    res.json({ boersen: liste });
  });

  /**
   * Eine Boerse einstellen.
   *
   * Das Umstellen auf echten Handel verlangt `bestaetigung: true` im
   * Datensatz. Ein Tippfehler oder ein versehentlich mitgesendetes
   * Feld soll nicht genuegen, um echtes Geld in Bewegung zu setzen.
   */
  router.put('/api/handelsplaetze/boersen/:exchange', (req, res) => {
    const exchange = String(req.params.exchange ?? '').trim().toLowerCase();
    const rumpf = (req.body ?? {}) as Record<string, unknown>;

    if (!exchange) {
      return void res.status(400).json({ error: 'Keine Boerse angegeben' });
    }

    if (typeof rumpf.uebungsbetrieb !== 'boolean') {
      return void res.status(400).json({
        error: 'Das Feld "uebungsbetrieb" fehlt oder ist kein Wahrheitswert. ' +
               'Es gibt hier keine Vorgabe — wer eine Boerse einrichtet, ' +
               'muss sich zu dieser Frage aeussern.',
      });
    }

    const willEchtHandeln = rumpf.uebungsbetrieb === false;
    if (willEchtHandeln && rumpf.bestaetigung !== true) {
      return void res.status(400).json({
        error: 'Echter Handel verlangt "bestaetigung": true.',
        hinweis: `Ab dann gehen Auftraege auf ${exchange} wirklich an die Boerse.`,
      });
    }

    if (willEchtHandeln && !brokers.hatZugangsdaten(exchange)) {
      return void res.status(400).json({
        error: `Fuer ${exchange} sind keine Zugangsdaten hinterlegt.`,
        hinweis: 'Ohne sie wuerde jeder Plan auf dieser Boerse mit einem ' +
                 'Fehler abbrechen — statt zu handeln oder zu ueben.',
      });
    }

    try {
      store.setzeBoersenEinstellung({
        exchange,
        uebungsbetrieb: rumpf.uebungsbetrieb,
        aktiv: rumpf.aktiv !== false,
        notiz: typeof rumpf.notiz === 'string' ? rumpf.notiz : null,
      });
    } catch (err) {
      return void res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Laut ins Protokoll. Ein Wechsel zu echtem Handel ist das
    // Gewichtigste, was sich hier einstellen laesst.
    if (willEchtHandeln) {
      logger.warn({ exchange }, '*** ECHTER HANDEL eingeschaltet — Auftraege gehen jetzt an die Boerse');
    } else {
      logger.info({ exchange }, 'Boerse auf Uebungsbetrieb gestellt');
    }

    // Bestehende Zugaenge verwerfen, sonst handelte der bereits
    // aufgebaute Broker weiter nach der alten Einstellung.
    void brokers.disconnectAll();

    res.json({ ok: true, exchange, uebungsbetrieb: store.boerseUebt(exchange) });
  });

  router.delete('/api/handelsplaetze/boersen/:exchange', (req, res) => {
    const exchange = String(req.params.exchange ?? '').trim().toLowerCase();
    const weg = store.loescheBoersenEinstellung(exchange);
    void brokers.disconnectAll();
    // Ohne Eintrag uebt die Boerse wieder — das Loeschen ist damit
    // immer die sichere Richtung.
    res.json({ ok: weg, exchange, uebungsbetrieb: true });
  });

  /**
   * In welchem Positionsmodus laeuft ein Symbol an einer Boerse?
   *
   * **Rein lesend** — es wird nichts gesetzt und keine Order
   * angefasst. Die Route fragt die Boerse und gibt zurueck, was sie
   * sagt.
   *
   * Zwei Gruende, warum es sie gibt:
   *
   *   1. Der Modus entscheidet ueber jede Order, jeden Hebel und jedes
   *      Storno (Regel 3ah). Steht er falsch, weist die Boerse ab —
   *      beim Vorfall am 05.11.2026 liess sich deshalb nicht einmal
   *      eine eigene Order zuruecknehmen. Eine Angabe von solcher
   *      Tragweite gehoert sichtbar.
   *
   *   2. Die Vorab-Abfrage laesst sich sonst nur pruefen, indem man
   *      einen echten Plan startet. Hier wird sie ohne Handel
   *      ausgeloest.
   */
  router.get('/api/handelsplaetze/positionsmodus', async (req, res) => {
    const exchange = String(req.query['exchange'] ?? '').trim();
    const symbol = String(req.query['symbol'] ?? '').trim();

    if (!exchange || !symbol) {
      res.status(400).json({ ok: false, error: 'exchange und symbol sind noetig' });
      return;
    }

    try {
      const broker = await brokers.get(exchange, 'futures');
      const mitModus = broker as unknown as {
        klaerePositionsModus?: (s: string) => Promise<'hedge' | 'oneway' | null>;
      };

      // Der Uebungsbroker kennt keinen Positionsmodus — er fuehrt
      // Positionen ohnehin je (Symbol, Richtung), wie Phemex im
      // Hedge-Modus (Regel 3ab).
      if (typeof mitModus.klaerePositionsModus !== 'function') {
        res.json({
          ok: true, exchange, symbol, modus: null,
          hinweis: 'Dieser Broker fuehrt keinen Positionsmodus — im Uebungsbetrieb normal.',
        });
        return;
      }

      const modus = await mitModus.klaerePositionsModus(symbol);

      res.json({
        ok: true, exchange, symbol, modus,
        hinweis: modus === null
          ? 'Die Boerse gibt keine Auskunft — der Modus wird beim ersten Auftrag gelernt.'
          : modus === 'hedge'
            ? 'Hedge: Long und Short getrennt. Jede Order traegt die Richtung mit.'
            : 'One-Way: eine Position je Symbol. Orders tragen den Sammelwert.',
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      logger.warn({ exchange, symbol, err: text }, 'Positionsmodus nicht abfragbar');
      res.status(502).json({ ok: false, error: text });
    }
  });

  /**
   * Der Betriebszustand in einer Zeile — fuer Kopf- und Statuszeile.
   *
   * **Die wichtigste Angabe ist `echteBoersen`.** Seit jede Boerse
   * fuer sich entscheidet (Regel 5a), gibt es keinen einzelnen
   * Schalter mehr, der alles stilllegt. Damit ist die Oberflaeche die
   * einzige Stelle, an der ein versehentlich freigeschalteter
   * Echthandel auffaellt, bevor er handelt — und dafuer muss sie es
   * zeigen, ohne dass jemand in die Einstellungen sieht.
   */
  router.get('/api/handelsplaetze/zustand', (_req, res) => {
    const eingerichtet = store.boersenEinstellungen();

    const echte = eingerichtet
      .filter(e => e.aktiv !== 0 && !store.boerseUebt(String(e.exchange)))
      .map(e => String(e.exchange));

    const aktivePlaene = store.getBotTradePlans({})
      .filter(p => ['active', 'monitoring', 'executing', 'planned']
        .includes(String(p.status)));

    // Gebundene Margin aus den tatsaechlich offenen Positionen des
    // Uebungskontos — nicht aus der geplanten Groesse der Plaene.
    let gebunden = 0;
    try {
      gebunden = store.getPaperPositionen().reduce(
        (summe: number, p: { menge: number; einstiegspreis: number; hebel: number }) =>
          summe + (Number(p.menge) * Number(p.einstiegspreis)) / (Number(p.hebel) || 1),
        0,
      );
    } catch {
      // Ohne Auskunft lieber keine Zahl als eine falsche.
      gebunden = 0;
    }

    res.json({
      echtHandelAktiv: echte.length > 0,
      echteBoersen: echte,
      boersenGesamt: eingerichtet.length,
      aktivePlaene: aktivePlaene.length,
      gebundeneMargin: Math.round(gebunden * 100) / 100,
      rueckkanal: store.rueckkanalZustand
        ? (() => { try { return store.rueckkanalZustand(20); } catch { return null; } })()
        : null,
    });
  });

  // ============================================================
  // Signalquellen
  // ============================================================

  router.get('/api/handelsplaetze/quellen', (_req, res) => {
    res.json({ quellen: store.signalquellen() });
  });

  router.put('/api/handelsplaetze/quellen/:id', (req, res) => {
    const rumpf = (req.body ?? {}) as Record<string, unknown>;
    const id = String(req.params.id ?? '').trim() || randomUUID();

    const art = String(rumpf.art ?? '');
    if (!['strategie', 'pfad', 'quelle'].includes(art)) {
      return void res.status(400).json({
        error: 'art muss "strategie", "pfad" oder "quelle" sein',
      });
    }

    const erkennung = String(rumpf.erkennung ?? '').trim();
    const exchange = String(rumpf.exchange ?? '').trim().toLowerCase();
    if (!erkennung || !exchange) {
      return void res.status(400).json({ error: 'erkennung und exchange sind Pflicht' });
    }

    store.setzeSignalquelle({
      id,
      name: String(rumpf.name ?? erkennung),
      art: art as 'strategie' | 'pfad' | 'quelle',
      erkennung,
      exchange,
      rang: Number(rumpf.rang) || 100,
      aktiv: rumpf.aktiv !== false,
      notiz: typeof rumpf.notiz === 'string' ? rumpf.notiz : null,
    });

    logger.info({ id, erkennung, exchange }, 'Signalquelle eingerichtet');
    res.json({ ok: true, id });
  });

  router.delete('/api/handelsplaetze/quellen/:id', (req, res) => {
    res.json({ ok: store.loescheSignalquelle(String(req.params.id)) });
  });

  /**
   * Probelauf: Auf welcher Boerse landete dieses Signal?
   *
   * Beantwortet die Frage, ohne etwas anzulegen — wie `signals/probe`
   * fuer die Umrechnung. Eine Zuordnung, die man erst am gehandelten
   * Plan bemerkt, ist eine schlechte Zuordnung.
   */
  router.post('/api/handelsplaetze/probe', (req, res) => {
    const rumpf = (req.body ?? {}) as Record<string, unknown>;
    const treffer = store.boerseFuerSignal({
      strategie: typeof rumpf.strategie === 'string' ? rumpf.strategie : null,
      pfad: typeof rumpf.pfad === 'string' ? rumpf.pfad : null,
      quelle: typeof rumpf.quelle === 'string' ? rumpf.quelle : null,
    });

    res.json({
      treffer: treffer ?? null,
      boerse: treffer?.exchange ?? null,
      uebt: treffer ? store.boerseUebt(treffer.exchange) : null,
      hinweis: treffer
        ? null
        : 'Keine Regel trifft zu — es gilt die Boerse aus dem Signal, sonst die Vorgabe.',
    });
  });

  return router;
}
