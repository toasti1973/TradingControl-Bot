// ============================================================
// Service Worker — nur so viel, wie eine installierbare App braucht
//
// **Kein Zwischenspeichern von Daten.** Ein Trading-Bot, der
// gespeicherte Kurse oder Planstände ausliefert, zeigt im
// schlimmsten Fall eine Position, die es nicht mehr gibt. Alles
// unter /api/ geht deshalb ausnahmslos ans Netz.
//
// Gespeichert wird allein die Hülle: HTML, CSS, JS, Symbol. Das
// genügt, damit die Anwendung sich installieren lässt und beim
// Start nicht weiß blinkt — die Zahlen holt sie danach frisch.
// ============================================================

const HUELLE = 'tc-bot-huelle-v1';

const DATEIEN = [
  '/',
  '/index.html',
  '/css/style.css',
  '/icon.svg',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(HUELLE)
      // Einzeln, nicht addAll: Scheitert eine Datei, soll nicht die
      // ganze Installation fehlschlagen.
      .then((c) => Promise.allSettled(DATEIEN.map((d) => c.add(d))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(
        namen.filter((n) => n !== HUELLE).map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Alles Dynamische ungefiltert ans Netz. Kein Zwischenspeicher,
  // kein Rückfall auf Altes — eine veraltete Positionsangabe wäre
  // schlimmer als eine Fehlermeldung.
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/webhook/') ||
      e.request.method !== 'GET') {
    return;
  }

  // Für die Hülle: erst das Netz, dann der Speicher. So bekommt man
  // nach einem Ausrollen sofort die neue Fassung und bei fehlender
  // Verbindung wenigstens die alte.
  e.respondWith(
    fetch(e.request)
      .then((antwort) => {
        if (antwort && antwort.ok) {
          const kopie = antwort.clone();
          caches.open(HUELLE).then((c) => c.put(e.request, kopie));
        }
        return antwort;
      })
      .catch(() => caches.match(e.request)),
  );
});
