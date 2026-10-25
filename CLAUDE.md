# Projekt-Anweisungen für Claude

## Architektur — verbindliche Regeln

Diese Regeln sind nicht verhandelbar. Wer sie bricht, bricht das System.

### 1. Der Bot meldet NICHTS an TradingControl-Journal zurück

Die Verbindung zum Journal ist eine **Einbahnstraße**: Der Bot liest
Handelspläne über `GET /api/v1/bot/plans` und den Indikator-Katalog. Er
schickt keine Ausführungsdaten, keine Statusmeldungen, nichts.

**Warum:** Was an der Börse tatsächlich geschah, holt sich das Journal über
seinen eigenen API-Import direkt bei der Börse. Das ist die einzige Quelle,
die auch erfasst, was außerhalb des Bots passierte — Teilfüllungen,
Gebühren, Eingriffe von Hand, Liquidationen. Zwei Quellen für dieselbe
Tatsache erzeugen nur Widersprüche.

`TcApiClient` hat deshalb keine schreibenden Methoden, und `requestRaw` ist
fest auf `GET` verdrahtet. Ein Test wacht darüber
(`tc-api-client.test.ts`).

### 2. Der Bot läuft vollständig ohne das Journal

Fällt TradingControl aus oder ist kein API-Schlüssel hinterlegt, arbeitet
der Bot mit seinen eigenen Plänen unverändert weiter. Kein Codepfad darf
das Journal voraussetzen.

### 3. Zwei getrennte Ausführungspfade — niemals überlappend

| Pfad | Bestand | Zuständig |
|------|---------|-----------|
| `TradingEngine` (core) | `local_plans` | einfache, im Bot angelegte Pläne |
| `TradePlanMonitor` (docker-bot) | `bot_trade_plans` | Vollpläne (Trigger, Zonen, per-TP) aus drei Quellen |

Innerhalb von `bot_trade_plans` trennt die Spalte `source` die Herkunft:

| `source` | Woher | Wer räumt auf |
|----------|-------|---------------|
| `tc` | aus dem Journal gespiegelt | `TcPlanSyncService` — **nur diese** |
| `local` | hier im Bot angelegt | der Nutzer |
| `signal` | aus einem externen Handelssignal | der Nutzer bzw. ein `close`/`cancel`-Signal |

Die Bestände überschneiden sich nicht. **Genau deshalb** kann keine Order
zweimal an die Börse gehen. Vor dem Umbau pollten beide Pfade dieselben
Journal-Pläne — mit dem Risiko doppelter Positionen.

`TcPlanSyncService.syncPlans` filtert beim Aufräumen auf `source: 'tc'`.
Diese Einschränkung ist nicht kosmetisch: Ohne sie meldete der Abgleich
lokale und Signal-Pläne ab, weil das Journal sie nicht kennt.

`PlanManager` bekommt seine Pläne über das Interface `PlanSource`. Wer eine
neue Quelle anschließt, muss prüfen, dass sie disjunkt zu den bestehenden
ist.

### 3a. Externe Handelssignale werden auf das eigene Kapital umgerechnet

Signale von außen (TradingView u. ä.) beziehen sich auf ein vereinbartes
Referenzkapital, üblich 10.000 USDT. Der Bot rechnet sie auf den
tatsächlichen Kontostand um.

**Umgerechnet wird ausschließlich die Größe** — `total_size`,
`total_margin` und die Größe jeder Teil-Order. Hebel, Stop-Loss,
Take-Profit-Preise und -Anteile sowie alle Trailing-Einstellungen bleiben
unverändert.

**Warum:** Hebel und Stop bestimmen miteinander, wo die Liquidation liegt
und wieviel Prozent des Einsatzes ein Trade kostet; die
Take-Profit-Preise tragen die Marktmeinung des Signalgebers. Wer daran
dreht, handelt eine andere Strategie als die, die das Signal meinte.

`PositionScaler` setzt das um, `pruefeUnveraendert()` wacht darüber und
wird vor jedem Anlegen eines Plans aufgerufen — findet sich eine
Abweichung in einem geschützten Feld, wird nicht gehandelt. Tests:
`packages/signals/src/position-scaler.test.ts`.

