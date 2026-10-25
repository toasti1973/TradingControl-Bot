// ============================================================
// Webhook fuer externe Handelssignale
//
// Diese Route liegt VOR der Passwortabfrage — TradingView kann sich
// nicht anmelden, es kann nur eine Adresse aufrufen und JSON schicken.
// An die Stelle der Anmeldung treten ein Geheimnis im Pfad, wahlweise
// eine HMAC-Signatur und ein Gedaechtnis gegen Wiedereinspielung.
//
// Zwei Dinge sind hier anders als im Rest der Anwendung:
//
//   1. Der unveraenderte Rumpf wird gebraucht. Eine HMAC-Signatur gilt
//      fuer genau die Zeichen, die der Absender signiert hat; schon eine
//      andere Feldreihenfolge nach JSON.parse/stringify ergaebe eine
//      andere Pruefsumme.
//
//   2. Die Antwort ist immer knapp. Ein Fehlertext, der verraet, ob das
//      Geheimnis stimmte und nur die Signatur fehlte, hilft dem
//      Signalgeber wenig und einem Fremden viel.
// ============================================================

import { Router, raw } from 'express';
import type { Request } from 'express';
import type { SignalService } from '../../services/signal-service.js';
import type { Logger } from '../../services/log-service.js';

/** Hoechstgroesse eines Signals. Ein Handelsplan braucht keine 64 KB. */
const MAX_RUMPF_BYTES = 64 * 1024;

/**
 * Einfache Drossel je Absender-Adresse.
 *
 * Die Adresse ist oeffentlich erreichbar. Ohne Drossel koennte jeder sie
 * mit Anfragen belegen und dabei Geheimnisse durchprobieren.
 */
class Drossel {
  private zugriffe = new Map<string, number[]>();

  constructor(
    private readonly hoechstzahl: number,
    private readonly fensterMs: number,
  ) {}

  erlaubt(adresse: string): boolean {
    const jetzt = Date.now();
    const bisher = (this.zugriffe.get(adresse) ?? []).filter(t => jetzt - t < this.fensterMs);
    if (bisher.length >= this.hoechstzahl) {
      this.zugriffe.set(adresse, bisher);
      return false;
    }
    bisher.push(jetzt);
    this.zugriffe.set(adresse, bisher);

    // Gelegentlich aufraeumen, damit die Tabelle nicht mitwaechst.
    if (this.zugriffe.size > 1000) {
      for (const [schluessel, zeiten] of this.zugriffe) {
        if (zeiten.every(t => jetzt - t >= this.fensterMs)) this.zugriffe.delete(schluessel);
      }
    }
    return true;
  }
}

export function createSignalWebhookRouter(
  signals: SignalService,
  logger: Logger,
): Router {
  const router = Router();
  const drossel = new Drossel(60, 60_000);   // 60 Signale je Minute und Adresse

  // Eigener Rumpf-Leser: Wir brauchen die Zeichen, wie sie ankamen, und
  // duerfen uns nicht auf die bereits geparste Fassung verlassen.
  const rumpfLeser = raw({ type: '*/*', limit: MAX_RUMPF_BYTES });

  const behandle = async (req: Request, res: import('express').Response): Promise<void> => {
    const adresse = req.ip ?? req.socket.remoteAddress ?? 'unbekannt';

    if (!drossel.erlaubt(adresse)) {
      logger.warn({ von: adresse }, 'Webhook: zu viele Anfragen');
      res.status(429).json({ ok: false, error: 'Zu viele Anfragen' });
      return;
    }

    if (!signals.istEingerichtet()) {
      logger.warn('Webhook aufgerufen, aber kein Geheimnis hinterlegt');
      res.status(503).json({
        ok: false,
        error: 'Der Signal-Eingang ist nicht eingerichtet',
      });
      return;
    }

    const roherRumpf = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {});

    if (roherRumpf.trim() === '') {
      res.status(400).json({ ok: false, error: 'Leerer Datensatz' });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const geparst: unknown = JSON.parse(roherRumpf);
      if (typeof geparst !== 'object' || geparst === null || Array.isArray(geparst)) {
        res.status(400).json({ ok: false, error: 'Der Datensatz muss ein JSON-Objekt sein' });
        return;
      }
      payload = geparst as Record<string, unknown>;
    } catch {
      // Haeufigster Fehler beim Einrichten: In der Alert-Nachricht steht
      // Text statt JSON, oder ein Platzhalter hat Anfuehrungszeichen
      // zerschossen. Deshalb hier ein Hinweis statt nur "ungueltig".
      logger.warn(
        { von: adresse, anfang: roherRumpf.slice(0, 120) },
        'Webhook: Datensatz ist kein gueltiges JSON',
      );
      res.status(400).json({
        ok: false,
        error: 'Der Datensatz ist kein gueltiges JSON. In TradingView muss die ' +
               'Alert-Nachricht das vollstaendige JSON-Objekt enthalten.',
      });
      return;
    }

    const ergebnis = await signals.nimmAn({
      roherRumpf,
      payload,
      geheimnisAusPfad: typeof req.params.secret === 'string' ? req.params.secret : undefined,
      signatur: leseSignatur(req),
      herkunftsAdresse: adresse,
    });

    // Bei nicht nachgewiesener Herkunft bleibt die Antwort einsilbig.
    if (ergebnis.status === 'rejected_auth') {
      res.status(ergebnis.httpStatus).json({ ok: false, error: 'Nicht berechtigt' });
      return;
    }

    res.status(ergebnis.httpStatus).json({
      ok: ergebnis.status === 'accepted',
      status: ergebnis.status,
      message: ergebnis.message,
      signal_id: ergebnis.signalId,
      plan_id: ergebnis.planId,
      matched_plans: ergebnis.matchedPlanIds,
      errors: ergebnis.errors,
      warnings: ergebnis.warnings,
      scaling: ergebnis.scaling && {
        factor: ergebnis.scaling.factor,
        limited_by: ergebnis.scaling.limitedBy,
        margin: ergebnis.scaling.scaledMargin,
        risk: ergebnis.scaling.scaledRisk,
        dropped_orders: ergebnis.scaling.droppedOrders.length,
      },
    });
  };

  // Mit Geheimnis im Pfad — der uebliche Weg fuer TradingView.
  router.post('/webhook/signal/:secret', rumpfLeser, (req, res) => void behandle(req, res));

  // Ohne Geheimnis im Pfad: fuer Absender, die eine Signatur oder das
  // Feld `secret` im Datensatz mitschicken.
  router.post('/webhook/signal', rumpfLeser, (req, res) => void behandle(req, res));

  // Erreichbarkeitspruefung beim Einrichten. Verraet nichts ueber den
  // Zustand des Kontos oder der Plaene.
  router.get('/webhook/signal/ping', (_req, res) => {
    res.json({ ok: true, eingerichtet: signals.istEingerichtet() });
  });

  return router;
}

/** Liest die Signatur aus den ueblichen Kopfzeilen. */
function leseSignatur(req: Request): string | undefined {
  const kandidaten = [
    'x-signature',
    'x-signature-256',
    'x-hub-signature-256',
    'x-tradingview-signature',
  ];
  for (const name of kandidaten) {
    const wert = req.headers[name];
    if (typeof wert === 'string' && wert.trim() !== '') return wert;
  }
  return undefined;
}
