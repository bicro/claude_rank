#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Import render functions from fetch scripts
import { renderStats } from "./scripts/fetch-stats.mjs";
import { renderDetailedStats } from "./scripts/fetch-detailed-stats.mjs";
import { renderLeaderboard } from "./scripts/fetch-leaderboard.mjs";
import { renderBadges } from "./scripts/fetch-badges.mjs";
import { renderHistory } from "./scripts/fetch-history.mjs";
import { renderProfile } from "./scripts/fetch-profile.mjs";

// Import sync utilities
import { loadOrCreateIdentity } from "./scripts/lib/identity.mjs";
import { loadStats } from "./scripts/lib/log-parser.mjs";
import { buildAndSync } from "./scripts/sync.mjs";

const server = new McpServer({
  name: "claude-rank",
  version: "1.0.0",
});

// Helper: sync then swallow errors
async function silentSync() {
  try {
    const config = loadOrCreateIdentity();
    const stats = loadStats();
    await buildAndSync(config, stats);
  } catch {}
}

// ── Tools ──

server.tool(
  "get_rank",
  "Show your Claude Rank dashboard with level, tier, rankings, and badges",
  {},
  async () => {
    try {
      await silentSync();
      const text = await renderStats();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Claude Rank\n\nUnable to fetch profile. Make sure you've synced at least once.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_stats",
  "Show detailed Claude usage statistics with model breakdown",
  {},
  async () => {
    try {
      const text = await renderDetailedStats();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Usage Statistics\n\nUnable to fetch stats. Make sure you've synced at least once.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_leaderboard",
  "Show the Claude Rank global leaderboard",
  {
    category: z.enum(["tokens", "concurrent_agents", "agent_hours", "concurrency_time", "consistency", "messages"]).optional().describe("Leaderboard category (default: tokens)"),
    limit: z.number().int().min(1).max(100).optional().describe("Number of entries to show (default: 20)"),
  },
  async ({ category, limit }) => {
    try {
      const text = await renderLeaderboard(category || "weighted", limit || 20);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Leaderboard\n\nUnable to fetch leaderboard. Check your connection.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_badges",
  "Show your earned Claude Rank badges and achievements",
  {},
  async () => {
    try {
      const text = await renderBadges();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Badges\n\nUnable to fetch badges. Check your connection.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_history",
  "Show your Claude usage history and daily trends",
  {
    days: z.number().int().min(1).max(90).optional().describe("Number of days of history (default: 7)"),
  },
  async ({ days }) => {
    try {
      const text = await renderHistory(days || 7);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Usage History\n\nUnable to fetch history. Make sure you've synced at least once.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_profile",
  "Show today's Claude Rank profile card with activity timeline and concurrency stats",
  {},
  async () => {
    try {
      await silentSync();
      const text = await renderProfile();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Claude Rank Profile\n\nUnable to fetch profile. Make sure you've synced at least once.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "sync",
  "Sync your Claude Code usage data to clauderank.com",
  {},
  async () => {
    try {
      const config = loadOrCreateIdentity();
      const stats = loadStats();
      const response = await buildAndSync(config, stats);

      if (response) {
        return { content: [{ type: "text", text: `Synced successfully. Level ${response.level ?? "?"}, ${response.total_points ?? "?"} points, ${response.current_streak ?? 0} day streak.` }] };
      }
      return { content: [{ type: "text", text: "Sync completed." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Sync failed: ${err.message}` }] };
    }
  }
);

// ── Start server ──

const transport = new StdioServerTransport();
await server.connect(transport);
