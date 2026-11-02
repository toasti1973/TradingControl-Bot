// ============================================================
// Die Auswertung — taugt der Signalgeber?
//
// Drei Routen, die dieselbe Frage aus drei Richtungen beantworten:
//
//   /api/kennzahlen          Was die Trades in R hergaben
//   /api/kennzahlen/verlauf  Wie das Konto dabei lief
//   /api/kennzahlen/ausschlaege  Wo Stop und Ziele falsch sassen
//
// Die dritte ist getrennt, weil sie je Trade Kerzen von der Boerse
// braucht. Wer nur die Zahlen ueberfliegen will, soll nicht darauf
// warten muessen.
// ============================================================

import { Router } from 'express';

import type { SqliteStore } from '../../store/sqlite-store.js';
import type { KerzenService } from '../../services/kerzen-service.js';
import {
  KennzahlenService, ausschlaegeErmitteln, type TradeInR,
} from '../../services/kennzahlen-service.js';
import { verwendetesKapital } from './dashboard.js';

export function createKennzahlenRouter(
  store: SqliteStore,
  kerzen: KerzenService,
): Router {
  const router = Router();
  const dienst = new KennzahlenService(store);

  /**
   * Kennzahlen und Trades.
   *
   * `strategie` filtert auf einen Signalgeber — erst damit lassen
   * sich zwei miteinander vergleichen.
   */
  router.get('/api/kennzahlen', (req, res) => {
    const alle = dienst.trades();
    const gefiltert = filtern(alle, req.query.strategie as string | undefined);

    res.json({
      kennzahlen: dienst.kennzahlen(gefiltert),
      trades: gefiltert,
      /** Welche Signalgeber es ueberhaupt gibt — fuer die Auswahl. */
      strategien: [...new Set(alle.map(t => t.strategie))].sort(),
    });
  });

  router.get('/api/kennzahlen/verlauf', (_req, res) => {
    const trades = dienst.trades();
    res.json(dienst.equityVerlauf(verwendetesKapital(store), trades));
  });

  /**
   * MAE und MFE — wie weit lief jeder Trade gegen und fuer uns.
   *
   * Holt je Symbol Kerzen von der Boerse. Das dauert; die Oberflaeche
   * laedt diesen Teil deshalb erst auf Anforderung.
   */
  router.get('/api/kennzahlen/ausschlaege', async (req, res) => {
    try {
      const alle = dienst.trades();
      const gefiltert = filtern(alle, req.query.strategie as string | undefined);

      // Je Symbol nur EINMAL abfragen, nicht je Trade: Zehn Trades auf
      // HYPEUSDT brauchen dieselben Kerzen.
      const gemerkt = new Map<string, Array<{ timestamp: number; high: number; low: number }>>();

      const auswertung = await ausschlaegeErmitteln(
        gefiltert,
        async (boerse, symbol, marktart) => {
          const schluessel = `${boerse}|${symbol}|${marktart}`;
          const schon = gemerkt.get(schluessel);
          if (schon) return schon;

          // Ein feines Raster, damit Dochte nicht untergehen — genau
          // sie sind hier die Frage. 1000 Minutenkerzen decken gut
          // 16 Stunden ab.
          const antwort = await kerzen.hole(boerse, symbol, '1m', 1000, marktart);
          const liste = antwort.kerzen.map(k => ({
            timestamp: k.timestamp, high: k.high, low: k.low,
          }));
          gemerkt.set(schluessel, liste);
          return liste;
        },
        planId => {
          const plan = store.getBotTradePlan(planId);
          const boerse = String(plan?.exchange ?? 'paper');
          const marktart = plan?.market_type === 'spot' ? 'spot' as const : 'futures' as const;
          return { boerse, marktart };
        },
        // Der Einstieg steckt bereits im Trade; diese Rueckfallebene
        // greift nur, wenn er dort fehlt.
        () => null,
      );

      res.json(auswertung);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Auswertung fehlgeschlagen',
      });
    }
  });

  /**
   * Die Trades als CSV — fuer die Auswertung ausserhalb des Bots.
   *
   * Semikolon als Trenner und Komma als Dezimalzeichen, damit eine
   * deutsche Tabellenkalkulation die Datei ohne Nachfragen oeffnet.
   */
  router.get('/api/kennzahlen.csv', (req, res) => {
    const trades = filtern(dienst.trades(), req.query.strategie as string | undefined);

    const spalten = [
      'Begonnen', 'Beendet', 'Dauer (Min)', 'Strategie', 'Signal-Kennung',
      'Symbol', 'Richtung', 'Menge', 'Einstieg', 'Risiko (R)',
      'Ergebnis', 'R-Vielfaches', 'TPs erreicht', 'Stop getroffen',
    ];

    const zeilen = trades.map(t => [
      t.begonnen ?? '', t.beendet ?? '', t.dauerMinuten,
      t.strategie, t.signalId, t.symbol, t.richtung,
      t.menge, t.einstiegsPreis, t.risiko,
      t.ergebnis, t.rVielfaches, t.tpsErreicht, t.slGetroffen ? 'ja' : 'nein',
    ].map(csvFeld).join(';'));

    const inhalt = [spalten.join(';'), ...zeilen].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="trades-in-r.csv"');
    // Byte Order Mark, damit Excel die Umlaute richtig liest.
    res.send('﻿' + inhalt);
  });

  return router;
}

function filtern(trades: TradeInR[], strategie?: string): TradeInR[] {
  if (!strategie) return trades;
  return trades.filter(t => t.strategie === strategie);
}

function csvFeld(wert: unknown): string {
  if (wert == null) return '';
  if (typeof wert === 'number') {
    return Number.isFinite(wert) ? String(wert).replace('.', ',') : '';
  }
  const text = String(wert);
  if (/[;"\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}
