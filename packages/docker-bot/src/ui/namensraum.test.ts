// ============================================================
// Ein Namensraum fuer vier Dateien
//
// Die Oberflaeche laeuft ohne Modulsystem: app.js, signale.js,
// chart.js und auswertung.js teilen sich den globalen Namensraum des
// Browsers. Zwei Funktionen gleichen Namens sind damit keine zwei
// Funktionen — die spaeter geladene Datei ueberschreibt die fruehere,
// und zwar stillschweigend.
//
// Das ist zweimal passiert:
//
//   zeitKurz   in signale.js doppelt — fiel beim Bauen auf, weil
//              beide in DERSELBEN Datei standen.
//   kachel     in signale.js (3 Parameter) und auswertung.js (4) —
//              fiel NICHT auf, weil sie in verschiedenen Dateien
//              stehen. Jede fuer sich war richtig. Erst im Browser
//              gewann die spaetere, und die Detailansicht schickte
//              ihren dritten Parameter durch esc(): Sie zeigte HTML
//              als Text an.
//
// Der zweite Fall ist der gefaehrlichere, weil kein Werkzeug ihn
// bemerkt. Dieser Test bemerkt ihn.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const jsPfad = join(hier, 'public', 'js');

/** Die Dateien in der Reihenfolge, in der die Seite sie laedt. */
// Jede Datei, die der Browser gleichzeitig laedt, gehoert hierher.
// Fehlt eine, bemerkt der Test ihre Kollisionen nicht.
const DATEIEN = [
  'app.js', 'signale.js', 'chart.js', 'auswertung.js',
  'handelsplaetze.js', 'logos.js', 'uebersicht.js',
];

/**
 * Funktionen, die eine Datei auf oberster Ebene erklaert.
 *
 * Nur `function name(` am Zeilenanfang — alles Eingerueckte steht
 * innerhalb einer anderen Funktion und ist damit oertlich.
 */
function funktionenVon(inhalt: string): string[] {
  const namen: string[] = [];
  const muster = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = muster.exec(inhalt)) !== null) namen.push(m[1]!);
  return namen;
}

/** Variablen auf oberster Ebene — sie kollidieren genauso. */
function variablenVon(inhalt: string): string[] {
  const namen: string[] = [];
  const muster = /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = muster.exec(inhalt)) !== null) namen.push(m[1]!);
  return namen;
}

const inhalte = new Map(
  DATEIEN.map(d => [d, readFileSync(join(jsPfad, d), 'utf8')]),
);

describe('Oberflaeche — ein gemeinsamer Namensraum', () => {
  it('erklaert keine Funktion in zwei Dateien', () => {
    const woher = new Map<string, string[]>();

    for (const datei of DATEIEN) {
      for (const name of funktionenVon(inhalte.get(datei)!)) {
        woher.set(name, [...(woher.get(name) ?? []), datei]);
      }
    }

    const doppelt = [...woher.entries()]
      .filter(([, dateien]) => new Set(dateien).size > 1)
      .map(([name, dateien]) => `${name} (${[...new Set(dateien)].join(', ')})`);

    // Die spaeter geladene Datei gewinnt — und wenn ihre Fassung eine
    // andere Signatur hat, bricht die fruehere Verwendung still.
    expect(doppelt).toEqual([]);
  });

  it('erklaert keine Funktion zweimal in derselben Datei', () => {
    const doppelt: string[] = [];

    for (const datei of DATEIEN) {
      const gesehen = new Set<string>();
      for (const name of funktionenVon(inhalte.get(datei)!)) {
        if (gesehen.has(name)) doppelt.push(`${name} in ${datei}`);
        gesehen.add(name);
      }
    }

    expect(doppelt).toEqual([]);
  });

  it('erklaert keine Variable oberster Ebene in zwei Dateien', () => {
    const woher = new Map<string, string[]>();

    for (const datei of DATEIEN) {
      for (const name of variablenVon(inhalte.get(datei)!)) {
        woher.set(name, [...(woher.get(name) ?? []), datei]);
      }
    }

    const doppelt = [...woher.entries()]
      .filter(([, dateien]) => new Set(dateien).size > 1)
      .map(([name]) => name);

    expect(doppelt).toEqual([]);
  });

  it('haelt die Dateien syntaktisch fehlerfrei', () => {
    // `new Function` wirft bei einem Syntaxfehler — billiger als ein
    // zweiter Werkzeuglauf und faengt denselben Fall.
    for (const datei of DATEIEN) {
      expect(() => new Function(inhalte.get(datei)!)).not.toThrow();
    }
  });
});

// ============================================================
// Jede API-Anfrage geht durch apiFetch
//
// `apiFetch()` setzt den Anmeldeheader und zeigt bei 401 das eigene
// Login-Fenster. Rohes `fetch('/api/…')` tut beides nicht: Es läuft
// ohne Header, der Server antwortet mit
//
//     WWW-Authenticate: Basic realm="TradingControl Bot"
//
// und daraufhin öffnet der BROWSER seinen eigenen Dialog — mit einem
// Feld für den Benutzernamen, den es in dieser Anwendung gar nicht
// gibt. Am 04.11.2026 geschah genau das, weil drei neue Dateien
// rohes fetch verwendeten.
//
// Der Fehler ist unangenehm, weil er nicht beim Entwickeln auffällt:
// Wer angemeldet ist, bemerkt nichts.
// ============================================================

describe('API-Anfragen gehen durch apiFetch', () => {
  // app.js darf: Dort steht apiFetch selbst, und die Anmeldung kann
  // keinen Header tragen, den sie erst beschafft.
  const OHNE_APP = DATEIEN.filter(d => d !== 'app.js');

  it('ruft nirgends rohes fetch auf /api/ auf', () => {
    const sünder: string[] = [];

    for (const datei of OHNE_APP) {
      const text = readFileSync(join(jsPfad, datei), 'utf8');
      // fetch('/api…) oder fetch("/api…) oder fetch(`/api…
      const treffer = text.match(/\bfetch\s*\(\s*['"`]\/api/g);
      if (treffer) sünder.push(`${datei} (${treffer.length}×)`);
    }

    expect(
      sünder,
      'Diese Dateien rufen rohes fetch auf /api/ — das löst den ' +
      'Browser-Login-Dialog aus. apiFetch() verwenden.',
    ).toEqual([]);
  });
});
