/**
 * Cross-device concurrency histogram merging via discrete probability convolution.
 *
 * Each device reports a histogram {sessionCount: minutes} per hour.
 * Sessions on different devices are additive — if Device A has 1 session and
 * Device B has 2 sessions during the same time, the combined concurrency is 3.
 */

/**
 * Convolve concurrency histograms from multiple devices for the same hour.
 *
 * Each histogram maps sessionCount → minutes (out of 60 per hour).
 * Returns a combined histogram where session counts from different devices are summed.
 *
 * Algorithm:
 *   1. Convert each histogram to a probability distribution P(k) = minutes_at_k / 60
 *   2. Iteratively convolve distributions (P_combined(k) = Σ P_A(i) × P_B(k-i))
 *   3. Convert back to minutes
 */
export function mergeDeviceHistogramsForHour(
  deviceHistograms: Record<string, number>[],
): Record<string, number> {
  if (deviceHistograms.length === 0) return {};
  if (deviceHistograms.length === 1) return { ...deviceHistograms[0]! };

  // Convert each device histogram to a probability distribution
  const distributions: number[][] = [];
  for (const histogram of deviceHistograms) {
    let totalMinutes = 0;
    let maxSessions = 0;
    for (const [sessionsStr, minutes] of Object.entries(histogram)) {
      const k = parseInt(sessionsStr, 10);
      totalMinutes += minutes;
      if (k > maxSessions) maxSessions = k;
    }

    const dist = new Array(maxSessions + 1).fill(0);
    dist[0] = Math.max(0, 60 - totalMinutes) / 60;
    for (const [sessionsStr, minutes] of Object.entries(histogram)) {
      const k = parseInt(sessionsStr, 10);
      dist[k] = minutes / 60;
    }
    distributions.push(dist);
  }

  // Iteratively convolve all distributions
  let combined = distributions[0]!;
  for (let i = 1; i < distributions.length; i++) {
    const other = distributions[i]!;
    const newLen = combined.length + other.length - 1;
    const result: number[] = new Array(newLen).fill(0);
    for (let a = 0; a < combined.length; a++) {
      for (let b = 0; b < other.length; b++) {
        result[a + b]! += combined[a]! * other[b]!;
      }
    }
    combined = result;
  }

  // Convert back to histogram (minutes at each session count, excluding k=0)
  const result: Record<string, number> = {};
  for (let k = 1; k < combined.length; k++) {
    const minutes = Math.round(combined[k]! * 60);
    if (minutes > 0) {
      result[String(k)] = minutes;
    }
  }
  return result;
}

/**
 * Normalize a snapshot_hour timestamp to a consistent hourKey format "YYYY-MM-DD:H".
 */
function toHourKey(snapshotHour: string): string {
  const sep = snapshotHour.includes("T") ? "T" : " ";
  const parts = snapshotHour.split(sep);
  const datePart = parts[0]!;
  const hour = parseInt((parts[1] ?? "00:00:00").split(":")[0]!, 10);
  return `${datePart}:${hour}`;
}

/**
 * Merge concurrency histograms across multiple devices for a single user.
 *
 * Takes rows containing user_hash, snapshot_hour, and histogram (JSON string),
 * groups them by (hour, device), then convolves per-device histograms for each hour.
 *
 * Returns { hourKey: combinedHistogram }.
 */
export function mergeAllDeviceHistograms(
  rows: { user_hash: string; snapshot_hour: string; histogram: string }[],
): Record<string, Record<string, number>> {
  // Group by (hourKey, user_hash/device)
  const byHourDevice: Record<string, Record<string, Record<string, number>>> = {};

  for (const row of rows) {
    let histogram: Record<string, number>;
    try {
      histogram = row.histogram ? JSON.parse(row.histogram) : {};
    } catch {
      continue;
    }

    const hourKey = toHourKey(row.snapshot_hour);
    if (!byHourDevice[hourKey]) byHourDevice[hourKey] = {};

    // One histogram per device per hour (last one wins if duplicates)
    byHourDevice[hourKey][row.user_hash] = histogram;
  }

  // For each hour, convolve all device histograms
  const result: Record<string, Record<string, number>> = {};
  for (const [hourKey, deviceHistMap] of Object.entries(byHourDevice)) {
    result[hourKey] = mergeDeviceHistogramsForHour(Object.values(deviceHistMap));
  }
  return result;
}
