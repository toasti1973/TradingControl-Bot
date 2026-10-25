// ============================================================
// Echtheitspruefung eingehender Signale
//
// Der Webhook muss ohne Passwortabfrage erreichbar sein — TradingView
// kann sich nicht anmelden. Die Adresse ist damit oeffentlich, und wer
// sie kennt, koennte dem Bot Trades unterschieben.
//
// Dagegen drei Riegel:
//   1. Ein geheimes Kennwort im Pfad oder im Datensatz
//   2. Eine HMAC-Signatur ueber den unveraenderten Rumpf (empfohlen)
//   3. Ein Gedaechtnis fuer bereits gesehene Kennungen gegen Wiedereinspielung
//
// Zeichenweises Vergleichen scheidet aus: Die Laufzeit eines solchen
// Vergleichs verraet, wieviele Zeichen stimmten. Deshalb durchweg
// `timingSafeEqual`.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthOptions {
  /**
   * Gemeinsames Geheimnis. Ohne Angabe ist die Pruefung abgeschaltet —
   * der Webhook nimmt dann nichts an.
   */
  secret: string;
  /**
   * HMAC-Signatur verlangen. Ohne sie reicht das Geheimnis im Pfad, was
   * bequemer, aber schwaecher ist: Die Adresse steht in Protokollen.
   */
  requireSignature?: boolean;
  /** Wie lange eine Signal-Kennung in Erinnerung bleibt (ms). */
  replayWindowMs?: number;
}

export type AuthFailure =
  | 'kein_geheimnis'
  | 'geheimnis_falsch'
  | 'signatur_fehlt'
  | 'signatur_falsch'
  | 'bereits_gesehen';

export interface AuthResult {
  ok: boolean;
  failure?: AuthFailure;
  message?: string;
}

export class SignalAuthenticator {
  private readonly secret: string;
  private readonly requireSignature: boolean;
  private readonly replayWindowMs: number;

  /** Gesehene Kennungen mit dem Zeitpunkt des Eingangs. */
  private gesehen = new Map<string, number>();

  constructor(options: AuthOptions) {
    this.secret = options.secret ?? '';
    this.requireSignature = options.requireSignature ?? false;
    this.replayWindowMs = options.replayWindowMs ?? 24 * 3600_000;
  }

  istEingerichtet(): boolean {
    return this.secret.length > 0;
  }

  /**
   * Prueft Geheimnis und Signatur.
   *
   * `roherRumpf` muss der Text sein, wie er ankam — nicht das Ergebnis
   * von `JSON.stringify(JSON.parse(...))`. Schon eine andere
   * Feldreihenfolge ergibt eine andere Signatur.
   */
  pruefeHerkunft(args: {
    geheimnisAusPfad?: string;
    geheimnisAusRumpf?: string;
    signatur?: string;
    roherRumpf: string;
  }): AuthResult {
    if (!this.istEingerichtet()) {
      return {
        ok: false,
        failure: 'kein_geheimnis',
        message: 'Kein Webhook-Geheimnis hinterlegt — der Webhook nimmt nichts an',
      };
    }

    if (this.requireSignature) {
      if (!args.signatur) {
        return { ok: false, failure: 'signatur_fehlt', message: 'Signatur verlangt, aber keine mitgeschickt' };
      }
      if (!this.signaturStimmt(args.roherRumpf, args.signatur)) {
        return { ok: false, failure: 'signatur_falsch', message: 'Signatur passt nicht zum Rumpf' };
      }
      return { ok: true };
    }

    const angeboten = args.geheimnisAusPfad ?? args.geheimnisAusRumpf;
    if (angeboten && this.gleich(angeboten, this.secret)) {
      return { ok: true };
    }

    // Auch ohne Pflicht wird eine mitgeschickte Signatur anerkannt.
    if (args.signatur && this.signaturStimmt(args.roherRumpf, args.signatur)) {
      return { ok: true };
    }

    return { ok: false, failure: 'geheimnis_falsch', message: 'Geheimnis stimmt nicht' };
  }

  /**
   * War diese Kennung schon da?
   *
   * TradingView schickt denselben Alarm bei Netzproblemen mehrfach. Ohne
   * dieses Gedaechtnis wuerde aus einem Signal zweimal dieselbe Position.
   */
  pruefeWiedereinspielung(signalId: string): AuthResult {
    this.raeumeAuf();
    if (this.gesehen.has(signalId)) {
      const vorher = this.gesehen.get(signalId)!;
      const sekunden = Math.round((Date.now() - vorher) / 1000);
      return {
        ok: false,
        failure: 'bereits_gesehen',
        message: `Signal "${signalId}" kam vor ${sekunden} s schon einmal an`,
      };
    }
    return { ok: true };
  }

  /** Kennung vormerken. Erst aufrufen, wenn das Signal angenommen wurde. */
  merkeVor(signalId: string): void {
    this.gesehen.set(signalId, Date.now());
  }

  /**
   * Bereits bekannte Kennungen aus der Datenbank uebernehmen, damit ein
   * Neustart kein Signal zum zweiten Mal annimmt.
   */
  ladeBekannte(eintraege: Array<{ signalId: string; empfangenMs: number }>): void {
    for (const e of eintraege) this.gesehen.set(e.signalId, e.empfangenMs);
    this.raeumeAuf();
  }

  /** Signatur zu einem Rumpf bilden — fuer Tests und zum Nachrechnen. */
  bildeSignatur(roherRumpf: string): string {
    return createHmac('sha256', this.secret).update(roherRumpf, 'utf8').digest('hex');
  }

  private signaturStimmt(roherRumpf: string, angeboten: string): boolean {
    // Erlaubt sowohl "abc123" als auch "sha256=abc123".
    const bereinigt = angeboten.trim().replace(/^sha256=/i, '');
    return this.gleich(bereinigt, this.bildeSignatur(roherRumpf));
  }

  /** Vergleich mit gleichbleibender Laufzeit. */
  private gleich(a: string, b: string): boolean {
    const pufferA = Buffer.from(a, 'utf8');
    const pufferB = Buffer.from(b, 'utf8');
    if (pufferA.length !== pufferB.length) {
      // Auch bei ungleicher Laenge einmal vergleichen, damit die Dauer
      // nicht schon die Laenge verraet.
      timingSafeEqual(pufferA, pufferA);
      return false;
    }
    return timingSafeEqual(pufferA, pufferB);
  }

  private raeumeAuf(): void {
    const grenze = Date.now() - this.replayWindowMs;
    for (const [id, zeit] of this.gesehen) {
      if (zeit < grenze) this.gesehen.delete(id);
    }
  }
}