Die Grenzen des Risikoprofils (Höchstverlust je Trade, Margin-Grenze,
freie Margin) wirken **nur nach unten**. Einzige Ausnahme ist der
`multiplier`, den der Nutzer selbst setzt.

Ausführlich: `docs/TRADINGVIEW-SIGNALE.md`.

### 3b. Nach dem ersten Take-Profit wird nicht mehr nachgekauft

Sobald ein Take-Profit gegriffen hat, ist die Einstiegsphase vorbei:

- Noch nicht abgeschickte Einstiege werden **nicht mehr platziert**
- Bereits platzierte Kauf-Limits werden **von der Börse zurückgenommen**

**Warum:** Ein Nachkauf nach einer Teilrealisierung verschiebt den
durchschnittlichen Einstieg nach oben (beim Long) und entwertet damit
den Stop-Loss, der für den ursprünglichen Einstieg bemessen war. Aus
einem Trade mit bekanntem Risiko würde einer mit unbekanntem — und im
unglücklichen Fall eine Position, die nach mitgenommenem Gewinn größer
ist als vorher.

Umgesetzt in `TradePlanMonitor`:

- `istEinstiegsphaseBeendet()` — leitet die Sperre aus `tpState` ab,
  nicht aus einem eigenen Merker. Der TP-Zustand liegt in
  `bot_trade_plan_monitors.tp_state` und überlebt einen Neustart.
- `executeTpHit()` ruft `persistMonitor()` **unmittelbar** nach dem Fill
  auf, nicht erst am Ende des Poll-Durchlaufs. Ein Absturz dazwischen
  ließe den Bot nach dem Hochfahren nichts von der Teilrealisierung
  wissen — und nachkaufen.
- `storniereOffeneEinstiege()` nimmt die offenen Kauf-Limits zurück.
  Schlägt das fehl, wird die Order **nicht** als storniert vermerkt; ein
  Nachlauf in `processPlan` (Schritt 4b) versucht es bei jedem Durchlauf
  erneut.
- Ein Plan gilt als abgeschlossen, sobald `remainingSize <= 0` — auch
  wenn spätere Take-Profits nie erreicht wurden. Sie könnten nichts mehr
  schließen.

Tests: `packages/docker-bot/src/services/trade-plan-monitor.test.ts`.

### 3c. Ein Plan wird erst aufgeräumt, dann abgemeldet

Wer einen Plan beendet, ruft `TradePlanMonitor.beendePlan()`. Die
Reihenfolge darin ist zwingend:

1. Offene Position zu Markt schließen — **zuerst**, weil die
   Stop-Loss-Order noch liegt. Scheitert das Schließen, ist die Position
   wenigstens weiter abgesichert.
2. Verbliebene Orders zurücknehmen.
3. Erst jetzt abmelden.

Schlägt Schritt 1 fehl, wirft die Methode und der Plan bleibt
**angemeldet**. Lieber ein Plan, der sich nicht beenden lässt und das
sagt, als eine stillschweigend unbeaufsichtigte Position.

`unregisterPlan()` meldet nur ab und rührt die Börse nicht an. Es ist
allein dann richtig, wenn dort nichts mehr liegt. Die Status-Route rief
es auf `cancelled` auf — das Aufräumen geschieht aber in `processPlan`
(Schritt 0), und den Plan sah der Poll-Durchlauf danach nie wieder:
Kauf-Limits blieben liegen, die Position lief ohne Aufsicht weiter.

**Die offene Position wird aus den Orders gerechnet**, nicht aus einem
Merker: `offenePosition()` zieht gefüllte Ausstiege von gefüllten
Einstiegen ab. Jede sofort ausgeführte Order muss ihre Füllung deshalb
nachtragen — `merkeFuellung()` nach jedem `insertPlanOrder`, denn
`insertPlanOrder` kennt die Spalte `filled_quantity` nicht. Fehlt der
Eintrag bei einem Take-Profit, erscheint der Plan nach einem Neustart
mit voller Position und verkauft sie ein zweites Mal.

Tests: `packages/docker-bot/src/services/trade-plan-beenden.test.ts`.

### 3d. Was ein Plan einbrachte, rechnet der Bot nur zum Hinsehen

