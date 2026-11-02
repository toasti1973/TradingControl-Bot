// ============================================================
// Kopiert die Weboberflaeche nach dist/
//
// `tsc` uebersetzt nur TypeScript und laesst alles andere liegen. Die
// Oberflaeche besteht aber aus HTML, CSS und reinem JavaScript — sie
// landete deshalb nie im Build.
//
// Bisher fiel das nicht auf, weil das Dockerfile die Dateien von Hand
// hinterherkopiert. Wer den Bot ohne Docker ausrollt, bekam einen
// Server, der seine eigene Oberflaeche nicht findet und auf jede Seite
// mit einem leeren 200 antwortet.
// ============================================================

import { cp, access, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = join(hier, '..', 'src', 'ui', 'public');
const ziel = join(hier, '..', 'dist', 'ui', 'public');

try {
  await access(quelle);
} catch {
  console.error(`Oberflaeche nicht gefunden: ${quelle}`);
  process.exit(1);
}

// Erst raeumen: Sonst bleiben Dateien liegen, die es in der Quelle nicht
// mehr gibt, und werden weiter ausgeliefert.
await rm(ziel, { recursive: true, force: true });
await cp(quelle, ziel, { recursive: true });

// ============================================================
// Den Versionsstempel der Skripte auffrischen
//
// Die index.html laedt ihre Skripte mit `?v=...`. Bleibt der Stempel
// gleich, liefert der Browser nach einem Ausrollen weiter die alte
// Fassung aus seinem Zwischenspeicher — und zwar beliebig lange.
//
// Am 26.10. fuehrte das zu einer Oberflaeche, die HTML als Text
// anzeigte: Die neue index.html rief eine Funktion mit drei
// Parametern auf, waehrend der Browser noch die alte Fassung mit
// zweien im Speicher hatte. Der Fehler sass nicht im Code, sondern
// zwischen den Fassungen.
//
// Der Stempel kommt aus der Bauzeit — bei jedem Build ein neuer.
const stempel = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const indexPfad = join(ziel, 'index.html');

try {
  const roh = await readFile(indexPfad, 'utf8');
  const frisch = roh.replace(/(\.(?:js|css))\?v=[^"']*/g, `$1?v=${stempel}`);

  if (frisch !== roh) {
    await writeFile(indexPfad, frisch, 'utf8');
    console.log(`Versionsstempel gesetzt: ${stempel}`);
  }
} catch (err) {
  // Ohne frischen Stempel ist der Build brauchbar, nur der Browser
  // koennte eine alte Fassung behalten. Das darf nicht zum Abbruch
  // fuehren, muss aber auffallen.
  console.warn('Versionsstempel nicht gesetzt:', err.message);
}

console.log(`Oberflaeche kopiert: src/ui/public -> dist/ui/public`);
