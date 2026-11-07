# Oberfläche — Analyse und Vorschläge

Ausgangspunkt sind fünfzehn Bildschirmfotos aus fremden Trading-Bot-Projekten
(OPEN Trader, Crypto-Bot, Marketdesk, CryptoBot Pro, ApexCrypto, Jev). Dieses
Dokument sagt, was dort gut gelöst ist, was davon hierher passt, und in welcher
Reihenfolge es sich umsetzen lässt.

**Die gute Nachricht vorweg:** Die Datenbasis trägt das meiste schon.
`KennzahlenService` liefert je Trade `boerse`, `herkunft`, R-Vielfaches,
MAE/MFE, Drawdown und Dauer. Was fehlt, ist fast durchweg die **Darstellung**,
nicht die Rechnung.

---

## 1. Was die Vorlagen richtig machen

### CryptoBot Pro — Leistung je Börse als Tabelle

Die stärkste Einzelidee für unsere Anforderung:

```
EXCHANGE    CYCLES  BUY ACT  SELL ACT  COMPLETED  VOLUME     PROFIT   AVG DURATION
ASTER           95        3         7         85   $890.43    $6.72           1.1d
HYPERLIQUID   1241        5        54       1182 $16163.25  $166.89           7.9d
BITVAVO         42        1        13         28  $1025.19    $2.39           1.8d
```

Dazu **Karten je Börse** mit Free/Locked je Währung und einer Zeile
„BTC Locked: 83 % exposure ($784.41) of Total Capital ($939.61)".

**Was wir übernehmen:** Genau diese Tabelle, nur mit unseren Kennzahlen
(R-Erwartungswert, Profit Factor, Trefferquote). Und die Exposure-Zeile — sie
beantwortet „wieviel hängt hier gerade drin?" ohne Rechnen.

### ApexCrypto — der Betriebsmodus gehört in die Kopfzeile

```
BOT: STOPPED   [START BOT]  [HALT]   [Reset]   DEMO MODE | LIVE MODE
```

Der Umschalter steht ganz oben, dauerhaft sichtbar, zweifarbig.

**Für uns heikel und deshalb wichtig:** Seit Regel 5a entscheidet jede Börse
für sich, ob sie übt. Es gibt keinen einzelnen Schalter mehr — also muss die
Kopfzeile zeigen, **welche** Börsen echt handeln. Ein Feld „2 von 5 Börsen im
Echthandel" in Warnfarbe, das beim Anklicken die Liste aufklappt.

