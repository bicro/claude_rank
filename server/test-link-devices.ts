/**
 * Helper script to link two test devices and verify aggregation.
 * Usage: bun run --env-file=../.env.local server/test-link-devices.ts <device_a_hash> <device_b_hash>
 */
import { getDb, initDb } from "./src/db";
import { recomputeUserMetrics } from "./src/aggregate";

const [deviceA, deviceB] = process.argv.slice(2);
if (!deviceA || !deviceB) {
  console.error("Usage: bun run test-link-devices.ts <primary_hash> <secondary_hash>");
  process.exit(1);
}

await initDb();
const db = getDb();
const now = new Date().toISOString();

// Link device B as secondary of device A
await db.query("UPDATE users SET linked_to = ?, updated_at = ? WHERE user_hash = ?")
  .run(deviceA, now, deviceB);

console.log(`Linked ${deviceB} -> ${deviceA}`);

// Recompute aggregate
await recomputeUserMetrics(deviceA);

// Read the aggregated metrics
const metrics = await db.query("SELECT * FROM user_metrics WHERE user_hash = ?").get(deviceA) as any;
console.log("Aggregated user_metrics:", JSON.stringify({
  total_tokens: metrics?.total_tokens,
  total_messages: metrics?.total_messages,
  total_sessions: metrics?.total_sessions,
  total_tool_calls: metrics?.total_tool_calls,
  current_streak: metrics?.current_streak,
  total_points: metrics?.total_points,
}, null, 2));

// Also show individual device_metrics
const dmA = await db.query("SELECT total_tokens, total_messages FROM device_metrics WHERE device_hash = ?").get(deviceA) as any;
const dmB = await db.query("SELECT total_tokens, total_messages FROM device_metrics WHERE device_hash = ?").get(deviceB) as any;
console.log(`Device A (${deviceA}): tokens=${dmA?.total_tokens}, messages=${dmA?.total_messages}`);
console.log(`Device B (${deviceB}): tokens=${dmB?.total_tokens}, messages=${dmB?.total_messages}`);

process.exit(0);
