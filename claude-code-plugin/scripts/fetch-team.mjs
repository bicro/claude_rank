#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchUserProfile, fetchTeam, fetchTeamBurn } from "./lib/api.mjs";
import { fmtTokens, fmtNum } from "./lib/format.mjs";

export async function renderTeam() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  // Get user's team_hash from profile
  const profile = await fetchUserProfile(hash);
  const teamHash = profile.team_hash;

  if (!teamHash) {
    return "## Team\n\nYou're not on a team yet. Create or join one at https://clauderank.com";
  }

  // Fetch team info and today's burn in parallel
  const [team, burn] = await Promise.all([
    fetchTeam(teamHash),
    fetchTeamBurn(teamHash),
  ]);

  const out = [];

  // Header
  out.push(`## 🏢 ${team.team_name}`);
  out.push(`\`invite: ${team.team_hash}\` · ${team.member_count} member${team.member_count !== 1 ? "s" : ""}`);
  out.push("");

  // Team totals
  const m = team.metrics || {};
  const totalSpend = (burn.members || []).reduce((sum, mb) => sum + (mb.estimated_spend || 0), 0);
  out.push("### Team Totals");
  out.push(`Tokens ${fmtTokens(m.total_tokens)} · Messages ${fmtNum(m.total_messages)} · Sessions ${fmtNum(m.total_sessions)}`);
  out.push("");

  // Today's burn
  const members = (burn.members || []).slice().sort((a, b) => (b.daily_tokens || 0) - (a.daily_tokens || 0));
  const teamDayTokens = members.reduce((sum, mb) => sum + (mb.daily_tokens || 0), 0);
  const teamDaySpend = members.reduce((sum, mb) => sum + (mb.estimated_spend || 0), 0);

  out.push("### Today's Burn");
  out.push(`Team Total: ${fmtTokens(teamDayTokens)} tokens · $${teamDaySpend.toFixed(2)}`);
  out.push("");

  if (members.length > 0) {
    out.push("| Member | Tokens | Cost |");
    out.push("|--------|--------|------|");
    for (const mb of members) {
      const name = mb.display_name || mb.username || mb.user_hash.slice(0, 8);
      const tokens = mb.daily_tokens > 0 ? fmtTokens(mb.daily_tokens) : "—";
      const cost = mb.estimated_spend > 0 ? `$${mb.estimated_spend.toFixed(2)}` : "—";
      out.push(`| ${name} | ${tokens} | ${cost} |`);
    }
  }

  return out.join("\n");
}

// Main (backward compat for direct node execution)
async function main() {
  try {
    console.log(await renderTeam());
  } catch {
    console.log("## Team\n\nUnable to fetch team data. Make sure you've synced at least once.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
