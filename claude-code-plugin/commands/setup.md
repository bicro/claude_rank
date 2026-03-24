---
description: Set up Claude Rank statusline HUD
allowed-tools: mcp__plugin_claude-rank_claude-rank__authenticate
---

Configure the Claude Rank statusline by adding it to the user's Claude Code settings.

## Step 1: Detect runtime and plugin path

Determine the platform from the environment context (`Platform:` and `Shell:` values).

**For macOS/Linux (or win32+bash):**

```bash
RUNTIME=$(command -v node 2>/dev/null)
echo "Runtime: $RUNTIME"
```

**For win32+PowerShell:**

```powershell
$runtime = (Get-Command node -ErrorAction SilentlyContinue).Source
Write-Host "Runtime: $runtime"
```

## Step 2: Generate the statusline command

The command needs to find the plugin directory and run the statusline script.

**For macOS/Linux (or win32+bash):**

The generated command should be:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"
```

But since `${CLAUDE_PLUGIN_ROOT}` is only available during plugin command execution, we need the resolved absolute path. Check if `CLAUDE_PLUGIN_ROOT` is set:

```bash
echo "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}"
```

If set, use that path directly. Otherwise, check for the plugin in the cache:
```bash
ls -d "$HOME"/.claude/plugins/cache/claude-rank/claude-rank/*/ 2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
```

The final command should be: `node "<resolved_plugin_path>/scripts/statusline.mjs"`

**For win32+PowerShell:**

```powershell
Write-Host "CLAUDE_PLUGIN_ROOT=$env:CLAUDE_PLUGIN_ROOT"
```

## Step 3: Read current settings and merge

Read the user's Claude Code settings file and merge in the statusLine configuration. Do NOT overwrite other existing settings.

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

Merge in:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<RESOLVED_PATH>/scripts/statusline.mjs\""
  }
}
```

Write the merged settings back to the file. Preserve all existing keys.

## Step 4: Verify

Tell the user: "Claude Rank statusline configured! Restart Claude Code to see it. The HUD shows your level, rank, streak, and today's token usage."

## Step 5: Authenticate

Now use the `authenticate` tool from the claude-rank MCP server to connect the user's social account. Display the output exactly as-is. Do not reformat, summarize, or add commentary.

The tool handles both cases automatically:
- If already authenticated, it confirms the connection
- If not yet authenticated, it provides a URL to connect an account