Ebenfalls übernehmenswert: der Bereich **Risk Control** mit den Regeln als
lesbare Karten („Daily Loss Circuit Breaker: 4 %") und einem Rechner, der die
Positionsgröße vorführt. Unsere Risikogrenzen stehen heute in den
Einstellungen als Zahlenfelder, ohne dass man ihre Wirkung sieht.

### Marketdesk — die Statuszeile am unteren Rand

```
● Sample data, read-only   No API keys stored   Paper trading only
```

Unaufdringlich, immer da, beantwortet die Frage „womit arbeite ich gerade?".

**Für uns:** `● Übungsbetrieb · 3 Pläne aktiv · Rückkanal verbunden · letzte
Kursabfrage vor 2 s`. Das ersetzt mehrere Blicke ins Protokoll.

### Crypto-Bot — Börsen-Icon als eigene Spalte

In den Tabellen steht ganz links eine schmale Spalte `E` mit dem Börsen-Logo.
Kein Text, keine Breite verschwendet, sofort erkennbar.

**Für uns:** Genau so, plus das Asset-Logo neben dem Symbol.

### OPEN Trader — Kennzahlen als Label-Wert-Paare mit Icon

Die rechte Seitenleiste führt Status, Paar, High/Low, Grid-Stufen jeweils als
Zeile mit Symbol, Bezeichnung und Wert. Ruhig, gut lesbar, ohne Rahmenwerk um
jeden Wert.

**Für uns:** Die Detailansicht eines Plans ist heute eine Kachelwand. Als
Seitenleiste mit solchen Zeilen wäre sie ruhiger — und es bliebe Platz für den
Chart.

---

## 2. Der Ist-Zustand, ehrlich

| | |
|---|---|
| Seiten | 10 (Dashboard, Pläne, Tradeplanung, Trade Plans, Signale, Trades, Auswertung, CopyTrading, Einstellungen, Logs) |
| Umfang | ~7.400 Zeilen HTML/CSS/JS, handgeschrieben, ohne Framework |
| Stärken | Auswertung mit R-Kennzahlen und Equity-Kurve; Chart mit Plan-Marken; Auto-Aktualisierung ohne Flackern |
| Schwächen | siehe unten |

**Was fehlt oder stört:**

1. **Keine Leistung je Börse oder Signalquelle.** Die Auswertung filtert nach
   Strategie, aggregiert aber nicht. Bei mehreren Börsen ist das die
   wichtigste Frage überhaupt.
2. **Keine Logos.** Börsen und Assets stehen als Text da; bei zehn Zeilen
   kostet das Lesezeit.
3. **Kein Kalender.** Tagesergebnisse lassen sich nur aus der Equity-Kurve
   ablesen.
4. **Der Betriebsmodus ist nicht sichtbar.** Welche Börse übt, welche nicht —
   das steht nur in den Einstellungen. Seit Regel 5a ist das die gefährlichste
   Lücke der Oberfläche.
5. **Zehn gleichrangige Seiten.** „Pläne", „Trade Plans" und „Tradeplanung"
   sind drei Einträge, deren Unterschied man kennen muss.
6. **Nicht für kleine Bildschirme gebaut.** Tabellen mit zwölf Spalten, feste
   Breiten, kein Umbruch.

---

## 3. Vorschläge, nach Wirkung sortiert

### 3.1 Leistung je Börse und Signalquelle — der größte Hebel

Eine neue Ansicht in der Auswertung, zwei Tabellen untereinander:

```
NACH BÖRSE
Börse      Trades  Treffer  Ø R     Profit Factor  Ergebnis   Ø Dauer   gebunden
▣ Phemex       34     47 %  +0,12           1,18   +124,50 €     4,2 h   1.230 €
▣ Bybit        12     58 %  +0,41           1,67    +89,20 €     2,1 h     410 €
▢ Übung        18     44 %  −0,08           0,91    −31,10 €     6,0 h       0 €

NACH SIGNALQUELLE
Quelle         Trades  Treffer  Ø R     Profit Factor  Ergebnis   Börse
Synaptrix          41     51 %  +0,22           1,31   +156,30 €   Phemex
TradingView        17     41 %  −0,05           0,94    −18,40 €   Bybit
TC-Journal          6     67 %  +0,88           2,10    +67,00 €   Phemex
```

Jede Zeile anklickbar → filtert die Equity-Kurve und die Tradeliste darunter.

**Aufwand gering:** `KennzahlenService.kennzahlen()` nimmt bereits eine
Trade-Liste entgegen. Es braucht nur ein `gruppiereNach('boerse' | 'herkunft')`,
das die Liste aufteilt und die bestehende Rechnung je Gruppe aufruft.

**Wichtig:** Die Zeile „Übung" gehört getrennt ausgewiesen und **nicht** in die
Gesamtsumme. Übungsergebnisse und echte Ergebnisse zu addieren ergäbe eine
Zahl, die nichts bedeutet.

### 3.2 Kalenderansicht

Ein Monatsraster, je Tag eine Zelle:

```
        Mo      Di      Mi      Do      Fr      Sa      So
         1       2       3       4       5       6       7
             +12,40  −31,10   +4,20          +8,90
              (3)      (5)     (1)            (2)

Farbe: Grün-/Rotabstufung nach Höhe · Zahl in Klammern = Trades
```

Darunter eine Zeile mit Monatssumme, bestem und schlechtestem Tag. Klick auf
einen Tag öffnet die Trades dieses Tages.

**Umschaltbar zwischen PnL (€) und ROI (%)** — du hast beides genannt, und sie
beantworten verschiedene Fragen: Die Summe sagt, was herauskam; der Prozentwert
sagt, ob der Einsatz es wert war.

**Aufwand mittel.** Die Daten liegen vor (`beendet`, `ergebnis` je Trade); es
ist im Wesentlichen eine Gruppierung nach Datum plus ein CSS-Raster. Keine
Bibliothek nötig.

### 3.3 Logos für Börsen und Assets

**Börsen** (6–8 Stück): als Inline-SVG in einer Datei `boersen-logos.js`,
abrufbar über `boerseLogo('phemex')`. Kein Netzabruf, keine CSP-Probleme,
funktioniert offline.

**Assets** (wachsende Zahl): zwei Stufen.

1. Ein Monogramm aus den ersten Zeichen auf farbigem Kreis, abgeleitet aus dem
   Symbolnamen — damit sieht jedes Asset sofort anständig aus, auch ein neues.
2. Für die zwei Dutzend häufigen Coins echte SVGs, eingebettet.

Der Monogramm-Rückfall ist wichtig: Eine fehlende Grafik darf keine leere
Stelle hinterlassen, und ein Abruf von außen scheitert an der CSP
(`script-src 'self'`).

### 3.4 Betriebsmodus sichtbar machen

Zwei Ergänzungen, beide klein:

**Kopfzeile rechts:**
```
⚠ 2 Börsen im ECHTHANDEL        (rot, aufklappbar)
● alle Börsen im Übungsbetrieb  (grau, wenn nichts echt läuft)
```

**Statuszeile unten, immer sichtbar:**
```
● Übungsbetrieb · 3 Pläne aktiv · 1.230 € gebunden · Rückkanal ✓ · Kurs vor 2 s
```

Seit der globale Riegel entfallen ist (Regel 5a), ist das keine Verzierung,
sondern die einzige Stelle, an der ein versehentlich freigeschalteter
Echthandel auffällt, bevor er handelt.

### 3.5 Detailansicht eines Plans

Heute: eine Wand aus Kacheln, darunter Tabellen, der Chart oben klein.

Vorschlag — zweispaltig:

```
┌─────────────────────────────┬──────────────────────┐
│                             │ ▣ Phemex   ⬤ BNBUSDT │
│   Chart mit Marken          │ ───────────────────  │
│   (Einstiege, Ziele, Stop,  │ Richtung    long 16× │
│    Signalzeitpunkt)         │ Größe      5,456 BNB │
│                             │ Ø Einstieg    739,96 │
│   groß, scrollt mit         │ Kurs    737,55 −0,3% │
│                             │ Stop          737,61 │
├─────────────────────────────┤ ───────────────────  │
│ Einstiege · Ziele · Stop    │ Ergebnis     −6,21 € │
│ (Tabellen, aufklappbar)     │ Rendite       −2,46% │
│                             │ MAE/MFE   −1,2R/+0,8R│
└─────────────────────────────┴──────────────────────┘
```

Der Chart bekommt den Platz, den er verdient — er beantwortet die meisten
Fragen schneller als jede Tabelle. Die Kennzahlen stehen als ruhige
Label-Wert-Zeilen in der Seitenleiste (Vorbild OPEN Trader), nicht als Kacheln.

**Zusätzlich:** ein Verlaufsband unter dem Chart, das die Ereignisse in ihrer
Reihenfolge zeigt — `E1 → E2 → TP1 → SL↑ → SL=E → TS`. Der `VerlaufService`
liefert das bereits; heute steht es als Liste unten.

### 3.6 Weniger Seiten

Zehn Einträge, von denen drei „Plan" heißen. Vorschlag:

| neu | enthält |
|---|---|
| **Übersicht** | heutiges Dashboard |
| **Handel** | Pläne, Trade Plans, Tradeplanung als Reiter |
| **Signale** | wie bisher |
| **Auswertung** | Kennzahlen, Kalender, je Börse/Quelle als Reiter |
| **CopyTrading** | wie bisher |
| **Einstellungen** | inkl. Börsen und Signalquellen |
| **Protokoll** | Logs |

Von zehn auf sieben, und die drei Plan-Ansichten liegen beieinander statt
nebeneinander.

---

## 4. Modernisierung ohne Umbau

Die Oberfläche ist handgeschrieben, ohne Framework — das ist eine Stärke
(keine Abhängigkeiten, CSP-konform, schnell) und sollte so bleiben. Was den
Eindruck hebt, ohne alles umzuwerfen:

**Abstände und Typografie.** Ein durchgehendes 4-px-Raster und drei Schriftgrade
statt gemischter Pixelwerte. Das meiste davon ist CSS-Variablen-Arbeit in
`style.css`.

**Zahlen in Tabellenziffern.** `font-variant-numeric: tabular-nums` — Beträge
stehen dann untereinander bündig. Eine Zeile CSS, große Wirkung bei
Zahlenkolonnen.

**Farbe sparsamer.** Grün und Rot nur für Ergebnisse, nicht zusätzlich für
Status, Richtung und Knöpfe. Status besser über Form und Position.

**Ladezustände.** Heute springen Zahlen beim Aktualisieren. Ein kurzer
Platzhalter in Grauton ist ruhiger.

---

## 5. Der Weg zur Mobile-App

Du willst die Möglichkeit offenhalten. Die billigste Variante, die nichts
verbaut:

**Jetzt:** Die Oberfläche responsiv machen — Tabellen, die unter 900 px zu
Karten umbrechen, Navigation als Leiste am unteren Rand. Das kostet CSS, keine
neue Technik, und macht die Anwendung sofort auf dem Telefon benutzbar.

**Dann:** Eine `manifest.json` und ein Service Worker machen daraus eine
installierbare Web-App (PWA) — mit Symbol auf dem Startbildschirm, ohne
Browserleiste. Zwei kleine Dateien.

**Später, falls nötig:** Eine echte App braucht eine saubere HTTP-Schnittstelle.
Die ist bereits da (`/api/...`), und sie wird durch die Vorschläge oben eher
klarer als unübersichtlicher. Eine native App könnte dieselben Routen nutzen.

**Was man dafür heute lassen sollte:** Keine Logik in die Oberfläche legen, die
nicht auch über die API erreichbar ist. Die Kennzahlen je Börse gehören
deshalb in den `KennzahlenService` und nicht ins JavaScript.

---

## 6. Vorgeschlagene Reihenfolge

| # | Was | Aufwand | Wirkung |
|---|---|---|---|
| 1 | Betriebsmodus in Kopf- und Statuszeile | klein | **Sicherheit** |
| 2 | Leistung je Börse und Signalquelle | klein–mittel | beantwortet die Hauptfrage |
| 3 | Börsen- und Asset-Logos | klein | Lesbarkeit überall |
| 4 | Kalenderansicht | mittel | neue Sicht auf die Daten |
| 5 | Detailansicht zweispaltig | mittel | tägliche Arbeit |
| 6 | Navigation von 10 auf 7 | klein | Orientierung |
| 7 | Typografie, Abstände, Tabellenziffern | klein | Gesamteindruck |
| 8 | Responsiv + PWA | mittel | Telefon |

Die ersten drei zusammen sind etwa ein Arbeitstag und decken den größten Teil
deiner Anforderungen ab.

---

## 7. Was ich nicht vorschlage

**Kein Framework.** React oder Vue brächten Abhängigkeiten, einen Bauschritt
und CSP-Fragen — für eine Oberfläche mit sieben Seiten, die ein Mensch bedient.

**Keine Chart-Bibliothek zusätzlich.** klinecharts liegt bereits vor und
genügt. Die Equity-Kurve ist handgezeichnetes SVG und bleibt es besser.

**Keine Live-Push-Verbindung.** Die Aktualisierung alle zehn Sekunden reicht
für Pläne, die über Stunden laufen. WebSockets kosten Komplexität in beide
Richtungen.

**Keine KI-Signalanzeige wie bei ApexCrypto.** Die Signalbewertung geschieht in
TC-Synaptrix; der Bot führt aus. Diese Trennung ist Absicht und sollte sich in
der Oberfläche spiegeln.

---

## 8. Stand der Umsetzung (04.11.2026)

Alle acht Punkte sind umgesetzt und ausgerollt.

| # | Was | Wo |
|---|---|---|
| 1 | Betriebsmodus in Seitenleiste und Statuszeile | `uebersicht.js`, `/api/handelsplaetze/zustand` |
| 2 | Leistung je Börse / Quelle / Strategie | `KennzahlenService.gruppiert()`, `/api/kennzahlen/gruppen` |
| 3 | Logos für Börsen und Assets | `logos.js` |
| 4 | Kalender mit PnL/ROI-Umschalter | `KennzahlenService.jeTag()`, `/api/kennzahlen/kalender` |
| 5 | Detailansicht zweispaltig | `signale.js`, `.pd-raster` |
| 6 | Navigation gegliedert | `index.html`, `.nav-gruppe` |
| 7 | Typografie, Tabellenziffern, Abstände | `style.css` |
| 8 | Responsiv + installierbar | `manifest.json`, `sw.js`, `@media` |

### Was dabei zusätzlich entstand

**`TradeInR` trägt jetzt `boerse`, `quelle` und `uebung`.** Ohne diese
drei Felder ließ sich die Leistung nicht nach Herkunft aufteilen — die
Börse stand nur im Plan und wurde allein für die Kerzenabfrage gelesen.

**Übung und Echthandel werden nirgends addiert.** Jede Gruppe und jeder
Kalendertag trägt `uebung`; die Oberfläche weist sie getrennt aus und
dämpft Übungszahlen. Ihre Summe wäre eine Zahl ohne Bedeutung: Das eine
ist Kapital, das andere eine Behauptung darüber, was geschehen wäre.

**Der Service Worker speichert keine Daten.** Nur die Hülle (HTML, CSS,
JS, Symbol). Alles unter `/api/` geht ausnahmslos ans Netz — ein
zwischengespeicherter Planstand zeigte im schlimmsten Fall eine
Position, die es nicht mehr gibt.

**`namensraum.test.ts` wacht jetzt über sieben Dateien** statt vier. Die
drei neuen (`handelsplaetze.js`, `logos.js`, `uebersicht.js`) teilen
sich denselben globalen Namensraum; eine Kollision bliebe sonst
unbemerkt, bis die Oberfläche HTML als Text anzeigt.

### Belegt am laufenden System

```
/api/handelsplaetze/zustand   HTTP 200   echtHandelAktiv: false
/api/kennzahlen/gruppen       HTTP 200   48 Trades, paper, PF 0,451
/api/kennzahlen/kalender      HTTP 200   Tage ab 26.10. mit ROI und R
```

612 Tests grün (vorher 599).
