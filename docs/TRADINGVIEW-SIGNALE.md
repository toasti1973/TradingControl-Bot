# Externe Handelssignale

Der Bot nimmt Handelssignale von außen entgegen — von einem
TradingView-Indikator oder einem eigenen Signalgeber. Dieses Dokument
beschreibt beide Wege, das Datenformat und die Umrechnung auf das
vorhandene Kapital.

Wer nur das Datenformat für den Indikator braucht, springt zu
[Das Datenformat](#das-datenformat).

---

## Zwei Wege

Sie schließen sich nicht aus. Für verschiedene Märkte oder Strategien
lassen sich beide nebeneinander betreiben.

### Weg A — Freigabe (`action: "trigger"`)

Der Handelsplan liegt fertig im Bot. Größe, Hebel, Einstiegspreise,
Stop-Loss und Take-Profits sind gesetzt — von Hand oder aus dem Journal
gespiegelt. Der Plan wartet nur auf das Startzeichen.

Das Signal gibt ihn frei. Mehr nicht: Es bestimmt das **Ob**, die
Einstiegspreise im Plan bestimmen das **Wann** der einzelnen Teil-Orders.

```
Indikator ──signal──▶ Bot ──Freigabe──▶ wartender Plan ──Preis erreicht──▶ Order
```

Geeignet, wenn Sie die Positionsgröße selbst festlegen und vom
Indikator nur das Einstiegssignal beziehen wollen. Der Indikator muss
dafür fast nichts können — Kennung, Strategiename und Symbol genügen.

**Einrichten:** Plan anlegen, dann die Bedingung setzen:

```http
PUT /api/signals/plan-trigger/<plan-id>
Content-Type: application/json

{
  "trigger": {
    "strategy": "MeinIndikator",
    "tag": "ausbruch-long",
    "max_age_sec": 300,
    "match_direction": true
  }
}
```

Mindestens eines von `strategy`, `symbol` oder `tag` muss gesetzt sein.
Eine Bedingung ohne jeden Filter würde den Plan bei jedem beliebigen
Signal freigeben und wird abgelehnt.

Ohne eigenes `symbol` gilt das Symbol des Plans. Ein Signal zu ETHUSDT
gibt also keinen BTCUSDT-Plan frei.

**Ein Signal gibt genau einen Plan frei.** Warten mehrere Pläne auf
dieselbe Bedingung, bekommt der erste den Zuschlag. Wer fünf Pläne
öffnen will, schickt fünf Signale. Andernfalls machte ein einziger Alarm
aus einem Einstieg fünf.

Die Freigabe gilt für den ganzen Plan, nicht je Teil-Order — sonst bliebe
ein gestaffelter Einstieg nach der ersten Order stecken.

### Weg B — Vollplan (`action: "open"`)

Das Signal bringt den ganzen Trade mit, ausgelegt auf ein vereinbartes
Referenzkapital (üblich 10.000 USDT). Der Bot rechnet die Größe auf das
vorhandene Kapital um und legt daraus einen Plan an.

```
Indikator ──vollständiger Plan für 10.000 $──▶ Bot ──Umrechnung──▶ Plan ──▶ Orders
```

Geeignet, wenn der Signalgeber den kompletten Trade entwirft. Das ist
der Weg für Ihren kommenden Indikator.

---

## Die Umrechnung

Das Herzstück. Sie steht in
[position-scaler.ts](../packages/signals/src/position-scaler.ts) und ist
durch 26 Tests abgesichert.

### Was angefasst wird — und was nicht

| angepasst | unverändert |
|---|---|
| `total_size` | **Hebel** |
| `total_margin` | **Stop-Loss** (Preis und Art) |
| Größe jeder Teil-Order | **Take-Profits** (Preise und Anteile) |
| absolute Größen in Take-Profits | **Trailing-Stop** (alle Einstellungen) |
| | Einstiegspreise |
| | Aktivierungsstufen |

Das ist keine Geschmacksfrage. Hebel und Stop bestimmen miteinander, wo
die Liquidation liegt und wieviel Prozent des Einsatzes ein Trade kostet;
die Take-Profit-Preise tragen die Marktmeinung. Wer daran dreht, handelt
eine andere Strategie als die, die das Signal meinte — und kann sich auf
deren Ergebnisse nicht mehr berufen.

Eine Prüfung wacht darüber: Vor dem Anlegen vergleicht
`pruefeUnveraendert()` Original und Umrechnung in allen geschützten
Feldern. Findet sich eine Abweichung, wird nicht gehandelt, sondern
protokolliert.

### Die Rechnung

**Grundfaktor** — reine Kapitalproportion:

```
f_kapital = (Kontostand × capitalFraction) / reference_capital × multiplier
```

**Obergrenzen** — jede kann den Faktor nur senken:

```
f_risiko  = (maxRiskPerTradePct × Kontostand) / Risiko_des_Signals
f_margin  = (maxMarginPerTradePct × Kontostand) / Margin_des_Signals
f_frei    = (freie Margin × usableFreeMarginPct) / Margin_des_Signals
```

Dabei ist `Risiko_des_Signals = Σ Größe_i × |Einstieg_i − Stop-Loss|`.

**Angewandt wird die kleinste:**

```
f = min(f_kapital, f_risiko, f_margin, f_frei)
```

Welche Grenze griff, steht in `limitedBy` und in der Notiz am Plan.

### Ein Beispiel

Signal für 10.000 USDT Referenzkapital:

| | Signal | Konto 2.500 $ | Konto 2.500 $, Risikogrenze 1 % |
|---|---|---|---|
| Einstieg | 0,1 BTC @ 50.000 | 0,025 BTC | 0,0125 BTC |
| Margin | 500 $ | 125 $ | 62,50 $ |
| Hebel | 10× | **10×** | **10×** |
| Stop-Loss | 48.000 | **48.000** | **48.000** |
| TP1 / TP2 | 52.000 / 55.000 (je 50 %) | **unverändert** | **unverändert** |
| Risiko bei SL | 200 $ (2 %) | 50 $ (2 %) | 25 $ (1 %) |

Die mittlere Spalte ist reine Proportion — dasselbe Verhältnis von Risiko
zu Kapital wie beim Signalgeber. In der rechten Spalte greift die
Risikogrenze und halbiert zusätzlich.

### Mindestgrößen der Börse

Nach der Umrechnung wird die Menge auf das Raster der Börse gerundet —
**immer nach unten**. Aufrunden würde die Position über das heben, was
das Risikoprofil zulässt.

Fällt eine Teil-Order unter die Mindestmenge oder den Mindest-Auftragswert
der Börse, entscheidet `SIGNAL_BELOW_MINIMUM`:

- `drop` (Vorgabe) — die Teil-Order entfällt, der Rest wird gehandelt
- `reject` — das ganze Signal wird abgelehnt

Bleibt nach den Streichungen weniger als `SIGNAL_MIN_REMAINING_FRACTION`
der geplanten Größe übrig (Vorgabe: die Hälfte), wird ebenfalls
abgelehnt. Margin und Risiko werden anschließend aus dem berechnet, was
tatsächlich übrig blieb — nicht aus dem Faktor hochgerechnet.

### Woher der Kontostand kommt

Von der Börse, über `fetchBalance` in der Quote-Währung des Plans.
Zwischengespeichert für 60 Sekunden.

Gibt die Börse keine Auskunft, wird **abgelehnt**. Ein Trade auf einer
geratenen Kontogröße ist schlimmer als kein Trade. Wer das anders
möchte, schaltet mit `SIGNAL_ALLOW_FALLBACK=true` einen festen Ersatzwert
frei.

---

## Das Datenformat

`POST /webhook/signal/<geheimnis>` mit `Content-Type: application/json`.

### Vollständiges Signal (Weg B)

```json
{
  "signal_id": "meinindikator-BTCUSDT-1761292800",
  "strategy": "MeinIndikator-V1",
  "emitted_at": "2026-10-24T08:00:00Z",
  "action": "open",

  "reference_capital": 10000,

  "exchange": "bybit",
  "symbol": "BTCUSDT",
  "market_type": "futures",
  "direction": "long",
  "leverage": 10,

  "total_size": 0.1,
  "total_margin": 500,

  "entry_strategy": "equal",
  "entry_orders": [
    { "price": 50000, "size": 0.06 },
    { "price": 49500, "size": 0.04 }
  ],

  "take_profits": [
    { "price": 52000, "percentage": 50, "sl_adjust": true, "sl_new_price": 50000 },
    { "price": 55000, "percentage": 50, "activate_trailing": true, "trailing_pct": 2 }
  ],

  "stop_loss_price": 48000,
  "stop_loss_type": "fixed",

  "notes": "RSI-Divergenz auf 4h"
}
```

### Freigabe-Signal (Weg A)

```json
{
  "signal_id": "meinindikator-BTCUSDT-1761292800",
  "strategy": "MeinIndikator-V1",
  "emitted_at": "2026-10-24T08:00:00Z",
  "action": "trigger",
  "symbol": "BTCUSDT",
  "tag": "ausbruch-long"
}
```

### Felder

#### Pflicht bei `action: "open"`

| Feld | Typ | Bedeutung |
|---|---|---|
| `signal_id` | Text | **Eindeutig je Signal.** Zweimal dieselbe Kennung = ein Signal, kein zweiter Trade. |
| `strategy` | Text | Name des Indikators. Dient der Zuordnung und der Auswertung. |
| `action` | Text | `open` \| `trigger` \| `close` \| `cancel` |
| `symbol` | Text | Markt, z. B. `BTCUSDT` |
| `direction` | Text | `long` \| `short` (auch `buy`/`sell`) |
| `entry_orders` **oder** `entry_zones` | Liste | Einstiege |
| `total_size` | Zahl | Positionsgröße in Asset-Einheiten, bezogen auf `reference_capital` |

#### Dringend empfohlen

| Feld | Vorgabe | Warum |
|---|---|---|
| `stop_loss_price` | — | **Ohne ihn greift die Risikogrenze nicht.** Der Bot handelt dann allein nach der Margin-Grenze. |
| `emitted_at` | jetzt | Ohne Zeitstempel kann der Bot kein altes Signal erkennen. |
| `reference_capital` | 10000 | Macht den Bezug ausdrücklich statt stillschweigend. |
| `leverage` | 1 | Bei Futures fast immer gemeint. |

#### Optional

| Feld | Vorgabe | Bedeutung |
|---|---|---|
| `exchange` | `DEFAULT_EXCHANGE` | Börse, auf der gehandelt wird |
| `market_type` | `futures` | `spot` \| `futures` |
| `total_margin` | aus Einstiegen und Hebel berechnet | Eingesetzte Margin |
| `quote_currency` | aus dem Symbol erraten | `USDT`, `USDC`, … |
| `entry_strategy` | `single` | `single` \| `equal` \| `ascending` \| `descending` \| `custom` |
| `execution_mode` | `all_limit` | `all_limit` \| `first_market_rest_limit` |
| `stop_loss_type` | `fixed` | `fixed` \| `trailing` |
| `trailing_stop_pct` | — | Pflicht, wenn `stop_loss_type: "trailing"` |
| `trailing_stop_activation` | — | Preis, ab dem das Trailing greift |
| `trailing_stop_size_pct` | — | Anteil der Position für den Trailing-Stop |
| `activation_conditions` | `[]` | Preisstufen, die vor dem Einstieg erreicht sein müssen |
| `tag` | — | Freie Marke zur Zuordnung (Weg A) |
| `target_plan_id` | — | Richtet das Signal an genau einen Plan |
| `notes` | — | Erscheint in der Notiz am Plan |

Felder, die das Schema nicht kennt, werden unverändert mit abgelegt. Sie
können also ohne weiteres `rsi_wert` oder `kommentar` mitschicken.

#### Take-Profits

```json
{
  "price": 52000,
  "percentage": 50,
  "sl_adjust": true,
  "sl_new_price": 50000,
  "activate_trailing": false,
  "trailing_pct": null
}
```

`percentage` ist der Anteil der Position, der an diesem Preis geschlossen
wird. Die Summe über alle Take-Profits darf 100 nicht überschreiten.

#### Zonen statt einzelner Einstiege

```json
"entry_zones": [
  {
    "priceFrom": 49000,
    "priceTo": 50000,
    "strategy": "descending",
    "steps": 4,
    "percentageOfTotal": 100
  }
]
```

`priceFrom` ist der **niedrigere** Preis. Bei `equal` und `single` dreht
der Bot eine verkehrt herum notierte Zone selbst um. Bei `ascending` und
`descending` nicht: Dort bestimmt die Reihenfolge, an welchem Ende der
Spanne mehr Geld hängt — ein stillschweigender Tausch ergäbe einen
anderen Trade.

Die Summe aller `percentageOfTotal` muss 100 ergeben.

### Was der Bot nachsichtig liest

- **Zahlen als Text.** `"50000"` wird wie `50000` gelesen — TradingView
  setzt Platzhalter als Text ein.
- **Symbole.** `BTCUSDT.P`, `BTC/USDT`, `BTC/USDT:USDT`, `BYBIT:BTCUSDT`
  und `btc-usdt` werden alle zu `BTCUSDT`.
- **Richtung.** `buy`/`sell` gelten wie `long`/`short`.
- **Zeitstempel.** ISO-8601 oder Unix-Zeit in Sekunden oder
  Millisekunden.

### Was zurückgewiesen wird

Harte Fehler — das Signal wird nicht gehandelt:

- Stop-Loss auf der falschen Seite des Einstiegs (Long mit Stop darüber)
- Take-Profit auf der falschen Seite
- Take-Profits, die zusammen mehr als 100 % schließen
- Signal älter als `SIGNAL_MAX_AGE_SECONDS`
- `stop_loss_type: "trailing"` ohne `trailing_stop_pct`
- Hebel oder Größen ≤ 0
- kein Einstieg angegeben

Hinweise — das Signal wird gehandelt, der Punkt aber festgehalten:

- kein Stop-Loss (Risikogrenze bleibt wirkungslos)
- Take-Profits schließen weniger als 100 %
- Summe der Einstiege weicht von `total_size` ab

---

## Wo der Bot läuft

Der Signalbetrieb läuft auf dem TradingControl-Server, nicht auf einem
Entwicklungsrechner.

| | |
|---|---|
| Wirt | Proxmox `TradingControl.de` |
| Gast | LXC **550** — `TC-Bot` |
| Adresse | `172.18.0.11:3300` (Bridge `vmbr2`) |
| Dienst | `tc-bot.service` (systemd, `enabled`, `Restart=always`) |
| Verzeichnis | `/opt/tc-bot` |
| Sender | tc-synaptrix, LXC **140** — `172.18.0.20`, gleiches Netz |

### Die Strecke vom Sender zum Bot

Der Sender steht **nicht** im selben Netz wie der Bot. Er erreicht ihn
über Netbird, und zwar über den Proxmox-Wirt als Routing-Peer:

```
tc-synaptrix-db                    pve-wirt                TC-Bot
192.168.0.241                   100.64.234.150         172.18.0.11:3300
Netbird 100.64.3.100  ──wt0──▶  (Routing-Peer)  ──vmbr2──▶
```

Damit das trägt, muss der Peer `tc-synaptrix-db` das Netzwerk
**„TradingControl Subnet"** (`172.18.0.0/24`) zugeteilt bekommen.
Prüfen lässt sich das auf dem Sender:

```bash
netbird routes list
```

Steht dort `No networks available`, fehlt die Zuordnung. Der Sender
schickt die Pakete dann an seinen Standard-Gateway (`192.168.0.1`), der
nichts von `172.18.0.11` weiß und sie verwirft — `curl` läuft in einen
Zeitabbruch, `code=000`.

Richtig sieht es so aus:

```
Available Networks:
  - ID: TradingControl Subnet
    Network: 172.18.0.0/24
    Status: Selected
```

**Zwei Dinge** müssen in der Netbird-Verwaltung stimmen, nicht nur
eines:

1. **Verteilung** — die Gruppe des Senders muss beim Netzwerk
   „TradingControl Subnet" als Distribution Group eingetragen sein.
   Erst dadurch *bekommt* der Peer die Route überhaupt.
2. **Zugriffsregel** — eine Policy muss der Gruppe des Senders den
   Zugriff auf die Ressource erlauben. Ohne sie ist die Route zwar da,
   der Verkehr wird aber verworfen.

Fehlt Nummer 2, sieht `netbird routes list` korrekt aus und die
Verbindung scheitert trotzdem — ein Fehlerbild, das leicht in die Irre
führt.

### Neuen Stand ausrollen

Der Bot liegt dort nicht als Git-Arbeitskopie, sondern als gebauter
Stand. Ausrollen heißt deshalb: bauen, packen, entpacken.

```bash
# 1. Bauen (erzeugt auch dist/ui/public)
npm run build

# 2. Packen — nur Manifeste und dist, keine node_modules
tar -czf /tmp/tc-bot.tgz \
  package.json package-lock.json tsconfig.base.json \
  packages/*/package.json packages/*/dist

# 3. Auf den Wirt und in den Container
scp /tmp/tc-bot.tgz TradingControl-Dev:/tmp/
ssh TradingControl-Dev 'pct push 550 /tmp/tc-bot.tgz /tmp/tc-bot.tgz'

# 4. Entpacken — --no-same-owner, sonst scheitert tar an der Windows-UID
ssh TradingControl-Dev 'pct exec 550 -- bash -c "
  cd /opt/tc-bot &&
  cp .env /opt/tc-bot-sicherung/.env.\$(date +%Y%m%d-%H%M%S) &&
  tar -xzf /tmp/tc-bot.tgz --no-same-owner &&
  chown -R root:root packages package.json package-lock.json &&
  npm install --omit=dev --workspaces --include-workspace-root &&
  systemctl restart tc-bot"'
```

Der Schritt `npm install` ist nicht optional: Er legt die
Workspace-Verknüpfungen in `node_modules/@tradingcontrol/` an. Ein neues
Paket — etwa `signals` — fehlt sonst zur Laufzeit.

Sicherungen liegen unter `/opt/tc-bot-sicherung/`.

```bash
# Protokoll ansehen
ssh TradingControl-Dev 'pct exec 550 -- journalctl -u tc-bot -f'
```

---

## Einrichten

### 1. Geheimnis setzen

```bash
openssl rand -hex 32
```

In die `.env`:

```
SIGNAL_WEBHOOK_SECRET=<der erzeugte Wert>
```

Oder über die Oberfläche: `PUT /api/signals/einstellungen` mit
`{"webhookSecret": "..."}`. Mindestens 24 Zeichen.

### 2. Erreichbarkeit prüfen

```bash
curl https://<host>/webhook/signal/ping
# {"ok":true,"eingerichtet":true}
```

### 3. Probelauf — vor dem ersten echten Signal

Diese Route rechnet ein Signal vollständig durch, **ohne einen Plan
anzulegen**:

```bash
curl -u ":<web-passwort>" -X POST https://<host>/api/signals/probe \
  -H 'Content-Type: application/json' \
  -d @signal.json
```

Die Antwort zeigt den Umrechnungsfaktor, die wirksame Grenze, die
entstehende Margin, das Risiko und den Plan, der entstünde. Hier sieht
man vor dem ersten Euro, ob der Indikator das Richtige schickt.

### 4. TradingView-Alarm einrichten

- **Webhook-URL:** `https://<host>/webhook/signal/<geheimnis>`
- **Nachricht:** das vollständige JSON-Objekt

Der häufigste Fehler beim Einrichten ist Text statt JSON in der
Alert-Nachricht. Der Bot antwortet in dem Fall mit einem entsprechenden
Hinweis.

TradingView-Platzhalter lassen sich einsetzen:

```json
{
  "signal_id": "meinindikator-{{ticker}}-{{timenow}}",
  "strategy": "MeinIndikator-V1",
  "emitted_at": "{{timenow}}",
  "action": "open",
  "symbol": "{{ticker}}",
  "direction": "long",
  "leverage": 10,
  "reference_capital": 10000,
  "total_size": 0.1,
  "entry_orders": [{ "price": {{close}}, "size": 0.1 }],
  "stop_loss_price": 48000,
  "take_profits": [{ "price": 52000, "percentage": 100 }]
}
```

> **Zur `signal_id`:** Sie muss je Signal verschieden sein, sonst gilt
> das zweite als Wiederholung des ersten und wird verworfen.
> `{{ticker}}-{{timenow}}` leistet das zuverlässig.

### 5. Zuschauen, dann freigeben

`SIGNAL_AUTO_START` steht auf `false`. Pläne aus Signalen werden angelegt
und sind in der Oberfläche sichtbar, werden aber nicht ausgeführt. Lassen
Sie den Indikator so eine Weile mitlaufen und vergleichen Sie die
entstandenen Pläne mit dem, was Sie erwartet hätten.

Erst dann:

```
SIGNAL_AUTO_START=true
```

### Sicherer: HMAC-Signatur

Die Adresse steht in Protokollen und Browserverläufen. Eine Signatur
nicht. Für einen eigenen Signalgeber ist das der bessere Weg:

```
SIGNAL_REQUIRE_SIGNATURE=true
```

Der Absender bildet dann über den **unveränderten** Rumpf:

```
HMAC-SHA256(geheimnis, rumpf)
```

und schickt das Ergebnis als `X-Signature` mit (auch `sha256=<hex>` wird
gelesen). Entscheidend ist: über genau die Zeichen signieren, die
gesendet werden. Ein erneutes `JSON.stringify` kann die Feldreihenfolge
ändern und damit die Prüfsumme.

TradingView selbst kann keine Signaturen bilden — dort bleibt es beim
Geheimnis im Pfad.

---

## Übersicht der Schnittstellen

### Offen (nur durch das Geheimnis geschützt)

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/webhook/signal/:secret` | Signal-Eingang |
| POST | `/webhook/signal` | Eingang mit Signatur oder `secret` im Rumpf |
| GET | `/webhook/signal/ping` | Erreichbarkeitsprüfung |

Geschützt durch: Geheimnis, optionale HMAC-Signatur, Drossel von 60
Anfragen je Minute und Adresse, Höchstgröße 64 KB, Replay-Schutz.

### Hinter der Passwortabfrage

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/signals` | Eingangsbuch |
| POST | `/api/signals/probe` | Probelauf ohne Plananlage |
| GET | `/api/signals/einstellungen` | aktuelle Einstellungen |
| PUT | `/api/signals/einstellungen` | Einstellungen ändern |
| PUT | `/api/signals/risikoprofil` | Risikoprofil ändern |
| PUT | `/api/signals/kapital` | Kapitalermittlung einstellen |
| GET | `/api/signals/kapital/:exchange/:quote` | Kontostand frisch abrufen |
| PUT | `/api/signals/plan-trigger/:planId` | Plan an ein Signal knüpfen (Weg A) |
| GET | `/api/signals/wartende-plaene` | Pläne, die auf ein Signal warten |
| POST | `/api/signals/aufraeumen` | alte Einträge löschen |

---

## Was mitgeschrieben wird

Jedes Signal landet in `signal_inbox` — **auch das abgelehnte**. Gerade
das abgelehnte: An der Börse hinterlässt es keine Spur, und ohne diesen
Eintrag ließe sich später nicht sagen, warum ein Trade ausblieb.

Festgehalten werden der unveränderte Datensatz, der Status, der Grund
einer Ablehnung, alle Hinweise und die vollständige Umrechnung
(`scaling_json`) — mit allen vier Obergrenzen, nicht nur der wirksamen.

Am Plan selbst steht die Rechnung in der Notiz:

```
Signal "MeinIndikator-V1" (meinindikator-BTCUSDT-1761292800)
Umgerechnet von 10.000 Referenzkapital auf 2.500 Kontostand — Faktor 0,2500
Margin: 500 → 125
Risiko am Stop-Loss: 200 → 50 (2,00 % des Kontos)
Hebel, Stop-Loss, Take-Profits und Trailing stammen unveraendert aus dem Signal.
```

---

## Kein Nachkauf nach dem ersten Take-Profit

Diese Regel gilt für **alle** Pläne, nicht nur für die aus Signalen —
sie steht im `TradePlanMonitor`.

Sobald ein Take-Profit gegriffen hat, ist die Einstiegsphase vorbei:
Noch nicht abgeschickte Einstiege werden nicht mehr platziert, bereits
platzierte Kauf-Limits werden von der Börse zurückgenommen.

Das betrifft gestaffelte Einstiege im Signal unmittelbar. Ein Beispiel:

```
Signal: 3 Einstiege zu 50.000 / 49.000 / 48.500, TP1 bei 52.000 (30 %)

Kurs fällt auf 48.400  →  alle drei Limits liegen an der Börse
Kurs steigt auf 52.100 →  TP1 greift, 30 % werden verkauft
                          die drei Kauf-Limits werden zurückgenommen
Kurs fällt auf 48.000  →  es wird NICHT nachgekauft
```

**Warum:** Ein Nachkauf nach einer Teilrealisierung verschiebt den
durchschnittlichen Einstieg nach oben (beim Long) und entwertet damit
den Stop-Loss, den der Signalgeber für den ursprünglichen Einstieg
bemessen hat. Aus einem Trade mit bekanntem Risiko würde einer mit
unbekanntem.

**Für den Signalgeber bedeutet das:** Ein Signal mit gestaffelten
Einstiegen und einem nahen TP1 wird in der Praxis oft nur teilweise
eingestiegen. Wer alle Stufen gefüllt sehen will, setzt TP1 weiter
entfernt oder verzichtet auf die Staffelung.

Schlägt das Zurücknehmen fehl — etwa weil die Börse gerade nicht
erreichbar ist —, wird die Order **nicht** als storniert vermerkt. Ein
Nachlauf versucht es bei jedem Durchlauf (alle 3 s) erneut, und der
Fehlschlag steht im Protokoll.

Ein Plan gilt als abgeschlossen, sobald nichts mehr offen ist — auch
wenn spätere Take-Profits nie erreicht wurden. Sie könnten nichts mehr
schließen.

---

## Einordnung in die Architektur

Die Regeln aus [CLAUDE.md](../CLAUDE.md) gelten unverändert:

**An das Journal geht nichts.** Der Signal-Eingang ändert daran nichts.
Was an der Börse geschah, holt sich das Journal weiterhin über seinen
eigenen API-Import.

**Die Bestände bleiben getrennt.** Es gibt jetzt drei, und sie
überschneiden sich nicht:

| Bestand | `source` | Ausführer |
|---|---|---|
| `local_plans` | — | `TradingEngine` |
| `bot_trade_plans` | `tc` | `TradePlanMonitor` |
| `bot_trade_plans` | `local` | `TradePlanMonitor` |
| `bot_trade_plans` | `signal` | `TradePlanMonitor` |

Der Journal-Abgleich räumt nur Pläne mit `source = 'tc'` auf
([tc-plan-sync-service.ts:162](../packages/docker-bot/src/services/tc-plan-sync-service.ts#L162))
und lässt Signal-Pläne unberührt. Jeder Bestand hat genau einen
Ausführer — deshalb kann keine Order zweimal an die Börse gehen.

**Der Bot bleibt ohne Journal lauffähig.** Der Signal-Eingang braucht
TradingControl nicht.

**MiCA gilt weiter.** Ein Signal auf eine nicht zugelassene Börse wird
bei `NUR_MICA_BOERSEN=true` abgelehnt wie jeder andere Plan auch.

---

## Wo was steht

| Datei | Inhalt |
|---|---|
| [packages/signals/src/types.ts](../packages/signals/src/types.ts) | Signal-Format, Risikoprofil, Ergebnistypen |
| [packages/signals/src/signal-schema.ts](../packages/signals/src/signal-schema.ts) | Prüfung und Vereinheitlichung |
| [packages/signals/src/position-scaler.ts](../packages/signals/src/position-scaler.ts) | **die Umrechnung** |
| [packages/signals/src/authentication.ts](../packages/signals/src/authentication.ts) | Geheimnis, HMAC, Replay-Schutz |
| [packages/signals/src/plan-builder.ts](../packages/signals/src/plan-builder.ts) | Signal → Handelsplan |
| [services/signal-service.ts](../packages/docker-bot/src/services/signal-service.ts) | Ablauf beider Wege |
| [services/capital-service.ts](../packages/docker-bot/src/services/capital-service.ts) | Kontostand und Marktgrenzen |
| [web/routes/signal-webhook.ts](../packages/docker-bot/src/web/routes/signal-webhook.ts) | der Eingang |
| [web/routes/signals.ts](../packages/docker-bot/src/web/routes/signals.ts) | Verwaltung |
| [trade-plan-monitor.ts](../packages/docker-bot/src/services/trade-plan-monitor.ts) | Weg A: Freigabe auswerten |

Tests: `packages/signals/src/position-scaler.test.ts` (26) und
`signal-schema.test.ts` (39).
