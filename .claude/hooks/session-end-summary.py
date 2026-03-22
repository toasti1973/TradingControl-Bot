#!/usr/bin/env python3
"""Hook: Notification — enforce session-end summary after sustained work.

Tracks whether a session summary has been saved. After 15+ turns without
a session summary, starts reminding. After 25+ turns, makes it urgent.

Detects session summaries by monitoring memcp_remember calls with
session-related tags (tracked via state file).

Usage in .claude/settings.local.json:
  Already integrated into Notification hook chain.
  This script is called by auto-save-reminder.py OR can run standalone:

  "Notification": [{
    "matcher": "",
    "hooks": [{"type": "command", "command": "python .claude/hooks/session-end-summary.py"}]
  }]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _get_state_path() -> Path:
    data_dir = Path(os.getenv("MEMCP_DATA_DIR", "~/.memcp")).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "state.json"


def _load_state() -> dict:
    path = _get_state_path()
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, ValueError):
            pass
    return {}


def _save_state(state: dict) -> None:
    path = _get_state_path()
    path.write_text(json.dumps(state, indent=2))


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        input_data = {}

    state = _load_state()
    turns = state.get("turn_count", 0)
    has_summary = state.get("session_summary_saved", False)

    # If summary was already saved this session, stay quiet
    if has_summary:
        print(json.dumps({}))
        return

    message = None

    if turns >= 25:
        message = (
            "SESSION-SUMMARY PFLICHT: Du arbeitest seit {turns} Turns ohne "
            "Session-Summary. Speichere JETZT eine Zusammenfassung:\n\n"
            "memcp_remember(\n"
            '  content="Session-Summary: [Was wurde erledigt, Erkenntnisse, offene Punkte]",\n'
            '  category="general",\n'
            '  importance="medium",\n'
            '  tags="session-summary,[relevante-tags]"\n'
            ")\n\n"
            "Diese Zusammenfassung hilft dir in der nächsten Sitzung, "
            "nahtlos weiterzuarbeiten."
        ).format(turns=turns)
    elif turns >= 15:
        message = (
            "Session-Summary empfohlen: Nach {turns} Turns solltest du eine "
            "Zusammenfassung der bisherigen Arbeit speichern "
            '(memcp_remember mit tags="session-summary"). '
            "Das sichert den Kontext für die nächste Sitzung."
        ).format(turns=turns)

    if message:
        print(json.dumps({"systemMessage": message}))
    else:
        print(json.dumps({}))


if __name__ == "__main__":
    main()
