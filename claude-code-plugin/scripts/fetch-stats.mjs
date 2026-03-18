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
    console.log("## Claude Rank Dashboard\n");
    console.log("Unable to fetch profile. Make sure you've synced at least once and check your connection.");
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

  const lines = [];
  lines.push(`## ${emoji} Claude Rank Dashboard`);
  lines.push("");
  lines.push(`**Username:** ${username}`);
  lines.push(`**Profile:** https://clauderank.com/user/${hash}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Level | Lv.${level} |`);
  lines.push(`| Tier | ${emoji} ${tier} |`);
  lines.push(`| Points | ${points} |`);
  lines.push(`| Streak | 🔥 ${streak} days |`);

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

  const hasRanks = categories.some(([, key]) => ranks[key]);
  if (hasRanks) {
    lines.push("");
    lines.push("### Rankings");
    lines.push("");
    lines.push("| Category | Rank | Percentile |");
    lines.push("|----------|------|------------|");
    for (const [label, key] of categories) {
      const r = ranks[key];
      if (r) {
        lines.push(`| ${label} | ${fmtRank(r.rank)} | ${fmtPercentile(r.percentile)} |`);
      } else {
        lines.push(`| ${label} | — | — |`);
      }
    }
  }

  // Badges summary
  lines.push("");
  if (badges.length > 0) {
    const badgeNames = badges.slice(0, 5).map(b => b.name).join(", ");
    const more = badges.length > 5 ? ` (+${badges.length - 5} more)` : "";
    lines.push(`### Badges: ${badges.length} earned`);
    lines.push("");
    lines.push(`${badgeNames}${more}`);
  } else {
    lines.push("### Badges: 0 earned");
  }

  console.log(lines.join("\n"));
}

main();
