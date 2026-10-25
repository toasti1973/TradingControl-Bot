# Vorschläge für TradingControl-Journal

Gefunden beim Abgleich des Bots mit dem Journal am 04.08.2026.

**Am Journal wurde nichts geändert.** Dieses Dokument beschreibt, was auf
der Journal-Seite besser ginge, was es brächte und was es kostet. Was davon
umgesetzt wird, entscheidest du.

Alle Vorschläge sind **rückwärtskompatibel** — bestehende Bots und die
Weboberfläche laufen unverändert weiter. Wo das nicht gilt, steht es dabei.

Grundlage: Der Bot meldet nichts mehr zurück. Die Ausführungsdaten holt sich
das Journal über seinen API-Import bei der Börse. Die folgenden Vorschläge
respektieren das — keiner davon baut einen Rückkanal auf.

---

## Übersicht

| # | Vorschlag | Nutzen | Aufwand | Dringlichkeit |
|---|---|---|---|---|
| 1 | `entry_strategy` und `notes` in `/bot/plans` ergänzen | Bot kennt die Absicht hinter dem Plan | sehr gering | hoch |
| 2 | `entry_zones` liefern, aber Trigger prüfen | Zonen-Anzeige im Bot korrekt | gering | mittel |
| 3 | Börse ohne Konto-Zuordnung benennen | Plan landet auf der richtigen Börse | gering | hoch |
| 4 | Toter Validator `trailing_stop_abs` | Feld wird angenommen und verworfen | sehr gering | mittel |
| 5 | Status `executing` in `/bot/plans` aufnehmen | laufende Pläne verschwinden nicht | gering | hoch |
| 6 | `bot_execution_reports` bereinigen | tote Tabelle, GoBD-Aufbewahrung läuft ins Leere | gering | niedrig |
| 7 | MiCA-Vermerk im Plan-Editor zeigen | Nutzer sieht vor dem Speichern, was geht | mittel | mittel |
| 8 | Plan-Vorprüfung gegen Börsen-Fähigkeiten | kein Hebel-Plan auf einer Kassa-Börse | mittel | mittel |
| 9 | Bot-Sicht im Journal: „wird überwacht" | Nutzer sieht, ob ein Bot den Plan hat | größer | niedrig |

---

## 1. `entry_strategy` und `notes` in `/api/v1/bot/plans` ergänzen

**Befund.** Die Auswahlliste in
[bot.routes.ts:60-70](../../TradingControl/TradingControl/backend/src/modules/bot/bot.routes.ts)
liefert beide Felder nicht. Der Bot erwartet `entry_strategy` als
Pflichtfeld — es kam bisher als `undefined` an und wurde so in die lokale
Datenbank geschrieben.

**Nutzen.** `entry_strategy` sagt, wie die Einstiege gemeint sind
(`ascending`, `descending`, `equal` …). Der Bot kann daraus ableiten, ob ein
nachträglich veränderter Plan noch zur ursprünglichen Absicht passt.
`notes` ist der Text, den du beim Planen geschrieben hast — er gehört in die
Bot-Oberfläche, wenn dort ein Plan angezeigt wird.

**Änderung.** Zwei Spaltennamen im `select` ergänzen, zwei Zeilen im
zurückgegebenen Objekt:

```ts
.select(
  'id', 'exchange_account_id',
  'symbol', 'asset_symbol', 'quote_currency',
  'direction', 'market_type', 'leverage',
  'entry_strategy',                    // ← neu
  'entry_orders', 'entry_zones',
  // ...
  'notes',                             // ← neu
)
```

**Kosten.** Zwei Felder mehr je Plan, wenige Bytes. Kein Risiko.

**Bis dahin:** Der Bot behält den zuletzt bekannten Wert, statt ihn mit
`undefined` zu überschreiben.

---

## 2. `entry_zones` wird geliefert, die Trigger darin sind aber schon
   auf die Orders verteilt

**Befund.** `expandZoneTriggersToOrders` in
[trade-plans.routes.ts:30-42](../../TradingControl/TradingControl/backend/src/modules/trade-plans/trade-plans.routes.ts)
kopiert Zone-Trigger beim Speichern auf alle Orders der Zone. Das ist
richtig so — der Bot muss keine Zonen-Logik kennen. `/bot/plans` liefert
`entry_zones` aber zusätzlich mit, inklusive der Trigger.

**Nutzen einer Klarstellung.** Der Bot wertet die Trigger je Order aus. Läse
er zusätzlich die Zonen-Trigger aus, würde dieselbe Bedingung doppelt
geprüft. Aktuell tut er es nicht — aber nur, weil er die Zonen ausschließlich
zur Anzeige verwendet. Das ist eine stille Übereinkunft, die beim nächsten
Umbau bricht.

