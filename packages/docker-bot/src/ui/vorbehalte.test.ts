// ============================================================
// Der Vorbehalt zur Messreihe muss sichtbar bleiben
//
// Die Uebungsdaten enthalten bekannte Verfaelschungen aus Fehlern,
// die inzwischen behoben sind — allen voran neun Zwangsschliessungen
// vom 02.11.2026, die wie Trades aussehen, aber keine sind.
//
// Die Daten wurden bewusst NICHT nachtraeglich korrigiert: Eine
// stillschweigend geaenderte Messreihe ist schlimmer als eine mit
// bekannten Luecken. Damit haengt alles daran, dass der Vorbehalt
// gelesen wird — und ein Vermerk, der nur in docs/ liegt, wird beim
// Auswerten nicht gelesen.
//
// Diese Tests wachen darueber, dass der Hinweis an der Stelle bleibt,
// an der die Zahlen betrachtet werden.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const WURZEL = join(hier, '..', '..', '..', '..');

const INDEX = join(hier, 'public', 'index.html');
const VERMERK = join(WURZEL, 'docs', 'DATENVORBEHALTE-AUSWERTUNG.md');

describe('Vorbehalte zur Messreihe', () => {
  it('der Vermerk existiert', () => {
    expect(existsSync(VERMERK), `${VERMERK} fehlt`).toBe(true);
  });

  it('steht auf der Auswertungsseite, nicht nur in docs/', () => {
    const html = readFileSync(INDEX, 'utf-8');

    // Innerhalb des Auswertungs-Abschnitts, nicht irgendwo.
    const abschnitt = html.slice(html.indexOf('id="page-auswertung"'));
    const bisZumEnde = abschnitt.slice(0, abschnitt.indexOf('</section>'));

    expect(bisZumEnde).toContain('aw-vorbehalte');
    expect(bisZumEnde).toContain('DATENVORBEHALTE-AUSWERTUNG.md');
  });

  it('nennt den Stichtag und die Zahl der Fremdbuchungen', () => {
    const html = readFileSync(INDEX, 'utf-8');

    // Ohne diese beiden Angaben ist der Hinweis eine Floskel: Erst
    // sie machen ihn nachpruefbar.
    expect(html).toContain('02.11.2026, 10:06');
    expect(html).toMatch(/9 Buchungen/);
  });

  it('steht VOR den Kennzahlen', () => {
    const html = readFileSync(INDEX, 'utf-8');
    const hinweis = html.indexOf('aw-vorbehalte');
    const kennzahlen = html.indexOf('id="aw-kennzahlen"');

    expect(hinweis).toBeGreaterThan(-1);
    expect(kennzahlen).toBeGreaterThan(-1);
    // Darunter wuerde er uebersehen — die Zahlen stehen oben.
    expect(hinweis).toBeLessThan(kennzahlen);
  });

  it('fuehrt im Vermerk jeden Befund mit Zeitraum und Wirkung', () => {
    const text = readFileSync(VERMERK, 'utf-8');

    for (const stichwort of [
      'Hebel', 'freie Margin', 'Break-Even', 'letzte erreichte Ziel',
      'ohne Stop', 'Bereinigung',
    ]) {
      expect(text, `Befund "${stichwort}" fehlt`).toContain(stichwort);
    }

    // Ein Vorbehalt ohne Zeitraum ist nicht anwendbar.
    expect(text).toContain('26.10.2026');
    expect(text).toContain('02.11.2026');

    // Und ohne Handlungsanweisung bleibt er folgenlos.
    expect(text).toContain('Prüfpunkte');
  });

  it('nennt die Zahlen mit und ohne die Fremdbuchungen', () => {
    const text = readFileSync(VERMERK, 'utf-8');

    // 61 Trades laut Konto, 52 nach Abzug der neun Zwangsschliessungen.
    expect(text).toContain('61');
    expect(text).toContain('52');
    expect(text).toContain('46,2');
  });
});
