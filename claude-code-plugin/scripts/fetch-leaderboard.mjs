#!/usr/bin/env node
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchLeaderboard } from "./lib/api.mjs";
import { fmtNum, tierEmoji } from "./lib/format.mjs";

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
    console.log("## 🏆 Claude Rank Leaderboard\n");
    console.log("Unable to fetch leaderboard. Check your connection.");
    process.exit(0);
  }

  const label = CATEGORY_LABELS[category] || category;
  const entries = data.leaderboard || data.entries || data || [];

  const lines = [];
  lines.push(`## 🏆 Claude Rank Leaderboard — ${label}`);
  lines.push("");
  lines.push("| Rank | Username | Score | Tier |");
  lines.push("|------|----------|-------|------|");

  let myPosition = null;

  for (const entry of entries) {
    const rank = entry.rank ?? "—";
    const name = entry.username || "Anonymous";
    const score = fmtNum(entry.value ?? entry.score ?? 0);
    const level = entry.level ?? 0;
    const emoji = tierEmoji(level);
    const isMe = entry.user_hash === myHash || entry.primary_hash === myHash;

    if (isMe) {
      lines.push(`| **►#${rank}** | **${name}** | **${score}** | **${emoji}** |`);
      myPosition = rank;
    } else {
      lines.push(`| #${rank} | ${name} | ${score} | ${emoji} |`);
    }
  }

  if (myPosition) {
    lines.push("");
    lines.push(`**Your position:** #${myPosition}`);
  }

  console.log(lines.join("\n"));
}

main();
