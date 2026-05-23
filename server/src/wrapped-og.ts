import { Resvg } from "@resvg/resvg-js";
import type { WrappedSummary } from "./wrapped";

const CARD_W = 1200;
const CARD_H = 630;

// Palette — light/cream + orange accent to match the cinematic wrapped page
const BG = "#ffffff";
const FG = "#111111";
const MUTED = "#8a8480";
const RULE = "#e0ddd9";
const ACCENT = "#E8692D";
const HEAT_EMPTY = "#f0ece4";

const cache = new Map<string, { png: Uint8Array; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const CACHE_MAX = 256;

function cacheKey(userHash: string, ym: string): string {
  return `${userHash}:${ym}`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  if (n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 10) return "$" + Math.round(n);
  return "$" + n.toFixed(2);
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHour(h: number): string {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

function buildSvg(summary: WrappedSummary): string {
  const { user, month, totals, busiest_day, power_hour, concurrency_flex, rank, heatmap_24x7 } = summary;

  const displayName = user.display_name || user.username || "anonymous";
  const monthLabel = month.label.toUpperCase();

  // ─── Header ─────────────────────────────────────────────────────────────
  const headerY = 80;

  // ─── 3 headline stats ───────────────────────────────────────────────────
  const statsY = 200;
  const statLabels = ["MESSAGES", "TOKENS", "SPEND"];
  const statValues = [
    fmtNum(totals.messages),
    fmtNum(totals.tokens),
    fmtCost(totals.estimated_spend),
  ];

  // ─── Mini heatmap (right side) ──────────────────────────────────────────
  const heatX = 700;
  const heatY = 360;
  const cellW = 16;
  const cellH = 14;
  const gap = 2;
  let maxCell = 0;
  for (const row of heatmap_24x7) for (const v of row) if (v > maxCell) maxCell = v;

  // ─── Footer stats ───────────────────────────────────────────────────────
  const footerY = 540;
  const peakLabel = concurrency_flex
    ? `${concurrency_flex.peak_concurrency} agents at once`
    : "—";
  const powerLabel = power_hour
    ? `${DOW_NAMES[power_hour.dow]} ${fmtHour(power_hour.hour)}`
    : "—";
  const rankLabel = rank
    ? `Top ${rank.percentile <= 1 ? "1" : Math.ceil(rank.percentile)}% · #${rank.position.toLocaleString("en-US")}`
    : "—";

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">`;

  // Background
  svg += `<rect width="${CARD_W}" height="${CARD_H}" fill="${BG}"/>`;
  // Clip the accent stripe to the card outline so its top corners follow the rounded card.
  svg += `<defs><clipPath id="cardClip"><rect x="20" y="20" width="${CARD_W - 40}" height="${CARD_H - 40}" rx="4"/></clipPath></defs>`;
  // Top accent stripe — sits at the top of the rounded card, inside the border.
  svg += `<g clip-path="url(#cardClip)"><rect x="20" y="20" width="${CARD_W - 40}" height="8" fill="${ACCENT}"/></g>`;
  // Subtle border (drawn after so its stroke sits flush against the stripe top edge).
  svg += `<rect x="20" y="20" width="${CARD_W - 40}" height="${CARD_H - 40}" fill="none" stroke="${RULE}" stroke-width="2" rx="4"/>`;

  // Header eyebrow + title
  svg += `<text x="60" y="${headerY}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="22" letter-spacing="4">CLAUDE RANK · WRAPPED</text>`;
  svg += `<text x="60" y="${headerY + 64}" fill="${FG}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="64" font-weight="700">${escapeXml(displayName)}</text>`;
  svg += `<text x="60" y="${headerY + 102}" fill="${ACCENT}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="28" letter-spacing="3">${escapeXml(monthLabel)}</text>`;

  // Rule
  svg += `<line x1="60" y1="${statsY - 10}" x2="${CARD_W - 60}" y2="${statsY - 10}" stroke="${RULE}" stroke-width="1"/>`;

  // 3 headline stats (left half of card, evenly spaced)
  const statColW = 200;
  for (let i = 0; i < 3; i++) {
    const x = 60 + i * statColW;
    svg += `<text x="${x}" y="${statsY + 28}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="18" letter-spacing="2">${statLabels[i]}</text>`;
    svg += `<text x="${x}" y="${statsY + 90}" fill="${FG}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="48" font-weight="700">${escapeXml(statValues[i]!)}</text>`;
  }

  // Activity sub-line: active days + sessions
  svg += `<text x="60" y="${statsY + 140}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20">${totals.active_days} active days · ${totals.sessions} sessions · ${fmtNum(totals.tool_calls)} tool calls</text>`;

  // Busiest day callout
  if (busiest_day) {
    svg += `<text x="60" y="${statsY + 180}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20">Busiest day: ${escapeXml(busiest_day.date)} · ${fmtNum(busiest_day.tokens)} tokens</text>`;
  }

  // Heatmap label
  svg += `<text x="${heatX}" y="${heatY - 18}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="18" letter-spacing="2">WHEN YOU CLAUDE</text>`;

  // Heatmap grid
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      const v = heatmap_24x7[dow]?.[h] ?? 0;
      const intensity = maxCell > 0 ? v / maxCell : 0;
      // Map 0..1 to dark gray → accent orange
      let fill: string;
      if (v === 0) fill = HEAT_EMPTY;
      else {
        // Higher minimum alpha so low-intensity cells stay readable on white.
        const alpha = 0.20 + intensity * 0.80;
        fill = `rgba(232, 105, 45, ${alpha.toFixed(3)})`;
      }
      const x = heatX + h * (cellW + gap);
      const y = heatY + dow * (cellH + gap);
      svg += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${fill}" rx="2"/>`;
    }
  }

  // Footer rule
  svg += `<line x1="60" y1="${footerY - 30}" x2="${CARD_W - 60}" y2="${footerY - 30}" stroke="${RULE}" stroke-width="1"/>`;

  // Footer stats: power hour, peak concurrency, rank
  const footerCols = [
    { label: "POWER HOUR", value: powerLabel },
    { label: "PEAK FLEX", value: peakLabel },
    { label: "GLOBAL RANK", value: rankLabel },
  ];
  for (let i = 0; i < 3; i++) {
    const colX = 60 + i * 360;
    svg += `<text x="${colX}" y="${footerY}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14" letter-spacing="2">${footerCols[i]!.label}</text>`;
    svg += `<text x="${colX}" y="${footerY + 30}" fill="${FG}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="22" font-weight="600">${escapeXml(footerCols[i]!.value)}</text>`;
  }

  // Footer brand
  svg += `<text x="${CARD_W - 60}" y="${CARD_H - 40}" fill="${MUTED}" font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="16" letter-spacing="3" text-anchor="end">CLAUDERANK.COM</text>`;

  svg += `</svg>`;
  return svg;
}

/** Render the SVG card to a PNG buffer. Cached in memory for 1 hour. */
export function renderWrappedPng(summary: WrappedSummary): Uint8Array {
  const key = cacheKey(summary.user.user_hash, summary.month.ym);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.png;

  const svg = buildSvg(summary);
  const resvg = new Resvg(svg, {
    background: BG,
    fitTo: { mode: "width", value: CARD_W },
    // The Linux production image installs fonts-dejavu-core. defaultFontFamily
    // gives Resvg something to resolve `monospace` to when the SVG's
    // platform-specific families (Menlo/Consolas) aren't present.
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "DejaVu Sans Mono",
    },
  });
  const png = resvg.render().asPng();

  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order)
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { png, expiresAt: Date.now() + CACHE_TTL_MS });
  return png;
}

/** Exposed for the website Hero card so server SVG and client SVG match. */
export function renderWrappedSvg(summary: WrappedSummary): string {
  return buildSvg(summary);
}
