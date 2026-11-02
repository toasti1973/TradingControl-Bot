# Vorbehalte bei der Auswertung

**Vor jeder Analyse der Übungsergebnisse lesen.**

Die Messreihe läuft seit dem **26.10.2026, 07:01** (Zurücksetzung auf
10.000 USDT). In diesem Zeitraum wurden Fehler gefunden und behoben,
die einzelne Kennzahlen verfälschen. Die betroffenen Trades stehen
weiterhin in der Datenbank — sie wurden nicht nachträglich korrigiert,
weil eine stillschweigend geänderte Messreihe schlimmer ist als eine
mit bekannten Lücken.

Dieses Dokument sagt, welche Zahl man wann nicht glauben darf.

---

## Kurzfassung

| Zeitraum | Was stimmt nicht | Welche Kennzahl trifft es |
|---|---|---|
| 26.10.–02.11. | Hebel teilweise als 1 gebucht | alle margin-bezogenen (Rendite, Einsatz, gebundene Margin) |
| 26.10.–02.11. | Risikogrenze „freie Margin" wirkungslos | Positionsgrößen, Risiko je Trade |
| bis 27.10. | Break-Even-Stop auf geplante statt echte Staffel | Ergebnis einzelner Trades |
| bis 27.10. | Stop hielt das letzte erreichte Ziel nicht | Ergebnis einzelner Trades |
| 01.11.–02.11. | 8 Positionen ohne Aufsicht und ohne Stop | Trefferquote, Tagesergebnis |
| **02.11., 10:04–10:05** | **9 Zwangsschließungen aus der Bereinigung** | **Trefferquote, Tagesergebnis, R-Vielfache** |

**Uneingeschränkt brauchbar ist die Messreihe erst ab dem
02.11.2026, 10:06.**

---

## 1. Der Hebel wurde teilweise als 1 gebucht

**Zeitraum:** 26.10. bis 02.11.2026, 09:50
**Behoben in:** CLAUDE.md Regel 3cb

Der Übungsbroker hielt den Hebel in einer Map im Arbeitsspeicher.
Seit die Einstiege als Limit-Orders im Orderbuch liegen, vergehen
zwischen dem Platzieren und der Füllung oft Stunden — fiel ein
Neustart dazwischen, war die Map leer und die Füllung wurde mit
Hebel 1 gebucht.

Am 02.11. betraf das zwei von sechs offenen Positionen:

```text
BNBUSDT  Hebel 1 statt 10  →  4.854,18 statt 485,42 USDT Margin
SOLUSDT  Hebel 1 statt 13  →  3.082,81 statt 237,14 USDT Margin
```

**Wirkung auf die Auswertung:**

- **Rendite in Prozent** ist für betroffene Trades zu niedrig — sie
  bezieht sich auf einen zu hohen Einsatz
- **Gebundene Margin** und **freie Margin** waren zeitweise unbrauchbar
- **Absolute Ergebnisse in USDT sind nicht betroffen.** Sie rechnen
  sich aus Ein- und Ausstiegspreis mal Menge; der Hebel geht nicht ein

Wie viele Trades betroffen sind, lässt sich im Nachhinein nicht
feststellen: Der Hebel wurde an der Position gespeichert, nicht an
der einzelnen Buchung.

## 2. Die Risikogrenze „freie Margin" war wirkungslos

**Zeitraum:** derselbe
**Folge von Punkt 1**

Weil die gebundene Margin über dem Kontostand lag, war die freie
Margin rechnerisch 0. Der `PositionScaler` übersprang daraufhin seine
Grenze und vermerkte das bei jedem Signal:

> Kein freier Betrag bekannt — die Grenze der verfügbaren Margin
> wurde übersprungen

**Wirkung:** Positionen konnten größer ausfallen, als das
Risikoprofil erlaubt hätte. Die Grenzen „Höchstverlust je Trade" und
„Margin-Grenze" griffen weiterhin; nur die dritte fiel aus.

Bei der Beurteilung der Positionsgrößen in diesem Zeitraum ist das zu
berücksichtigen — sie sind nicht das Ergebnis des eingestellten
Risikoprofils.

## 3. Break-Even-Stop auf der geplanten statt der echten Staffel

**Zeitraum:** bis 27.10.2026
**Behoben in:** CLAUDE.md Regel 3ac

Die Signale rechnen ihren Break-Even-Stop auf alle geplanten
Einstiege. Füllt davon nur ein Teil — der Regelfall, denn nach dem
ersten Take-Profit werden die restlichen zurückgenommen —, liegt der
Stop unter dem tatsächlichen Einstand.

Belegt am BNBUSDT-Plan vom 26.10.: Stop auf 737,61 (Durchschnitt
aller vier geplanten Einstiege), tatsächlich gefüllt war nur der
erste zu 739,96. Ergebnis **−6,21 USDT trotz erreichtem TP1**.

**Wirkung:** Einzelne Trades vor dem 27.10. endeten negativ, obwohl
die Strategie aufging. Sie sind nicht als Strategiefehler zu werten.

## 4. Der Stop hielt das letzte erreichte Ziel nicht

**Zeitraum:** bis 27.10.2026
**Behoben in:** CLAUDE.md Regel 3ace

Nach dem letzten Take-Profit folgt keine Stufe mehr, die den Stop
nachzieht — ab da trägt allein das Trailing. War dessen Prozentsatz
weiter als der Abstand zwischen den letzten beiden Zielen, blieb
bereits erreichter Gewinn unbesichert.

