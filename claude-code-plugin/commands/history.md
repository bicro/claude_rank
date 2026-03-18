---
description: Show your Claude usage history and daily trends
args: "[days]"
---
Run the command below and display the output exactly as-is. Do not reformat, summarize, or add commentary.

The user may provide an optional `days` argument (default: 7).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch-history.mjs" {days}
```
