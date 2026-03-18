---
description: Show the Claude Rank global leaderboard
args: "[category]"
---
Run the command below and display the output exactly as-is. Do not reformat, summarize, or add commentary.

The user may provide an optional category: `weighted` (default), `tokens`, `activity`, `tool_calls`, `uniqueness`, `cost`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch-leaderboard.mjs" {category}
```
