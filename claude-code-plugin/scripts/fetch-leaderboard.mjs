#!/usr/bin/env node
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchLeaderboard } from "./lib/api.mjs";
import { fmtNum } from "./lib/format.mjs";

const category = process.argv[2] || "weighted";
const limit = parseInt(process.argv[3] || "20", 10);

const CATEGORY_LABELS = {
  weighted: "Weighted",
  tokens: "Tokens",
  activity: "Activity",
  tool_calls: "Tool Calls",
  uniqueness: "Uniqueness",
  cost: "Spend",
};

async function main() {
  const config = loadOrCreateIdentity();
  const myHash = getLookupHash(config);

  let data;
  try {
    data = await fetchLeaderboard(category, limit);
  } catch {
    console.log("## Leaderboard\n\nUnable to fetch leaderboard. Check your connection.");
    process.exit(0);
  }

  const label = CATEGORY_LABELS[category] || category;
  const entries = data.leaderboard || data.entries || data || [];

  const out = [];
  out.push(`## Leaderboard — ${label}`);
  out.push("");

  let myPosition = null;

  // Find max widths for alignment
  const maxRankW = String(entries.length > 0 ? entries[entries.length - 1].rank ?? entries.length : 1).length;
  const maxNameW = Math.max(...entries.map(e => (e.username || "Anonymous").length), 5);
  const maxScoreW = Math.max(...entries.map(e => fmtNum(e.value ?? e.score ?? 0).length), 5);

  out.push("```");
  for (const entry of entries) {
    const rank = entry.rank ?? "—";
    const name = entry.username || "Anonymous";
    const score = fmtNum(entry.value ?? entry.score ?? 0);
    const level = entry.level ?? 0;
    const isMe = entry.user_hash === myHash || entry.primary_hash === myHash;

    const prefix = isMe ? ">" : " ";
    const rankStr = `#${rank}`.padStart(maxRankW + 1);
    const nameStr = name.padEnd(maxNameW);
    const scoreStr = score.padStart(maxScoreW);

    out.push(`${prefix}${rankStr}  ${nameStr}  ${scoreStr}  Lv.${level}`);
    if (isMe) myPosition = rank;
  }
  out.push("```");

  if (myPosition) {
    out.push("");
    out.push(`Your position: #${myPosition}`);
  }

  console.log(out.join("\n"));
}

main();
