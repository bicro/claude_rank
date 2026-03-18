#!/usr/bin/env node
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchBadges } from "./lib/api.mjs";

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function main() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  let badges;
  try {
    badges = await fetchBadges(hash);
  } catch {
    console.log("## 🏅 Claude Rank Badges\n");
    console.log("Unable to fetch badges. Check your connection.");
    process.exit(0);
  }

  const list = Array.isArray(badges) ? badges : badges.badges || [];

  const lines = [];
  lines.push("## 🏅 Claude Rank Badges");
  lines.push("");

  if (list.length === 0) {
    lines.push("No badges earned yet! Keep using Claude to unlock achievements.");
    lines.push("Visit https://clauderank.com to see all available badges.");
  } else {
    lines.push(`${list.length} badges earned`);
    lines.push("");
    lines.push("| Badge | Description | Unlocked |");
    lines.push("|-------|-------------|----------|");
    for (const b of list) {
      const name = b.name || b.id || "Unknown";
      const desc = b.description || "";
      const date = fmtDate(b.unlocked_at);
      lines.push(`| ${name} | ${desc} | ${date} |`);
    }
  }

  console.log(lines.join("\n"));
}

main();
