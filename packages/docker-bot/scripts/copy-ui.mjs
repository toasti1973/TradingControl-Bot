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

import { cp, access, rm } from 'node:fs/promises';
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

console.log(`Oberflaeche kopiert: src/ui/public -> dist/ui/public`);
