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

### 3aa. Alles liegt an der Börse, nichts nur im Bot

Einstiege, Take-Profits und der Stop-Loss gehen als **echte Orders**
ins Orderbuch — nicht erst, wenn der Kurs sie berührt.

**Warum:** Der Bot beobachtete den Kurs im Zwei-Sekunden-Takt und
schickte erst beim Überschreiten eine Market-Order. Das setzt dreierlei
voraus: dass er läuft, Verbindung hat und im richtigen Augenblick
hinsieht. Am 25.10.2026 lief HYPEUSDT in der Minute 13:17 auf 77,034
und schloss bei 76,957 — Ziel 1 lag bei 76,9907 und wurde nie
ausgelöst. Ein Docht zwischen zwei Abfragen. Am selben Tag standen zwei
von vier Einstiegen Stunden nach dem Signal noch auf „nicht
abgeschickt", obwohl der Kurs sie längst durchlaufen hatte.

Eine Order im Orderbuch braucht nichts davon. Sie wird gefüllt, sobald
der Kurs sie berührt — und zwar **zum Zielpreis**, nicht zu dem, was
zwei Sekunden später noch übrig ist.

| Was | Wann gelegt | Art |
|-----|-------------|-----|
| alle Einstiege | bei Signaleingang | `limit` |
| alle Take-Profits | sobald eine Position steht | `limit`, `reduceOnly` |
| Stop-Loss | sobald eine Position steht | `stop`, `reduceOnly` |

Umgesetzt in `TradePlanMonitor`:

- `processEntries()` platziert Limit-Einstiege **ohne** Preisprüfung.
  Nur Einstiege mit Indikator-Trigger warten — die Börse kennt keinen
  RSI. Eine Market-Order (`first_market_rest_limit`) braucht den Kurs.
- `synchronisiereTpOrders()` legt alle offenen Ziele. **Die Preise
  stehen fest, die Mengen nicht:** Sie folgen der tatsächlich
  eingestiegenen Menge (`tpMengen()`). Mit jedem gefüllten Einstieg
  wachsen sie — die alte Order wird zurückgenommen und größer neu
  gelegt.
- `synchronisiereSlOrder()` hinterlegt den Stop. Wandert er (nach einem
  Take-Profit oder als Trailing), wird zurückgenommen und neu gelegt.
  Ein kurzer Augenblick ohne Absicherung ist besser als gar keine.
- **Scheitert das Zurücknehmen, wird NICHT neu gelegt.** Zwei
  Stop-Orders schlössen zusammen mehr, als offen ist.
- `naheBei()` vergleicht mit Toleranz. Ohne sie gälte jede Order bei
  jedem Durchlauf als verändert und flöge im Takt der Kursabfrage hin
  und her.
- Beim Beenden nimmt `beendePlan()` alles zurück.

Die Kursbeobachtung bleibt als **Rückfall**, falls sich keine Order
legen ließ.

Im Hedge-Modus trägt jede Order `positionSide`. `CcxtBroker.hedgeFeld()`
übersetzt: Phemex `posSide: "Long"`, Bybit `positionIdx: 1`, Binance
`positionSide: "LONG"`, OKX `posSide: "long"`. Eine Börse ohne
hinterlegte Übersetzung bekommt nichts — lieber das als ein erfundenes
Feld.

Tests: `packages/docker-bot/src/services/trade-plan-orderbuch.test.ts`,
`packages/core/src/broker/ccxt-hedge.test.ts`.

### 3ab. Long und Short auf demselben Symbol sind zwei Geschäfte

Das Übungskonto führt Positionen je **(Symbol, Richtung)**, wie Phemex
im Hedge-Modus. Entscheidend ist nicht die Orderrichtung, sondern
`reduceOnly`: Ein Kauf eröffnet einen Long **oder** schließt einen
Short.

**Warum:** Vorher gab es eine Position je Symbol. Am 25.10.2026 traf
ein BTCUSDT-Long-Einstieg auf einen laufenden Short und schloss einen
Teil davon — 0,65 USDT Verlust realisiert, ohne dass ein Stop gelaufen
wäre. Beide Pläne handelten ein anderes Geschäft als das, das sie
meinten.