Belegt am HYPEUSDT-Plan vom 27.10.: TP4 bei 80,1464 erreicht, Stop
danach bei 79,6404, Trailing 1,5 % hätte erst ab Kurs 80,853
gegriffen. 1,11 USDT hingen in der Luft.

**Wirkung:** Trades, bei denen alle Ziele erreicht wurden, können
schlechter abgeschlossen haben, als es nach dem letzten Ziel möglich
gewesen wäre.

## 5. Stornierte Pläne ließen Positionen ohne Stop zurück

**Zeitraum:** bis 02.11.2026, 09:50 — sichtbar geworden am 01.11.
**Behoben in:** CLAUDE.md Regel 3ca

Der Storno-Pfad nahm nur die offenen Orders zurück. Unter ihnen ist
der Stop-Loss; die Position blieb stehen und lief ohne Absicherung
weiter.

Am 01.11. um 21:03 stornierte TC-Synaptrix 42 Pläne auf einmal. Acht
davon hatten eine offene Position. Die BNBUSDT-Position lief danach
einen vollen Tag ungesichert.

**Wirkung:** Diese acht Positionen entwickelten sich ohne jede
Risikosteuerung weiter. Ihr Ergebnis ist kein Strategieergebnis,
sondern das Ergebnis eines Zufalls über 13 Stunden.

## 6. Die Bereinigung am 02.11. — der wichtigste Vorbehalt

**Zeitpunkt:** 02.11.2026, 10:04 bis 10:05

Beim Beheben von Punkt 1 und 5 wurden die acht verwaisten Positionen
geschlossen. In der Datenbank stehen dadurch **neun Buchungen**, die
wie Trades aussehen, aber keine sind:

```text
10:04  ETHUSDT   −128,08
10:05  SOLUSDT     +6,01
10:05  HYPEUSDT    +9,30
10:05  SOLUSDT    +29,75
10:05  BNBUSDT   −278,53
10:05  HYPEUSDT   +16,08
10:05  SOLUSDT   −212,06
10:05  HBARUSDT   +93,81
10:05  HBARUSDT   +92,97
                 ───────
                 −370,75 USDT
```

**Diese neun sind aus der Auswertung zu entfernen.** Sie wurden nicht
von der Strategie geschlossen, sondern von Hand, zu einem beliebigen
Zeitpunkt, weil sie dort nicht mehr hingehörten. Weder ihr
Ein- noch ihr Ausstiegszeitpunkt sagt etwas über die Strategie aus.

Sie verfälschen:

- **Trefferquote** — 6 Gewinne (+247,93) und 3 Verluste (−618,66),
  die keine sind
- **Tagesergebnis 02.11.** — die ausgewiesenen −351,54 USDT bestehen
  zu −370,73 aus der Bereinigung; der Handelstag selbst war mit
  **+19,19 USDT positiv**
- **R-Vielfache und MAE/MFE** — es gab keinen gültigen Stop als Bezug
- **Haltedauern** — teils über eine Woche, ohne Aussagewert

SQL zum Ausschließen — der Zeitstempel steht als ISO-Text mit `T`:

```sql
-- Die Bereinigungsbuchungen übergehen
WHERE NOT (zeitpunkt >= '2026-11-02T10:04' AND zeitpunkt < '2026-11-02T10:06')
```

---

## Was das für die Gesamtzahlen heißt

| | mit Bereinigung | ohne |
|---|---|---|
| Trades | 61 | **52** |
| Gewinne | 30 | **24** |
| Verluste | 31 | **28** |
| Trefferquote | 49,2 % | **46,2 %** |
| realisiert | −1.743,56 | **−1.372,83** |

Von den ausgewiesenen −1.743,56 USDT entfallen **−370,73 auf die
Bereinigung** — und weitere Beträge auf die Punkte 3, 4 und 5, also
auf inzwischen behobene Fehler statt auf die Strategie.

Die Gebühren (335,41 USDT) enthalten ebenfalls die der neun
Bereinigungsbuchungen.

**Ein sauberer Vergleich der Signalqualität ist mit dieser Messreihe
nicht möglich.** Wer die Strategie beurteilen will, sollte das Konto
zurücksetzen und ab dem bereinigten Stand neu messen.

---

## Prüfpunkte für die nächste Auswertung

- [ ] Die neun Bereinigungsbuchungen ausgeschlossen?
- [ ] Margin-bezogene Kennzahlen vor dem 02.11. als unsicher markiert?
- [ ] Trades vor dem 27.10. auf Punkt 3 und 4 geprüft?
- [ ] Die acht Pläne aus Punkt 5 gesondert betrachtet?
- [ ] Ist seit dem 02.11., 10:06 ein neuer Fehler dieser Art
      aufgetreten? (`journalctl -u tc-bot | grep "Kein Hebel"`)

## Verwandte Dokumente

- `CLAUDE.md` — die Regeln 3ac, 3ace, 3ca, 3cb mit den vollständigen
  Begründungen
- `docs/TRADINGVIEW-SIGNALE.md` — wie Signale umgerechnet werden
- Sicherungen vor jedem Eingriff:
  `/opt/tc-bot-sicherung/bot.db.vor-hebelfix-*`,
  `bot.db.vor-hebelkorrektur-*`, `bot.db.vor-aufraeumen-*`
