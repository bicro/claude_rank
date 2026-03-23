#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchBadges } from "./lib/api.mjs";

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export async function renderBadges() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  const badges = await fetchBadges(hash);

  const list = Array.isArray(badges) ? badges : badges.badges || [];

  const out = [];
  out.push(`## Badges — ${list.length} earned`);
  out.push("");

  if (list.length === 0) {
    out.push("No badges earned yet! Keep using Claude to unlock achievements.");
    out.push("Visit https://clauderank.com to see all available badges.");
  } else {
    for (const b of list) {
      const name = b.name || b.id || "Unknown";
      const desc = b.description ? ` — ${b.description}` : "";
      const date = fmtDate(b.unlocked_at);
      out.push(`**${name}**${desc} · ${date}`);
    }
  }

  return out.join("\n");
}

async function main() {
  try {
    console.log(await renderBadges());
  } catch {
    console.log("## Badges\n\nUnable to fetch badges. Check your connection.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
