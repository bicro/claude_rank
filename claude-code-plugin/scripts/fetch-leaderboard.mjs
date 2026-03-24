#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchLeaderboard } from "./lib/api.mjs";
import { fmtNum } from "./lib/format.mjs";

const CATEGORY_LABELS = {
  tokens: "Tokens",
  concurrent_agents: "Concurrent Agents",
  agent_hours: "Agent Hours",
  concurrency_time: "Concurrency Time",
  consistency: "Consistency",
  messages: "Messages",
};

export async function renderLeaderboard(category = "tokens", limit = 20) {
  const config = loadOrCreateIdentity();
  const myHash = getLookupHash(config);

  const data = await fetchLeaderboard(category, limit);

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

  return out.join("\n");
}

async function main() {
  const category = process.argv[2] || "tokens";
  const limit = parseInt(process.argv[3] || "20", 10);
  try {
    console.log(await renderLeaderboard(category, limit));
  } catch {
    console.log("## Leaderboard\n\nUnable to fetch leaderboard. Check your connection.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
