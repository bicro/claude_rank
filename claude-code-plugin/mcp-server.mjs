#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Import render functions from fetch scripts
import { renderLeaderboard } from "./scripts/fetch-leaderboard.mjs";
import { renderBadges } from "./scripts/fetch-badges.mjs";
import { renderHistory } from "./scripts/fetch-history.mjs";
import { renderProfile } from "./scripts/fetch-profile.mjs";
import { renderTeam } from "./scripts/fetch-team.mjs";

// Import sync utilities
import { loadOrCreateIdentity, getLookupHash, saveIdentity } from "./scripts/lib/identity.mjs";
import { loadStats } from "./scripts/lib/log-parser.mjs";
import { buildAndSync } from "./scripts/sync.mjs";
import { fetchUserProfile } from "./scripts/lib/api.mjs";

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
  "get_team",
  "Show your team dashboard with member burn breakdown",
  {},
  async () => {
    try {
      await silentSync();
      const text = await renderTeam();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Team\n\nUnable to fetch team data.\n\nError: ${err.message}` }] };
    }
  }
);

server.tool(
  "authenticate",
  "Connect your social account (Google, GitHub, Discord, etc.) to your Claude Rank profile",
  {},
  async () => {
    try {
      const config = loadOrCreateIdentity();
      const hash = getLookupHash(config);
      const BASE_URL = process.env.RANKING_API_BASE || "https://clauderank.com";

      // Check if already authenticated
      try {
        const profile = await fetchUserProfile(hash);
        if (profile.auth_provider) {
          // Update local identity with latest info
          if (profile.display_name && profile.display_name !== config.display_name) {
            config.display_name = profile.display_name;
            saveIdentity(config);
          }
          const provider = profile.auth_provider.charAt(0).toUpperCase() + profile.auth_provider.slice(1);
          return { content: [{ type: "text", text: `## Claude Rank — Connected\n\nYour account is already connected via **${provider}**${profile.display_name ? ` as **${profile.display_name}**` : ""}.\n\nProfile: ${BASE_URL}/profile.html?username=${encodeURIComponent(profile.username || hash)}` }] };
        }
      } catch {
        // Profile fetch failed — continue with auth URL
      }

      const authUrl = `${BASE_URL}/auth-connect.html?user_hash=${encodeURIComponent(config.user_hash)}&source=plugin`;
      return { content: [{ type: "text", text: `## Claude Rank — Connect Your Account\n\nTo link a social account to your Claude Rank profile, open this URL in your browser:\n\n${authUrl}\n\nAfter signing in, run \`/claude-rank:profile\` to see your connected account.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `## Authentication\n\nUnable to generate auth link.\n\nError: ${err.message}` }] };
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