`ErgebnisService` rechnet aus `bot_trade_plan_orders`: gefüllte
Einstiege gegen gefüllte Ausstiege, Gebühren abgezogen, realisiert und
nicht realisiert **getrennt** ausgewiesen.

Diese Zahl ist nicht die Buchhaltung. Maßgeblich bleibt der API-Import
des Journals direkt bei der Börse (Regel 1) — nur er kennt
Teilfüllungen, Finanzierungskosten und den tatsächlichen
Ausführungspreis. Die Oberfläche sagt das an Ort und Stelle dazu.

Tests: `packages/docker-bot/src/services/ergebnis-service.test.ts`.

### 4. Der Ausführungsstand ist lokal und wird nur erweitert

Welche Einstiegs-Orders schon herausgegangen sind, weiß allein der Bot
(`executed_orders`). Das Journal liefert dieses Feld leer zurück — es
erfährt ja nichts. Beim Abgleich wird der Stand **vereinigt, nie ersetzt**
(`TcPlanSyncService.mergeExecutedOrders`). Ein Überschreiben ließe jeden
platzierten Einstieg wieder als offen gelten und der Bot kaufte erneut.

Zweite Quelle als Rückfallebene: die tatsächlich abgeschickten Orders aus
`bot_trade_plan_orders`. Sie fängt einen Absturz zwischen Order und
Speichern ab.

### 5. Jeder Plan handelt auf seiner eigenen Börse

Ein Plan trägt die Börse im Feld `exchange`. Die `BrokerRegistry` baut je
Börse einen Zugang auf und hält ihn vor. Es gibt keinen global
eingestellten Broker mehr, über den alles liefe.

Das Börsen-Verzeichnis (`core/src/broker/exchange-registry.ts`) führt zu
jeder Börse den MiCA-Zulassungsvermerk. Bei `NUR_MICA_BOERSEN=true`
(Voreinstellung) lehnt der Bot Pläne auf nicht zugelassenen Börsen ab.

**Der MiCA-Vermerk ist eine Handreichung, keine Rechtsauskunft.**
Maßgeblich sind das ESMA-Register und die Liste der BaFin. Der Vermerk
gehört regelmäßig geprüft — und das Gegenstück im Journal
(`backend/src/modules/exchange-sync/adapters/ccxt-exchange-configs.ts`)
mit.

### 5a. `NUR_UEBUNGSBETRIEB` ist der Riegel gegen echten Handel

Steht er auf `true`, verlässt **kein** Auftrag den Bot. Jede Börse wird
auf den Übungsbroker umgeleitet — auch eine mit hinterlegten
Zugangsdaten, und auch dann, wenn ein Handelssignal von außen
ausdrücklich eine Börse nennt.

Der Riegel sitzt in `createBroker()`
(`docker-bot/src/services/broker-factory.ts`), der einzigen Stelle, an
der ein Börsenzugang entsteht. Darauf zu bauen, dass keine
Zugangsdaten hinterlegt sind, wäre zu wenig: Ein Plan nennt seine Börse
selbst, und ein Signal bringt das Feld `exchange` mit.

`TradePlanMonitor` bekommt die Einstellung ebenfalls — `exchangeOf()`
liefert dann `paper`. Sonst prüfte der Monitor weiter gegen die Börse
aus dem Plan, und ein Signal auf eine nicht MiCA-zugelassene Börse
scheiterte an einer Zulassung, die für einen Handel nötig wäre, der gar
nicht stattfindet.

Beim Start steht `*** NUR UEBUNGSBETRIEB ***` als Warnung im Protokoll.
Ein stiller Riegel wäre keiner.

Tests: `packages/docker-bot/src/services/broker-factory.test.ts` — sie
prüfen ausdrücklich den gefährlichen Fall: hinterlegte Zugangsdaten und
trotzdem kein echter Zugang.

### 6. TradingControl-Journal wird aus diesem Projekt heraus nicht geändert

Verbesserungen an der Journal-Seite gehören als Vorschlag nach
`docs/OPTIMIERUNGSVORSCHLAEGE-TC-JOURNAL.md` — der Nutzer entscheidet, was
davon dort einfließt.

## Memory-System (MemoryX v2.5 — memcp)

