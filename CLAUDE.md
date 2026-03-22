# Projekt-Anweisungen für Claude

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
