#!/usr/bin/env python3
"""Hook: PostToolUse — track when a session summary is saved.

After memcp_remember, checks if the call contained session-summary tags.
If so, sets session_summary_saved=True in state to suppress further reminders.

Usage in .claude/settings.local.json:
  "PostToolUse": [
    {"matcher": "mcp__memory__memcp_remember",
     "hooks": [{"type": "command", "command": "python .claude/hooks/track-summary.py"}]}
  ]
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


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        input_data = {}

    # Check if this remember call has session-summary tags
    tool_input = input_data.get("tool_input", {})
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except (json.JSONDecodeError, ValueError):
            tool_input = {}

    tags = str(tool_input.get("tags", "")).lower()
    content = str(tool_input.get("content", "")).lower()

    is_summary = (
        "session-summary" in tags
        or "session_summary" in tags
        or "session-zusammenfassung" in content
        or "session-summary" in content
    )

    if is_summary:
        state_path = _get_state_path()
        state: dict = {}
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text())
            except (json.JSONDecodeError, ValueError):
                state = {}
        state["session_summary_saved"] = True
        state_path.write_text(json.dumps(state, indent=2))

    print(json.dumps({}))


if __name__ == "__main__":
    main()