`PaperAccount.positionFortschreiben()` nimmt dafür den Parameter
`schliesst`. Der Datenbankschlüssel ist `(symbol, seite)`;
`migrierePaperPositionen()` stellt bestehende Datenbanken um.

Tests: `packages/core/src/broker/paper-account.test.ts`, Abschnitt
„Hedge-Modus".

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

### 3ac. Nach dem ersten Take-Profit kann ein Plan nicht mehr ins Minus

Sobald ein Take-Profit greift, zieht der Bot den Stop auf den
**tatsächlichen durchschnittlichen Einstiegspreis** — nicht auf den,
den das Signal vorgibt, wenn der schlechter liegt.

**Warum:** Ein Signal rechnet seinen Break-Even-Stop auf die
**geplante** Einstiegsstaffel. Füllt davon nur ein Teil — und das ist
der Regelfall, denn nach dem ersten Take-Profit werden die restlichen
Einstiege zurückgenommen (Regel 3b) —, liegt der vorgegebene Stop
unter dem echten Einstand.

BNBUSDT am 26.10.2026:

| | |
|---|---|
| geplante Einstiege | 739,96 / 738,39 / 736,83 / 735,26 |
| Durchschnitt davon | **737,61** — darauf setzte das Signal den Stop |
| tatsächlich gefüllt | nur 739,96 (der erste) |

```
TP1  (743,86 − 739,96) × 1,36399069  =  +5,32
SL   (737,61 − 739,96) × 4,09197206  =  −9,62
Gebühren                                −1,91
                                       ──────
                                        −6,21 USDT
```

25 % gingen mit Gewinn heraus, 75 % mit Verlust. Rechnerisch konnte
dieser Trade nach TP1 gar nicht mehr positiv enden.

Umgesetzt in `TradePlanMonitor.zieheStopAufEinstand()`, aufgerufen in
`tpErreicht()` **nach** dem `sl_adjust` des Signals und **vor** dem
Trailing. Die Reihenfolge ist Absicht: Das Signal setzt zuerst, die
Schranke hebt nur an, was danebenliegt.

**Die Schranke wirkt nur in die sichere Richtung** — beim Long nach
oben, beim Short nach unten. Liegt der Stop des Signals bereits
besser, bleibt er. Dieselbe Einbahn wie bei den Grenzen des
Risikoprofils (Regel 3a).

**Genau der Einstand, kein Aufschlag.** Die Gebühren bleiben außen
vor: Der bereits realisierte Take-Profit deckt sie (beim BNB-Plan
5,32 gegen 1,91 USDT). Ein Aufschlag rückte den Stop näher an den
Kurs und löste ihn öfter aus.

`updateTrailingStop()` darf den Schutz nicht unterlaufen: Auch die
**erste** Trailing-Setzung prüft jetzt die Richtung. Vorher setzte sie
`slCurrent` bedingungslos — ein nach einem Take-Profit auf den
Einstand gezogener Stop wäre beim Anlaufen des Trailings
stillschweigend wieder darunter gerutscht.

Tests: `packages/docker-bot/src/services/stop-break-even.test.ts`.

### 3ace. Sind alle Ziele erreicht, hält der Stop das letzte

Die Signale ziehen den Stop stufenweise nach: TP2 setzt ihn auf TP1,
TP3 auf TP2, TP4 auf TP3. Das lässt dem Trade bewusst Luft — eine
Stufe Abstand, damit ein Rücksetzer ihn nicht sofort beendet.

**Nach dem letzten Ziel kommt diese Stufe nicht mehr.** Es gibt kein
TP5, das den Stop auf TP4 zöge; ab hier trägt allein das Trailing.
Ist dessen Prozentsatz weiter als der Abstand zwischen den letzten
beiden Zielen, bleibt bereits erreichter Gewinn unbesichert liegen.

HYPEUSDT am 27.10.2026, alle vier Ziele erreicht:

| | |
|---|---|
| TP4 gefüllt zu | 80,1464 |
| Stop danach (= TP3) | 79,6404 |
| Höchstkurs seither | 80,497 |
| Trailing 1,5 % davon | **79,2895** — noch unter dem Stop |

