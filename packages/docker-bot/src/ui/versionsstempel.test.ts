// ============================================================
// Der Versionsstempel der Oberflaeche
//
// Die index.html laedt ihre Skripte mit `?v=...`. Bleibt der Stempel
// ueber ein Ausrollen hinweg gleich, liefert der Browser weiter die
// alte Fassung aus seinem Zwischenspeicher — beliebig lange.
//
// Am 26.10. fuehrte das zu einer Oberflaeche, die HTML als Text
// anzeigte: Die neue Seite rief `kachel()` mit drei Parametern auf,
// waehrend der Browser noch die Fassung mit zweien im Speicher hatte.
// Der Fehler sass nicht im Code, sondern zwischen den Fassungen — und
// er ist von aussen kaum zu erkennen, weil beide Dateien fuer sich
// genommen richtig sind.
//
// `copy-ui.mjs` setzt den Stempel deshalb bei jedem Build neu. Diese
// Tests wachen darueber, dass die Skripte ueberhaupt einen tragen.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = readFileSync(join(hier, 'public', 'index.html'), 'utf8');

/** Alle eingebundenen eigenen Skripte und Stylesheets. */
function eingebunden(html: string): string[] {
  const treffer: string[] = [];
  const muster = /(?:src|href)="(\/(?:js|css)\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = muster.exec(html)) !== null) treffer.push(m[1]!);
  return treffer;
}

describe('Oberflaeche — Versionsstempel', () => {
  it('bindet jedes eigene Skript mit einem Stempel ein', () => {
    const ohne = eingebunden(quelle).filter(p => !p.includes('?v='));

    // Ohne Stempel behaelt der Browser die Datei, bis er von selbst
    // aufgibt — und das kann Tage dauern.
    expect(ohne).toEqual([]);
  });

  it('bindet alle Dateien ein, die es gibt', () => {
    // Eine Datei, die im Verzeichnis liegt, aber nirgends eingebunden
    // ist, wird nie geladen — und ihr Fehlen faellt erst auf, wenn
    // eine Funktion daraus gebraucht wird.
    const pfade = eingebunden(quelle).map(p => p.split('?')[0]!);

    for (const datei of ['/js/app.js', '/js/signale.js', '/js/chart.js',
                         '/js/auswertung.js', '/css/style.css']) {
      expect(pfade).toContain(datei);
    }
  });

  it('verweist nur auf Dateien, die wirklich da sind', () => {
    const fehlend = eingebunden(quelle)
      .map(p => p.split('?')[0]!)
      .filter(p => !existsSync(join(hier, 'public', p)));

    expect(fehlend).toEqual([]);
  });

  it('setzt copy-ui.mjs den Stempel bei jedem Build neu', () => {
    // Die Pruefung gilt dem Bauwerkzeug selbst: Ohne diesen Schritt
    // bliebe der Stempel aus der Quelle stehen, und das Problem waere
    // nur verschoben.
    const werkzeug = readFileSync(
      join(hier, '..', '..', 'scripts', 'copy-ui.mjs'), 'utf8',
    );

    expect(werkzeug).toContain('Versionsstempel');
    expect(werkzeug).toMatch(/\?v=\$\{stempel\}/);
  });
});
