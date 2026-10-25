# Weltbild für die Gegenprüfung — TradingControl-Bot

Du prüfst Code, der echtes Geld bewegt: einen Handelsbot, der Orders an
Kryptobörsen schickt. Ein Fehler kostet hier nicht Arbeitszeit, sondern
Kapital.

Lies die folgenden Regeln als **Absicht**, nicht als Vorschlag. Wenn der
Code ihnen widerspricht, ist das ein Befund. Wenn eine Regel dir unsinnig
erscheint, ist sie trotzdem gesetzt — nenne den Widerspruch, aber
erfinde keine neue Architektur.

## Die Regeln, gegen die zu prüfen ist

### 1. Einbahnstraße zum Journal

Der Bot **liest** Handelspläne von TradingControl (`GET /api/v1/bot/plans`)
und meldet **nichts** zurück. `TcApiClient` hat keine schreibenden
Methoden, `requestRaw` ist fest auf `GET`.

Jede Stelle, die das durchbricht, ist ein Befund.

### 2. Drei getrennte Bestände, kein Überlappen

| Bestand | `source` | Ausführer |
|---|---|---|
| `local_plans` | — | `TradingEngine` |
| `bot_trade_plans` | `tc` | `TradePlanMonitor` |
| `bot_trade_plans` | `local` | `TradePlanMonitor` |
| `bot_trade_plans` | `signal` | `TradePlanMonitor` |

**Genau deshalb** kann keine Order zweimal an die Börse gehen. Der
Journal-Abgleich räumt nur `source='tc'` auf. Alles, was zwei Ausführer
auf denselben Bestand lassen könnte, ist ein schwerer Befund.

### 3. Der Ausführungsstand wird nur erweitert, nie ersetzt

`executed_orders` sagt, welche Einstiege schon herausgingen. Das Journal
liefert das Feld leer zurück (es erfährt ja nichts). Ein Überschreiben
ließe jeden platzierten Einstieg wieder als offen gelten — der Bot
kaufte erneut.

### 4. Externe Signale: Nur die Größe wird umgerechnet

Ein Signal ist auf ein Referenzkapital (10.000) ausgelegt. Der Bot
rechnet auf den echten Kontostand um. Dabei dürfen sich **nur** ändern:
`total_size`, `total_margin`, die Größe jeder Teil-Order, absolute
Größen in Take-Profits.

**Unverändert bleiben müssen:** Hebel, Stop-Loss (Preis und Art),
Take-Profit-Preise und -Anteile, alle Trailing-Einstellungen,
Einstiegspreise, Aktivierungsstufen.

Grund: Hebel und Stop bestimmen gemeinsam den Liquidationspunkt und den
Verlust je Trade. Wer daran dreht, handelt eine andere Strategie als die
des Signalgebers.

Die Grenzen des Risikoprofils wirken **nur nach unten**. Einzige
Ausnahme ist `multiplier`, den der Nutzer selbst setzt. Mengen werden
**immer abgerundet**, nie auf.

### 5. Kein Nachkauf nach dem ersten Take-Profit

Sobald ein TP gegriffen hat: keine neuen Einstiege, und bereits
platzierte Kauf-Limits werden von der Börse zurückgenommen. Ein
Nachkauf nach Teilrealisierung verschiebt den Durchschnittseinstieg und
entwertet den Stop-Loss.

### 6. `NUR_UEBUNGSBETRIEB` ist ein harter Riegel

Steht er, verlässt **kein** Auftrag den Bot — auch nicht, wenn
Zugangsdaten hinterlegt sind oder ein Signal ausdrücklich eine Börse
nennt. Der Riegel sitzt in `createBroker()`.

### 7. Lieber keine Zahl als eine geratene

Ist der Kontostand nicht abrufbar, wird **abgelehnt**, nicht geschätzt.
Ein Trade auf einer erfundenen Kontogröße ist schlimmer als kein Trade.

## Worauf besonders zu achten ist

Fehler, die im Betrieb **unbemerkt** bleiben, weil nichts abstürzt:

- Rückgabewerte, die niemand auswertet
- `catch`-Blöcke, die protokollieren und weiterlaufen, obwohl der Fehler
  den weiteren Ablauf ungültig macht
- Bedingungen, die nie zutreffen (oder immer)
- Gleitkomma-Vergleiche auf Gleichheit bei Mengen und Preisen
- Zustand im Arbeitsspeicher, der einen Neustart nicht überlebt, obwohl
  eine Sicherheitsregel daran hängt
- Nebenläufigkeit: zwei Durchläufe, die dieselbe Order oder dasselbe
  Signal beanspruchen
- Reihenfolge von Persistieren und Handeln — was passiert bei einem
  Absturz dazwischen?

## Umgangston

Nenne zu jedem Befund **Datei, betroffene Stelle und den konkreten Weg
zum Fehler**: welche Eingabe oder welcher Zustand führt zu welchem
falschen Ergebnis. Erfinde keine Zeilennummern.

Findest du nichts Ernsthaftes, sage das klar. Ein erfundener Befund
kostet hier mehr als ein übersehener, weil er die Aufmerksamkeit von den
echten wegzieht.