Dieses Projekt nutzt ein MCP-basiertes persistentes Memory-System.
Der MCP-Server ist in `.mcp.json` als `memory` registriert.

### Session-Startup (PFLICHT — BLOCKING REQUIREMENT)

**CRITICAL: Du MUSST die folgenden 2 Schritte SOFORT zu Beginn jeder Sitzung ausführen, BEVOR du auf die erste Nutzeranfrage antwortest. Keine Ausnahmen. Überspringe diese Schritte NIEMALS, auch nicht wenn der User sofort eine Aufgabe stellt.**

**Die MCP-Tools erscheinen als "deferred tools" — du musst sie AKTIV laden und aufrufen.**

#### Schritt 1: Tool laden

Lade das MCP-Tool mit ToolSearch: `select:mcp__memory__memcp_session_start`

#### Schritt 2: Startup (1 Call)

`memcp_session_start(project="TradingControl-Bot")`

Das liefert in einer Response:
- Speicher-Statistiken (total_insights, capacity_pct)
- Critical Insights (Regeln, Entscheidungen)
- Projekt-Kontext (letzte 20 Insights im context-Modus)
- Session-Handover (letzte Übergabe, falls vorhanden)

Wenn der Tool-Aufruf fehlschlägt, melde das dem Nutzer sofort.

### Wann speichern?

Rufe `memcp_remember()` auf bei:

| Kategorie | Wann | Beispiel |
|-----------|------|---------|
| `decision` | Architekturentscheidung getroffen | "SQLite statt PostgreSQL gewählt" |
| `fact` | Systemgrenzen, API-Limits, Konfigurationswerte | "API Rate-Limit ist 100/min" |
| `preference` | User-Vorlieben, Coding-Stil | "User bevorzugt deutsche Kommentare" |
| `finding` | Bug-Entdeckungen, Edge-Cases | "WAL-Modus braucht read-write Mount" |
| `todo` | Offene Aufgaben, Follow-ups | "Feature X noch implementieren" |
| `general` | Alles andere | Session-Zusammenfassungen |

### Importance-Level

- `critical` — Darf NIEMALS vergessen werden
- `high` — Wichtiger Kontext
- `medium` — Nützliches Wissen
- `low` — Nice-to-have

### Session-Übergabe (vor /compact oder Session-Ende)

**PFLICHT vor `/compact`:** Bevor der Kontext komprimiert wird, MUSST du eine strukturierte Übergabe speichern. Der PreCompact-Hook blockiert `/compact` bis dies geschehen ist.

**Schritt 1 — Kontext-Snapshot speichern:**

```
memcp_remember(
    content="Session-Übergabe: [Aktuelle Aufgabe + Stand] | [Getroffene Entscheidungen] | [Offene Punkte / Next Steps] | [Wichtige Dateien/Pfade die bearbeitet wurden]",
    category="general",
    importance="high",
    tags="session-handover,TradingControl-Bot"
)
```

**Schritt 2 — Bei großem Arbeitskontext zusätzlich:**

```
memcp_load_context(
    name="session-handover",
    content="[Detaillierter Arbeitsstand: Code-Fragmente, Fehlermeldungen, Zwischenergebnisse, TODOs]"
)
```

**Beim nächsten Startup** wird die Übergabe automatisch über `memcp_session_start()` geladen (enthält Session-Handover).

> **Tipp:** Die Übergabe ersetzt NICHT die Session-Summary. Die Übergabe ist detaillierter und enthält den exakten Arbeitsstand für nahtloses Weitermachen.

### Am Ende jeder Sitzung

Speichere eine Abschlussepisode:
```
memcp_remember(
    content="Session-Zusammenfassung: Was wurde erledigt, wichtige Erkenntnisse, offene Punkte",
    category="general",
    importance="medium",
    tags="session-summary,TradingControl-Bot"
)
```

### Feedback (automatisch eingefordert nach Recall)

Nach jedem `memcp_recall()` wirst du erinnert, die Treffer zu bewerten:
- Insight war hilfreich → `memcp_reinforce(insight_id, helpful=True)`
- Insight war irrelevant → `memcp_reinforce(insight_id, helpful=False, note="Grund")`