**Änderung.** Entweder die Trigger aus `entry_zones` in der Bot-Antwort
entfernen (die Orders tragen sie ja), oder in der Bot-API-Dokumentation
ausdrücklich festhalten: *Maßgeblich ist `entry_orders[].trigger`; die Zone
zeigt nur, woher er stammt.* Ich empfehle das Zweite — die Herkunft ist für
die Anzeige nützlich.

---

## 3. Börse benennen, auch wenn kein Konto zugeordnet ist

**Befund.** Ist `exchange_account_id` leer, liefert die Bot-Schnittstelle
`exchange: 'unknown'`
([bot.routes.ts:93](../../TradingControl/TradingControl/backend/src/modules/bot/bot.routes.ts)).

**Nutzen.** Seit der Bot mehrere Börsen bedient, entscheidet dieses Feld,
wo gehandelt wird. Bei `'unknown'` fällt er auf seine Voreinstellung zurück
— möglicherweise eine andere Börse als gedacht.

**Änderung, klein:** `null` statt `'unknown'` liefern. Dann ist es
eindeutig „nicht zugeordnet" statt eines Börsennamens, der keiner ist.

**Änderung, besser:** Im Plan-Editor ein Börsen-Feld auch ohne Konto
anbieten. Man plant oft, bevor man den Zugang einrichtet.

---

## 4. Toter Validator `trailing_stop_abs`

**Befund.**
[trade-plans.routes.ts:109](../../TradingControl/TradingControl/backend/src/modules/trade-plans/trade-plans.routes.ts)
validiert `trailing_stop_abs`. Das Feld wird nirgends gespeichert, existiert
in keiner Migration und kommt im Frontend nicht vor.

**Wirkung heute.** Wer das Feld schickt, bekommt eine Bestätigung — und der
Wert verschwindet. Ein stiller Datenverlust.

**Änderung.** Entweder die Zeile streichen, oder das Feld zu Ende bauen: Ein
Trailing-Stop mit festem Abstand (statt Prozent) ist bei ruhigen Werten
sinnvoll. Der Bot könnte ihn ohne Weiteres auswerten — die Logik in
`updateTrailingStop` rechnet ohnehin auf einen absoluten Preis herunter.

---

## 5. Status `executing` fehlt in der Bot-Auswahl

**Befund.** `/bot/plans` filtert auf `['active', 'planned']`
([bot.routes.ts:59](../../TradingControl/TradingControl/backend/src/modules/bot/bot.routes.ts)).
Der Statusübergang im Journal kennt aber `planned → active → executing`.

**Wirkung.** Sobald ein Plan auf `executing` wechselt, verschwindet er aus
der Bot-Antwort. Der Bot wertet das als „Plan wurde entfernt", meldet ihn
vom Monitor ab und storniert offene Orders — **mitten in einer laufenden
Position.**

Das ist der schwerwiegendste Punkt dieser Liste.

**Änderung.**

```ts
.whereIn('status', ['active', 'planned', 'executing'])
```

**Bis dahin:** Wer den Bot einsetzt, sollte Pläne nicht von Hand auf
`executing` setzen.

---

## 6. `bot_execution_reports` ist tot

**Befund.** Seit der Bot nichts mehr zurückmeldet, füllt sich die Tabelle
nicht mehr. Daran hängen:

- `executed_orders` in `/bot/plans` und in `/api/trade-plans` — beide
  aggregieren aus dieser Tabelle und liefern jetzt immer leere Listen. Die
  Statusabzeichen an den Order-Kacheln im Frontend bleiben also aus.
- `log-retention.service.ts` bewahrt die Tabelle 365 Tage auf (GoBD).
- Der Datenexport in `users.routes.ts:382` liest bis zu 5000 Zeilen.

**Was stattdessen.** Die Order-Status kann das Journal aus seinem eigenen
Börsen-Import ableiten: Es kennt die Ausführungen, es kennt die Pläne. Was
fehlt, ist die Verknüpfung — und die steckt in der Client-Order-ID.

Der Bot vergibt sie im **selben Format**, das das Journal selbst benutzt:

```
tc-plan-<plan-id-8-stellig>-entry-<index>
tc-plan-<plan-id-8-stellig>-tp-<index>
tc-plan-<plan-id-8-stellig>-sl-0
```

Der Import müsste dieses Muster nur erkennen und die Ausführung dem Plan
zuordnen. Damit bekämst du die Order-Anzeige zurück — **ohne** dass der Bot
irgendetwas meldet, und mit den echten Zahlen der Börse statt denen, die der
Bot für richtig hielt.

