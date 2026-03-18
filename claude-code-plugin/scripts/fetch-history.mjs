#!/usr/bin/env node
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchHistory } from "./lib/api.mjs";
import { fmtNum, fmtTokens } from "./lib/format.mjs";

const days = parseInt(process.argv[2] || "7", 10);

async function main() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  let history;
  try {
    history = await fetchHistory(hash, days);
  } catch {
    console.log("## 📈 Claude Usage History\n");
    console.log("Unable to fetch history. Make sure you've synced at least once.");
    process.exit(0);
  }

  const entries = Array.isArray(history) ? history : history.daily || history.history || [];

  const lines = [];
  lines.push(`## 📈 Claude Usage History — Last ${days} Days`);
  lines.push("");

  if (entries.length === 0) {
    lines.push("No history data available. Sync first by running `/claude-rank:rank`.");
  } else {
    lines.push("| Date | Messages | Tokens | Tool Calls | Sessions |");
    lines.push("|------|----------|--------|------------|----------|");

    let totalMsg = 0, totalTok = 0, totalTool = 0, totalSess = 0;

    for (const e of entries) {
      const date = e.date;
      const msg = e.messageCount ?? e.messages ?? 0;
      const tok = e.tokenCount ?? e.tokens ?? 0;
      const tool = e.toolCallCount ?? e.tool_calls ?? 0;
      const sess = e.sessionCount ?? e.sessions ?? 0;

      totalMsg += msg;
      totalTok += tok;
      totalTool += tool;
      totalSess += sess;

      lines.push(`| ${date} | ${fmtNum(msg)} | ${fmtTokens(tok)} | ${fmtNum(tool)} | ${fmtNum(sess)} |`);
    }

    lines.push(`| **Total** | **${fmtNum(totalMsg)}** | **${fmtTokens(totalTok)}** | **${fmtNum(totalTool)}** | **${fmtNum(totalSess)}** |`);
  }

  console.log(lines.join("\n"));
}

main();