Das Trailing hätte erst ab einem Kurs von 80,853 überhaupt gegriffen.
Bis dahin hingen 1,11 USDT bereits erreichter Gewinn in der Luft.

`sichereErreichteZiele()` hebt den Stop auf das beste erreichte Ziel —
nach dem tatsächlichen Füllpreis, nicht dem geplanten.

**Nur nach dem letzten Ziel.** Nach jedem wäre es falsch: Dann stünde
der Stop ständig eine Stufe zu eng, und die Luft, die das Signal dem
Trade lässt, wäre weg.

**Und nur mit Abstand zum Kurs.** Im Augenblick, in dem das letzte
Ziel füllt, steht der Kurs genau auf dessen Preis. Ein Stop dort ist
kein Stop, sondern ein Verkauf zu Markt — im Test löste er zweimal in
derselben Sekunde aus und schloss mehr, als offen war. Die Grenze
wartet deshalb, bis der Kurs `MINDESTABSTAND_ZIEL_PCT` (0,05 %)
darüber steht.

**Geprüft wird bei jedem Durchlauf, nicht nur beim Take-Profit.**
Nach einem Neustart bringt der wiederhergestellte Zustand `slCurrent`
mit, aber `tpErreicht()` läuft nie wieder. Und das Trailing darf die
Grenze nicht unterlaufen — es rechnet nur Prozente vom Höchstkurs und
weiß nichts von erreichten Zielen.

Tests: `packages/docker-bot/src/services/stop-break-even.test.ts`,
Abschnitt „Alle Ziele erreicht".

### 3ad. TC-Synaptrix darf den Stop nachkorrigieren — nur enger

Der Bot ist der **Sofortschutz**, nicht die letzte Instanz. Über den
Rückkanal erfährt TC-Synaptrix den tatsächlichen Einstand und kann
einen genaueren Stop nachreichen.

Dafür gibt es zwei Ergänzungen:

| Richtung | Was |
|---|---|
| Bot → Synaptrix | Jedes Ereignis, das die Position verändert, trägt `position` mit `einstand`, `eingestiegen`, `offen` und der Zahl der gefüllten Einstiegsstufen |
| Synaptrix → Bot | Signal-Action `update` mit `stop_loss_price` und `target_plan_id` |

**`update` verschiebt ausschließlich den Stop.** Größe, Hebel und
Take-Profits bleiben unantastbar — sie mitten im Trade zu ändern hieße,
eine andere Strategie zu handeln als die, für die er eröffnet wurde.
Das Schema lässt gar nichts anderes durch (`leeresSignal`).

**Angenommen wird nur, was das Risiko verkleinert.** `setzeStopLoss()`
lehnt ab, was den Stop weiter wegrücken würde, und begründet es. Ohne
diese Schranke ließe sich ein laufender Trade aus der Ferne riskanter
machen, als er eröffnet wurde.

Ein `update` ohne `stop_loss_price` oder ohne Zielangabe wird
abgewiesen. Bei `close` ist „alles auf diesem Symbol" eindeutig; ein
Stop-Preis ist es nicht — er gehört zu genau einer Position mit genau
einem Einstand.

**Warum trotzdem beides:** Zwischen dem Take-Profit und dem
eintreffenden Update liegen Warteschlangentakt, Verarbeitung und
Rückweg — rund 20 bis 40 Sekunden, in denen der alte Stop an der Börse
hängt.

Der Rückkanal meldet an TC-Synaptrix, **nicht** an das Journal.
Regel 1 bleibt unberührt.

Tests: `packages/signals/src/signal-update.test.ts`,
`packages/docker-bot/src/services/stop-break-even.test.ts`,
`packages/docker-bot/src/services/tc-rueckkanal-service.test.ts`.

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

### 3ca. Ein Storno räumt auf wie ein Beenden

`processPlan` Schritt 0 behandelt einen Plan, dessen Status von außen
auf `cancelled` gesetzt wurde — etwa durch ein `cancel`-Signal. Die
Reihenfolge dort ist dieselbe wie in `beendePlan()` und aus demselben
Grund zwingend:

1. Offene Position zu Markt schließen
2. Erst dann die Orders zurücknehmen

**Warum:** Unter den offenen Orders ist der Stop-Loss. Wer ihn zuerst
zurücknimmt und danach beim Schließen scheitert, hinterlässt eine
ungesicherte Position.

