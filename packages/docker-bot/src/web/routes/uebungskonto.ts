// ============================================================
// Uebungskonto — Verwaltung und Auskunft
//
// Auf diesen Kontostand rechnet der Bot die Groesse jedes Signals um.
// Wer ihn hier aendert, aendert damit die Groesse aller kuenftigen
// Trades — deshalb wird jede Aenderung geprueft und protokolliert.
// ============================================================

import { Router } from 'express';
import type { PaperAccountService } from '../../services/paper-account-service.js';
import type { CapitalService } from '../../services/capital-service.js';
import type { Logger } from '../../services/log-service.js';

/** Hoechstwerte, die noch plausibel sind. */
const MAX_KAPITAL = 100_000_000;
const MAX_GEBUEHR = 0.01;     // 1 % — darueber ist es ein Tippfehler

export function createUebungskontoRouter(
  konto: PaperAccountService,
  capital: CapitalService,
  logger: Logger,
  nurUebungsbetrieb: boolean,
): Router {
  const router = Router();

  // ============================================================
  // Auskunft
  // ============================================================

  router.get('/api/uebungskonto', (_req, res) => {
    const stand = konto.stand();
    const gebuehren = konto.getGebuehren();
    const positionen = konto.positionen();

    res.json({
      uebungsbetrieb: nurUebungsbetrieb,
      stand,
      gebuehren: {
        taker: gebuehren.taker,
        maker: gebuehren.maker,
        taker_prozent: gebuehren.taker * 100,
        maker_prozent: gebuehren.maker * 100,
      },
      positionen,
      // Fuer die Anzeige vorgerechnet, damit die Oberflaeche nicht
      // dieselbe Formel ein zweites Mal fuehren muss.
      kennzahlen: {
        ergebnis: stand.realisiert - stand.gebuehren,
        ergebnis_prozent: stand.startkapital > 0
          ? ((stand.realisiert - stand.gebuehren) / stand.startkapital) * 100
          : 0,
        trefferquote: stand.trades > 0 ? (stand.gewinne / stand.trades) * 100 : null,
        gebuehrenanteil: stand.realisiert !== 0
          ? (stand.gebuehren / Math.abs(stand.realisiert)) * 100
          : null,
      },
    });
  });

  router.get('/api/uebungskonto/buchungen', (req, res) => {
    const limit = Math.min(parseInt((req.query.limit as string) ?? '100', 10) || 100, 1000);
    const art = req.query.art as string | undefined;
    res.json({ buchungen: konto.buchungen(limit, art) });
  });

  // ============================================================
  // Aenderungen
  // ============================================================

  /**
   * Setzt das Konto auf ein neues Startkapital zurueck.
   *
   * Verwirft Handelsgeschichte und Kontoblatt — deshalb ausdruecklich
   * als eigener Aufruf und nicht als Nebenwirkung einer Einstellung.
   */
  router.post('/api/uebungskonto/zuruecksetzen', (req, res) => {
    if (!nurUebungsbetrieb) {
      return void res.status(409).json({
        error: 'Der Bot laeuft nicht im Uebungsbetrieb. Ein Zuruecksetzen waere wirkungslos ' +
               'und wuerde nur die Buchfuehrung verwerfen.',
      });
    }

    const roh = (req.body as { startkapital?: unknown }).startkapital;
    const betrag = typeof roh === 'number' ? roh : Number(roh);

    if (!Number.isFinite(betrag) || betrag <= 0 || betrag > MAX_KAPITAL) {
      return void res.status(400).json({
        error: `startkapital muss eine Zahl zwischen 0 und ${MAX_KAPITAL} sein`,
      });
    }

    const stand = konto.zuruecksetzen(betrag);
    // Der zwischengespeicherte Kontostand ist jetzt falsch.
    capital.entwerte();

    logger.warn({ startkapital: betrag }, 'Uebungskonto ueber die Oberflaeche zurueckgesetzt');
    res.json({ success: true, stand });
  });

  /** Ein- oder Auszahlung, ohne die Handelsgeschichte zu verwerfen. */
  router.post('/api/uebungskonto/einzahlung', (req, res) => {
    if (!nurUebungsbetrieb) {
      return void res.status(409).json({ error: 'Nur im Uebungsbetrieb moeglich' });
    }

    const roh = (req.body as { betrag?: unknown }).betrag;
    const betrag = typeof roh === 'number' ? roh : Number(roh);
    const notiz = (req.body as { notiz?: string }).notiz;

    if (!Number.isFinite(betrag) || betrag === 0 || Math.abs(betrag) > MAX_KAPITAL) {
      return void res.status(400).json({ error: 'betrag muss eine Zahl ungleich 0 sein' });
    }

    const vorher = konto.stand().equity;
    const stand = konto.einzahlen(betrag, notiz);
    capital.entwerte();

    logger.info({ betrag, vorher, nachher: stand.equity }, 'Uebungskonto: Ein-/Auszahlung');
    res.json({ success: true, stand });
  });

  /**
   * Gebuehrensaetze einstellen.
   *
   * Angenommen werden Anteile (0.0006) und Prozentwerte (0.06) — wer
   * "0.06" meint und Prozent denkt, soll nicht das Hundertfache zahlen.
   * Unterschieden wird an der Groesse: Alles ueber 1 % kann nur Prozent
   * gemeint sein.
   */
  router.put('/api/uebungskonto/gebuehren', (req, res) => {
    const eingabe = req.body as Record<string, unknown>;
    const fehler: string[] = [];

    const lies = (name: string): number | undefined => {
      const roh = eingabe[name] ?? eingabe[`${name}_prozent`];
      if (roh === undefined) return undefined;
      const n = typeof roh === 'number' ? roh : Number(roh);
      if (!Number.isFinite(n) || n < 0) {
        fehler.push(`${name} muss eine Zahl ab 0 sein`);
        return undefined;
      }
      // Als Prozent gemeint, wenn ausdruecklich so benannt oder wenn
      // der Wert als Anteil unsinnig hoch waere.
      const alsAnteil = eingabe[`${name}_prozent`] !== undefined || n > MAX_GEBUEHR ? n / 100 : n;
      if (alsAnteil > MAX_GEBUEHR) {
        fehler.push(
          `${name} ergaebe ${(alsAnteil * 100).toFixed(2)} % — ueber ${MAX_GEBUEHR * 100} % ` +
          `ist das kein Gebuehrensatz mehr`,
        );
        return undefined;
      }
      return alsAnteil;
    };

    const taker = lies('taker');
    const maker = lies('maker');

    if (fehler.length > 0) return void res.status(400).json({ error: 'Ungueltig', details: fehler });
    if (taker === undefined && maker === undefined) {
      return void res.status(400).json({ error: 'Weder taker noch maker angegeben' });
    }

    const bisher = konto.getGebuehren();
    const neu = { taker: taker ?? bisher.taker, maker: maker ?? bisher.maker };
    konto.setGebuehren(neu);

    res.json({
      success: true,
      gebuehren: {
        ...neu,
        taker_prozent: neu.taker * 100,
        maker_prozent: neu.maker * 100,
      },
    });
  });

  return router;
}
