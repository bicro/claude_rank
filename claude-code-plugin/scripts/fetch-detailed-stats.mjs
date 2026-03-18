#!/usr/bin/env node
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { fetchUserProfile } from "./lib/api.mjs";
import { loadStats } from "./lib/log-parser.mjs";
import { fmtNum, fmtTokens, fmtDuration, estimateCost } from "./lib/format.mjs";

async function main() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  let profile;
  try {
    profile = await fetchUserProfile(hash);
  } catch {
    console.log("## Claude Usage Statistics\n");
    console.log("Unable to fetch stats. Make sure you've synced at least once and check your connection.");
    process.exit(0);
  }

  const m = profile.metrics || profile;
  const localStats = loadStats();
  const modelUsage = localStats.modelUsage || {};

  // Use API totals, fall back to local
  const totalTokens = m.total_tokens ?? 0;

  const lines = [];
  lines.push("## 📊 Claude Usage Statistics");
  lines.push("");
  lines.push("### Overview");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Tokens | ${fmtNum(totalTokens)} |`);
  lines.push(`| Total Messages | ${fmtNum(m.total_messages ?? 0)} |`);
  lines.push(`| Total Sessions | ${fmtNum(m.total_sessions ?? 0)} |`);
  lines.push(`| Total Tool Calls | ${fmtNum(m.total_tool_calls ?? 0)} |`);

  // Session times from local stats
  const sessionSecs = localStats.totalSessionTimeSecs || 0;
  const activeSecs = localStats.totalActiveTimeSecs || 0;
  const idleSecs = localStats.totalIdleTimeSecs || 0;
  if (sessionSecs > 0) {
    lines.push(`| Session Time | ${fmtDuration(sessionSecs)} |`);
    lines.push(`| Active Time | ${fmtDuration(activeSecs)} |`);
    lines.push(`| Idle Time | ${fmtDuration(idleSecs)} |`);
  }

  // Estimated spend — prefer API value, fall back to local computation
  const spend = m.estimated_spend != null
    ? `$${Number(m.estimated_spend).toFixed(2)}`
    : estimateCost(modelUsage);
  lines.push(`| Est. Spend | ${spend} |`);

  if (localStats.firstSessionDate) {
    lines.push(`| Member Since | ${localStats.firstSessionDate} |`);
  }

  // Token breakdown by model from local stats
  const models = Object.entries(modelUsage);
  if (models.length > 0) {
    lines.push("");
    lines.push("### Token Usage by Model");
    lines.push("");
    lines.push("| Model | Input | Output | Cache Read | Cache Create | Total |");
    lines.push("|-------|-------|--------|------------|--------------|-------|");
    for (const [model, usage] of models) {
      const inp = usage.inputTokens ?? 0;
      const out = usage.outputTokens ?? 0;
      const cr = usage.cacheReadInputTokens ?? 0;
      const cc = usage.cacheCreationInputTokens ?? 0;
      const total = inp + out + cr + cc;
      lines.push(`| ${model} | ${fmtTokens(inp)} | ${fmtTokens(out)} | ${fmtTokens(cr)} | ${fmtTokens(cc)} | ${fmtTokens(total)} |`);
    }
  }

  // Points breakdown
  lines.push("");
  lines.push("### Points Breakdown");
  lines.push("");
  lines.push("| Category | Value |");
  lines.push("|----------|-------|");
  lines.push(`| Level | ${m.level ?? 0} |`);
  lines.push(`| Total Points | ${fmtNum(m.total_points ?? 0)} |`);
  lines.push(`| Current Streak | 🔥 ${m.current_streak ?? 0} days |`);

  console.log(lines.join("\n"));
}

main();