**Empfehlung.** Tabelle behalten (Altbestand, GoBD), aber keine neue Logik
mehr darauf bauen. Die Zuordnung über die Client-Order-ID ist der bessere
Weg.

---

## 7. MiCA-Vermerk im Plan-Editor zeigen

**Befund.** Das Journal führt die Liste bereits:
`MICA_COMPLIANT_EXCHANGES` in
[ccxt-exchange-configs.ts:227](../../TradingControl/TradingControl/backend/src/modules/exchange-sync/adapters/ccxt-exchange-configs.ts).
Der Kommentar sagt, sie werde im Frontend als Abzeichen angezeigt — im
Plan-Editor ist sie es nicht.

**Nutzen.** Der Bot lehnt Pläne auf nicht zugelassenen Börsen ab
(Voreinstellung). Das erfährt der Nutzer heute erst im
Bot-Ausführungsprotokoll — also nachdem der Einstiegskurs vorbei ist. Ein
Hinweis beim Planen wäre früh genug.

**Hinweis zur Liste.** Der Bot führt eine eigene, feiner aufgelöste Fassung
(`core/src/broker/exchange-registry.ts`): drei Stufen statt ja/nein, dazu
die zuständige Aufsicht je Börse. Zwei Unterschiede sind mir aufgefallen:

- **KuCoin** steht im Journal in der Liste der Zugelassenen, der Kommentar
  daneben sagt aber „Antrag laufend". Der Bot führt das als eigene Stufe
  `in_pruefung` und behandelt es wie „nicht zugelassen".
- **Phemex** ist in beiden Listen nicht enthalten — es war bis zum Umbau
  der einzige Live-Zugang des Bots. Das ist erwähnenswert, falls dort noch
  Pläne laufen.

Beide Listen sollten regelmäßig gegen ESMA-Register und BaFin-Liste geprüft
werden. Sie zusammenzuführen wäre schön, geht aber nur über ein gemeinsames
Paket — dafür sind die Projekte zu getrennt.

---

## 8. Plan gegen die Fähigkeiten der Börse prüfen

**Befund.** Das Journal nimmt einen Futures-Plan mit 10-fachem Hebel auf
Bitpanda an. Bitpanda hat keine Termingeschäfte.

**Nutzen.** Der Fehler fällt heute erst auf, wenn der Bot die Order
abschickt — oder gar nicht, wenn der Plan von Hand gehandelt wird und man
sich wundert.

**Änderung.** Beim Speichern prüfen: Bietet die zugeordnete Börse die
gewählte Marktart? Der Bot macht das in `checkMarketSupport`
(`core/src/broker/exchange-registry.ts`) und gibt einen Grund zurück statt
nur ja/nein — die Fassung ließe sich übernehmen.

Als Warnung statt harter Ablehnung, damit man weiter planen kann, bevor der
Zugang steht.

---

## 9. Im Journal sichtbar machen, dass ein Bot einen Plan überwacht

**Befund.** Seit der Abschaltung der serverseitigen Überwachung
([trade-plans.routes.ts:608-632](../../TradingControl/TradingControl/backend/src/modules/trade-plans/trade-plans.routes.ts),
§ 32 KWG) zeigt das Journal keinen Überwachungsstatus mehr. Ob ein Bot den
Plan hat, sieht man nur im Bot.

**Spannungsfeld.** Das ließe sich nur über einen Rückkanal lösen — und den
soll es nicht geben. Ein Bot-Heartbeat wäre technisch kein Ausführungsbericht,
aber er wäre der Anfang eines Rückkanals.

**Vorschlag ohne Rückkanal.** Das Journal zeigt, was es selbst weiß: Sobald
der Börsen-Import zu einem Plan Orders findet (über die Client-Order-ID aus
Punkt 6), ist belegt, dass er ausgeführt wird. Das ist sogar belastbarer als
eine Meldung des Bots — es beruht auf dem, was an der Börse steht.

**Aufwand.** Größer, weil dafür erst Punkt 6 stehen muss.

---

## Was der Bot bereits selbst löst

Zur Einordnung — hier braucht es nichts vom Journal:

- **`executed_orders` kommt leer zurück.** Der Bot führt den Stand lokal und
  vereinigt ihn beim Abgleich, statt ihn zu ersetzen. Ohne das würde er
  Einstiege doppelt platzieren.
- **`execution_mode` gibt es im Journal nicht.** Der Bot behält den lokal
  gewählten Modus.
- **Kein Zugriff auf `trade_plan_orders`.** Der Bot führt eine eigene
  Order-Tabelle mit demselben Client-Order-ID-Format — deshalb funktioniert
  der Vorschlag in Punkt 6.
