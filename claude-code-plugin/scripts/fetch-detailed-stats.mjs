#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchUserProfile } from "./lib/api.mjs";
import { loadStats } from "./lib/log-parser.mjs";
import { fmtNum, fmtTokens, fmtDuration, estimateCost } from "./lib/format.mjs";

export async function renderDetailedStats() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  const profile = await fetchUserProfile(hash);

  const m = profile.metrics || profile;
  const localStats = loadStats();
  const modelUsage = localStats.modelUsage || {};

  const totalTokens = m.total_tokens ?? 0;
  const sessionSecs = localStats.totalSessionTimeSecs || 0;
  const activeSecs = localStats.totalActiveTimeSecs || 0;
  const idleSecs = localStats.totalIdleTimeSecs || 0;
  const spend = m.estimated_spend != null
    ? `$${Number(m.estimated_spend).toFixed(2)}`
    : estimateCost(modelUsage);

  const out = [];
  out.push("## Usage Statistics");
  out.push("");

  // Overview
  out.push("### Overview");
  out.push(`${fmtNum(totalTokens)} tokens · ${fmtNum(m.total_messages ?? 0)} messages · ${fmtNum(m.total_sessions ?? 0)} sessions · ${fmtNum(m.total_tool_calls ?? 0)} tool calls`);
  if (sessionSecs > 0) {
    out.push(`Session: ${fmtDuration(sessionSecs)} total · ${fmtDuration(activeSecs)} active · ${fmtDuration(idleSecs)} idle`);
  }
  const memberLine = localStats.firstSessionDate ? ` · Member since ${localStats.firstSessionDate}` : "";
  out.push(`Est. spend: ${spend}${memberLine}`);

  // Models
  const models = Object.entries(modelUsage);
  if (models.length > 0) {
    out.push("");
    out.push("### Models");
    for (const [model, usage] of models) {
      const inp = usage.inputTokens ?? 0;
      const outp = usage.outputTokens ?? 0;
      const cr = usage.cacheReadInputTokens ?? 0;
      const cc = usage.cacheCreationInputTokens ?? 0;
      const total = inp + outp + cr + cc;
      out.push(`**${model}:** ${fmtTokens(inp)} in · ${fmtTokens(outp)} out · ${fmtTokens(cr)} cache read · ${fmtTokens(cc)} cache write (${fmtTokens(total)} total)`);
    }
  }

  // Progress
  out.push("");
  out.push("### Progress");
  out.push(`Lv.${m.level ?? 0} · ${fmtNum(m.total_points ?? 0)} pts · ${m.current_streak ?? 0} day streak`);

  return out.join("\n");
}

async function main() {
  try {
    console.log(await renderDetailedStats());
  } catch {
    console.log("## Usage Statistics\n\nUnable to fetch stats. Make sure you've synced at least once.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
