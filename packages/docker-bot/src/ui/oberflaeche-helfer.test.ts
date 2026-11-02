// ============================================================
// Die Hilfsfunktionen der Oberflaeche
//
// Geprueft werden hier zwei Entscheidungen, die in app.js fallen und
// beide sichtbar danebengehen koennen:
//
//   zahlAus()            bestimmt, ob eine geaenderte Zelle gruen oder
//                        rot aufleuchtet. Verliest sie sich, leuchtet
//                        ein Gewinn rot — die Anzeige behauptete dann
//                        das Gegenteil dessen, was geschah.
//
//   istBeendeterStatus() entscheidet, ob ein Plan unter den aktiven
//                        steht oder unter den erledigten. Ein laufender
//                        Trade in der unteren Liste wird uebersehen.
//
// Die Oberflaeche laeuft im Browser ohne Modulsystem; ihre Funktionen
// liegen im globalen Namensraum. Der Test holt sie deshalb aus der
// Quelldatei heraus und wertet sie in einer eigenen Umgebung aus —
// besser als eine zweite Abschrift, die mit der Zeit auseinanderlaeuft.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = readFileSync(join(hier, 'public', 'js', 'app.js'), 'utf8');

/**
 * Wertet app.js aus und gibt die gesuchten Funktionen zurueck.
 *
 * Auf oberster Ebene stehen dort Variablen, Funktionen und ein
 * einziger Browser-Zugriff: die Anmeldung an DOMContentLoaded. Dafuer
 * genuegt ein Platzhalter — ausgefuehrt wird der Rumpf ohnehin nie,
 * weil das Ereignis hier niemals eintritt.
 */
function ladeHelfer(): {
  zahlAus: (text: unknown) => number | null;
  istBeendeterStatus: (status: string) => boolean;
} {
  const attrappe = { addEventListener(): void { /* kein Browser, kein Ereignis */ } };

  const bauen = new Function(
    'document', 'window', 'localStorage',
    quelle + '\nreturn { zahlAus: zahlAus, istBeendeterStatus: istBeendeterStatus };',
  ) as (d: unknown, w: unknown, l: unknown) => {
    zahlAus: (t: unknown) => number | null;
    istBeendeterStatus: (s: string) => boolean;
  };

  return bauen(attrappe, attrappe, {});
}

const { zahlAus, istBeendeterStatus } = ladeHelfer();

describe('zahlAus — die Zahl hinter dem Text', () => {
  it('liest die deutsche Schreibweise mit Tausenderpunkt', () => {
    // So gibt geld() aus: toLocaleString('de-DE').
    expect(zahlAus('1.030,59')).toBeCloseTo(1030.59, 6);
    expect(zahlAus('9.998,61 USDT')).toBeCloseTo(9998.61, 6);
  });

  it('liest die englische Schreibweise aus toFixed', () => {
    // Kein Komma im Text heisst: Der Punkt trennt die Nachkommastellen.
    // Ihn als Tausenderpunkt zu lesen machte aus 75.57 die Zahl 7557.
    expect(zahlAus('75.57')).toBeCloseTo(75.57, 6);
    expect(zahlAus('30.71817556')).toBeCloseTo(30.71817556, 8);
  });

  it('nimmt das Vorzeichen mit', () => {
    expect(zahlAus('+8,07 USDT')).toBeCloseTo(8.07, 6);
    expect(zahlAus('-1,61 USDT')).toBeCloseTo(-1.61, 6);
    expect(zahlAus('(+6,98)')).toBeCloseTo(6.98, 6);
  });

  it('liest den Fortschritt aus "E 2/4"', () => {
    // Die erste Zahl ist die gefuellte Stufe. Steigt sie, ist ein
    // Einstieg hinzugekommen — die Zelle leuchtet gruen auf.
    expect(zahlAus('▮▮▯▯ E 2/4')).toBe(2);
    expect(zahlAus('TP 0/4')).toBe(0);
  });

  it('gibt null zurueck, wo keine Zahl steht', () => {
    // Dann bleibt es beim neutralen Aufleuchten — eine Richtung zu
    // behaupten, die es nicht gibt, waere schlechter als keine.
    expect(zahlAus('–')).toBeNull();
    expect(zahlAus('active')).toBeNull();
    expect(zahlAus('')).toBeNull();
    expect(zahlAus(null)).toBeNull();
  });

  it('erkennt die Richtung eines fallenden Kurses', () => {
    const vorher = zahlAus('75,64');
    const nachher = zahlAus('75,57');
    expect(vorher).not.toBeNull();
    expect(nachher).not.toBeNull();
    expect(nachher!).toBeLessThan(vorher!);
  });
});

describe('istBeendeterStatus — aktiv oder erledigt', () => {
  it('nennt abgeschlossene, stornierte und fehlgeschlagene Plaene erledigt', () => {
    expect(istBeendeterStatus('completed')).toBe(true);
    expect(istBeendeterStatus('cancelled')).toBe(true);
    // 'error' gehoert dazu: Der Plan handelt nicht mehr, auch wenn er
    // nicht planmaessig endete.
    expect(istBeendeterStatus('error')).toBe(true);
  });

  it('laesst laufende Plaene aktiv', () => {
    // 'planned' ist der heikle Fall: Ein Plan, der auf seine
    // Aktivierungsbedingung wartet, wird sehr wohl ueberwacht. Unter
    // den erledigten abgelegt, entginge er dem Blick.
    expect(istBeendeterStatus('planned')).toBe(false);
    expect(istBeendeterStatus('active')).toBe(false);
    expect(istBeendeterStatus('monitoring')).toBe(false);
    expect(istBeendeterStatus('executing')).toBe(false);
  });

  it('behandelt Unbekanntes als aktiv', () => {
    // Im Zweifel sichtbar lassen: Ein uebersehener laufender Plan ist
    // der teurere Fehler.
    expect(istBeendeterStatus('was-auch-immer')).toBe(false);
  });
});
