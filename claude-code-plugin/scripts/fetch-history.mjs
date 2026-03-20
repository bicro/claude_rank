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
    console.log(`## Usage History — Last ${days} Days\n\nUnable to fetch history. Make sure you've synced at least once.`);
    process.exit(0);
  }

  const entries = Array.isArray(history) ? history : history.daily || history.history || [];

  const out = [];
  out.push(`## Usage History — Last ${days} Days`);
  out.push("");

  if (entries.length === 0) {
    out.push("No history data available. Sync first by running `/claude-rank:rank`.");
  } else {
    let totalMsg = 0, totalTok = 0, totalTool = 0, totalSess = 0;

    for (const e of entries) {
      const msg = e.messageCount ?? e.messages ?? 0;
      const tok = e.tokenCount ?? e.tokens ?? 0;
      const tool = e.toolCallCount ?? e.tool_calls ?? 0;
      const sess = e.sessionCount ?? e.sessions ?? 0;
      totalMsg += msg; totalTok += tok; totalTool += tool; totalSess += sess;

      out.push(`**${e.date}**  ${fmtNum(msg)} msg · ${fmtTokens(tok)} tok · ${fmtNum(tool)} tools · ${fmtNum(sess)} sess`);
    }

    out.push("");
    out.push(`**Total:** ${fmtNum(totalMsg)} msg · ${fmtTokens(totalTok)} tok · ${fmtNum(totalTool)} tools · ${fmtNum(totalSess)} sess`);
  }

  console.log(out.join("\n"));
}

main();