Hier stand nur `cancelAllOrdersForPlan()`. Am 01.11.2026 stornierte
TC-Synaptrix 42 Pläne auf einmal; **acht** davon hatten eine offene
Position. Alle acht blieben stehen, während ihre Stop-Orders
zurückgenommen wurden. Die BNBUSDT-Position lief danach einen Tag
lang ohne jede Absicherung.

Scheitert das Schließen, bleiben die Orders **liegen** und der
nächste Durchlauf versucht es erneut — lieber eine abgesicherte
Position, die sich nicht beenden lässt, als eine ungesicherte.

Tests: `packages/docker-bot/src/services/trade-plan-beenden.test.ts`.

### 3cb. Der Hebel gehört an die Order, nicht in den Arbeitsspeicher

`OrderParams.leverage` trägt den Hebel des Plans. Der Übungsbroker
hält ihn an der Order fest, und `ordersWiederherstellen()` nimmt ihn
nach einem Neustart wieder auf.

**Warum:** Eine echte Börse führt den Hebel je Symbol und merkt ihn
sich — `setLeverage()` genügt dort. Der Übungsbroker hielt ihn in
einer Map im Arbeitsspeicher. Solange Einstiege als Market-Orders
sofort nach dem Setzen hinausgingen, trug das.

Seit die Einstiege als Limit-Orders im Orderbuch liegen (Regel 3aa),
vergehen zwischen `setLeverage()` und der Füllung oft Stunden. Fällt
ein Neustart dazwischen, ist die Map leer — und `?? 1` buchte die
Füllung mit **Hebel 1**.

Am 02.11.2026:

| | |
|---|---|
| Kontostand | 8.309,58 USDT |
| gebunden laut Anzeige | **10.606,21 USDT** — mehr als vorhanden |
| frei | 0,00 USDT |

```
BNBUSDT buy   Hebel 1 statt 10   →  4.854,18 statt 485,42
SOLUSDT buy   Hebel 1 statt 13   →  3.082,81 statt 237,14
```

**Die Folge war schwerer als eine falsche Anzeige.** Mit `frei = 0`
fiel die Risikogrenze aus, die sich auf die verfügbare Margin stützt:
Bei jedem Signal stand „Kein freier Betrag bekannt — die Grenze der
verfügbaren Margin wurde übersprungen".

`hebelFuer()` fragt in dieser Reihenfolge: die Order, dann die
Symbol-Map, dann eine bestehende Position auf demselben Symbol (eine
Position mit zwei Hebeln gibt es nicht). Bleibt alles leer, ist 1 die
Notannahme — **aber keine stille**: Sie wird gemeldet.

`getLiegendeOrders()` liefert `p.leverage` mit, damit der Hebel den
Neustart übersteht.

Tests: `packages/core/src/broker/paper-hebel.test.ts`.

### 3d. Was ein Plan einbrachte, rechnet der Bot nur zum Hinsehen

`ErgebnisService` rechnet aus `bot_trade_plan_orders`: gefüllte
Einstiege gegen gefüllte Ausstiege, Gebühren abgezogen, realisiert und
nicht realisiert **getrennt** ausgewiesen.

Diese Zahl ist nicht die Buchhaltung. Maßgeblich bleibt der API-Import
des Journals direkt bei der Börse (Regel 1) — nur er kennt
Teilfüllungen, Finanzierungskosten und den tatsächlichen
Ausführungspreis. Die Oberfläche sagt das an Ort und Stelle dazu.

**Vor jeder Auswertung der Übungsergebnisse:
`docs/DATENVORBEHALTE-AUSWERTUNG.md` lesen.** Dort steht, welche
Kennzahl in welchem Zeitraum durch inzwischen behobene Fehler
verfälscht ist — allen voran die neun Zwangsschließungen vom
02.11.2026, die wie Trades aussehen, aber keine sind. Die Daten
wurden bewusst **nicht** nachträglich korrigiert: Eine
stillschweigend geänderte Messreihe ist schlimmer als eine mit
bekannten Lücken. Die Auswertungsseite blendet den Vorbehalt
ebenfalls ein.

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
