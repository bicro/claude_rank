import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

/**
 * Auto-detect the user's Claude subscription plan from ~/.claude.json.
 * Claude Code stores an `oauthAccount` object there in plain JSON; the rate-limit tier
 * (e.g. "default_claude_max_20x") and organization type distinguish Pro / Max 5x / Max 20x.
 * The server maps these raw strings to a monthly USD price.
 *
 * Returns { organization_type, rate_limit_tier, billing_type } or null (e.g. API-key users
 * with no oauthAccount, or any read/parse failure — sync must never throw).
 */
export function detectPlan() {
  try {
    const raw = readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
    const oa = JSON.parse(raw)?.oauthAccount;
    if (!oa) return null;
    return {
      organization_type: oa.organizationType ?? null,
      rate_limit_tier: oa.organizationRateLimitTier ?? oa.userRateLimitTier ?? null,
      billing_type: oa.billingType ?? null,
    };
  } catch {
    return null;
  }
}
