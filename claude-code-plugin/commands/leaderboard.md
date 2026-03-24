---
description: Show the Claude Rank global leaderboard
args: "[category]"
allowed-tools: mcp__plugin_claude-rank_claude-rank__get_leaderboard
---
Use the `get_leaderboard` tool from the claude-rank MCP server. Pass the optional category argument if the user provided one: `tokens` (default), `concurrent_agents`, `agent_hours`, `concurrency_time`, `consistency`, `messages`. Display the output exactly as-is. Do not reformat, summarize, or add commentary.
