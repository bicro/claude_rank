#!/usr/bin/env node
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchUserProfile } from "./lib/api.mjs";
import { fmtNum, fmtRank, fmtPercentile, getTier, tierEmoji } from "./lib/format.mjs";

async function main() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  let profile;
  try {
    profile = await fetchUserProfile(hash);
  } catch {
    console.log("## Claude Rank\n\nUnable to fetch profile. Make sure you've synced at least once.");
    process.exit(0);
  }

  const m = profile.metrics || profile;
  const level = m.level ?? 0;
  const tier = getTier(level);
  const emoji = tierEmoji(level);
  const points = fmtNum(m.total_points ?? 0);
  const streak = m.current_streak ?? 0;
  const username = config.username || profile.username || "Anonymous";
  const badges = profile.badges || [];

  const out = [];
  out.push(`## Claude Rank  @${username}`);
  out.push(`Lv.${level} ${emoji} ${tier} · ${points} pts · ${streak} day streak`);
  out.push(`Profile: https://clauderank.com/user/${hash}`);

  // Rankings
  const ranks = profile.ranks || {};
  const categories = [
    ["Weighted", "weighted"],
    ["Tokens", "tokens"],
    ["Activity", "activity"],
    ["Tool Calls", "tool_calls"],
    ["Uniqueness", "uniqueness"],
    ["Spend", "cost"],
  ];

  const rankParts = [];
  for (const [label, key] of categories) {
    const r = ranks[key];
    if (r) {
      rankParts.push(`${label} ${fmtRank(r.rank)} (${fmtPercentile(r.percentile)})`);
    }
  }
  if (rankParts.length > 0) {
    out.push("");
    out.push("### Rankings");
    out.push(rankParts.join(" · "));
  }

  // Badges
  out.push("");
  if (badges.length > 0) {
    const badgeNames = badges.slice(0, 5).map(b => b.name).join(", ");
    const more = badges.length > 5 ? ` (+${badges.length - 5} more)` : "";
    out.push(`### Badges: ${badges.length} earned`);
    out.push(`${badgeNames}${more}`);
  } else {
    out.push("### Badges: 0 earned");
  }

  console.log(out.join("\n"));
}

main();
