#!/usr/bin/env python3
"""Hook: PostToolUse — prompt Claude to reinforce after memcp_recall.

After each recall, reminds Claude to evaluate the returned insights
and call memcp_reinforce(insight_id, helpful=True/False) for each.
This accelerates the learning loop: good insights rise, bad ones sink.

Only triggers when recall actually returned results (not empty).

Usage in .claude/settings.local.json:
  "PostToolUse": [
    {"matcher": "mcp__memory__memcp_recall",
     "hooks": [{"type": "command", "command": "python .claude/hooks/post-recall-reinforce.py"}]}
  ]
"""

from __future__ import annotations

import json
import sys


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        input_data = {}

    # Check if the tool returned actual results
    tool_result = input_data.get("tool_result", "")
    result_str = str(tool_result)

    # Skip if recall returned nothing useful
    if not result_str or "no results" in result_str.lower() or "keine" in result_str.lower():
        print(json.dumps({}))
        return

    # Skip if result is very short (likely empty or error)
    if len(result_str) < 50:
        print(json.dumps({}))
        return

    message = (
        "REINFORCE REMINDER: Du hast gerade Recall-Ergebnisse erhalten. "
        "Bewerte die Treffer mit memcp_reinforce():\n"
        "- Insight war hilfreich → memcp_reinforce(insight_id, helpful=True)\n"
        "- Insight war irrelevant → memcp_reinforce(insight_id, helpful=False, note=\"Grund\")\n"
        "Das verbessert zukünftige Recalls erheblich."
    )

    print(json.dumps({"systemMessage": message}))


if __name__ == "__main__":
    main()
