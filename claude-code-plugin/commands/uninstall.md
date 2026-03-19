---
description: Remove Claude Rank statusline and clean up settings
---

Remove the Claude Rank statusline configuration from the user's Claude Code settings.

## Step 1: Read current settings

Read the user's Claude Code settings file.

**For macOS/Linux (or win32+bash):**

Settings file: `~/.claude/settings.json`

```bash
cat ~/.claude/settings.json 2>/dev/null || echo "{}"
```

**For win32+PowerShell:**

Settings file: `$env:USERPROFILE\.claude\settings.json`

```powershell
Get-Content "$env:USERPROFILE\.claude\settings.json" -ErrorAction SilentlyContinue
```

## Step 2: Remove statusLine from settings

Parse the JSON, remove the `"statusLine"` key entirely, and write the remaining settings back to the file. Preserve all other existing keys.

If the `statusLine` key doesn't exist or doesn't reference `claude-rank`, tell the user "Claude Rank statusline is not currently configured." and stop.

Write the updated JSON back to the settings file.

## Step 3: Clear cached data (optional)

Ask the user if they also want to remove cached data. If yes, delete:

**For macOS/Linux (or win32+bash):**
```bash
rm -f ~/.ClaudeRank/profile-cache.json
rm -f ~/.ClaudeRank/stats-cache.json
```

**For win32+PowerShell:**
```powershell
Remove-Item "$env:USERPROFILE\.ClaudeRank\profile-cache.json" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.ClaudeRank\stats-cache.json" -ErrorAction SilentlyContinue
```

Do NOT remove `~/.ClaudeRank/ranking.json` — that contains the user's identity and sync secret, which they'd need if they reinstall.

## Step 4: Confirm

Tell the user: "Claude Rank statusline removed. Restart Claude Code for changes to take effect. Your identity and sync history are preserved — reinstall anytime with `/claude-rank:setup`."
