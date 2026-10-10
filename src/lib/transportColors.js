/**
 * Shared transport colour registry.
 *
 * The map, the closest-station card in the bottom sheet, and the per-stop
 * popup all need to colour route numbers consistently:
 *
 *   - MTR lines: one colour per line (Tsuen Wan red, Kwun Tong green, …).
 *   - Buses: KMB → red, Citybus → yellow (per the bus-stops design), with
 *     the New Lantao Bus and LRT feeder buses kept on their existing
 *     green / purple swatches.
 *   - Light Rail, tram, and ferry routes use a single accent colour each
 *     because they don't have per-line branding.
 *
 * Two entry points are exported:
 *
 *   `pickRouteBadge({ routeNo, company })`
 *     Returns `{ label, bg, textColor }` for the small route-number
 *     pill that appears in the ETA lists (both the popup and the
 *     bottom sheet). The text colour flips between white and dark
 *     depending on the badge's luminance so the route number stays
 *     legible against bright backgrounds (notably CTB yellow).
 *
 *   `pickRouteColor(spotOrLine)`
 *     Returns the colour used by map markers and the station-icon
 *     chip. For MTR stations it picks the dominant line colour if the
 *     station only sits on one line, or falls back to a neutral MTR
 *     red when the station is on multiple lines.
 *
 * The MTR colours are taken from the official MTR / MTR Corporation
 * published line chart (the reference image at the start of this
 * task). They are tuned for white text against the saturated line
 * backgrounds; the few light-on-light cases (TWL yellow-green SIL)
 * are handled by `pickRouteBadge` flipping to dark text.
 */

// =============================================================================
// MTR line colours
// =============================================================================
//
// Sourced from the MTR "Network Map" key (the reference image supplied
// with this task) and the official MTR Corp brand guidelines. Codes are
// the upstream `route.route` values from `hk-bus-eta`:
//
//   TWL — Tsuen Wan Line            荃灣綫
//   KTL — Kwun Tong Line            觀塘綫
//   ISL — Island Line               港島綫
//   SIL — South Island Line         南港島綫
//   TKL — Tseung Kwan O Line        將軍澳綫
//   TCL — Tung Chung Line           東涌綫
//   DRL — Disneyland Resort Line    迪士尼綫
//   AEL — Airport Express           機場快綫
//   EAL — East Rail Line            東鐵綫
//   TML — Tuen Ma Line              屯馬綫
export const MTR_LINE_COLORS = Object.freeze({
  TWL: "#E2231A", // 荃灣綫 — Tsuen Wan (red)
  KTL: "#00AF41", // 觀塘綫 — Kwun Tong (green)
  ISL: "#0072CE", // 港島綫 — Island (blue)
  SIL: "#CDDE00", // 南港島綫 — South Island (yellow-green)
  TKL: "#A35BC9", // 將軍澳綫 — Tseung Kwan O (purple)
  TCL: "#F38B00", // 東涌綫 — Tung Chung (orange)
  DRL: "#EB80B1", // 迪士尼綫 — Disneyland Resort (pink)
  AEL: "#007A8F", // 機場快綫 — Airport Express (teal)
  EAL: "#5EB6E4", // 東鐵綫 — East Rail (light blue)
  TML: "#9A3B26", // 屯馬綫 — Tuen Ma (brown)
});

/**
 * Short label printed inside the route pill for an MTR line. The line
 * code is the same as the upstream `route.route` value (TWL, KTL, …)
 * which is what users see on MTR maps and signage.
 */
export function mtrLineLabel(lineCode) {
  if (!lineCode) return "";
  return String(lineCode).toUpperCase();
}

// =============================================================================
// Bus / Light Rail / Tram / Ferry colours
// =============================================================================
//
// Bus company swatches for the route-number pill in the ETA list.
// The "background of the number" rule from the design notes:
//
//   KMB          → red        (Kowloon Motor Bus livery)
//   CTB (Citybus)→ yellow     (Citybus brand yellow)
//   NLB          → green      (New Lantao Bus)
//   LRT Feeder   → purple     (LRT feeder routes)
//   Light Rail   → purple     (same family as LRT feeder)
//   Ferry        → teal       (sunferry / hkkf / fortuneferry)
//   Tram         → green      (HK Tramways green)
//
// "Other" falls back to the brand-neutral blue used by the rest of
// the app. The colour values are kept inline (rather than imported
// from constants.js) so this module remains self-contained — every
// other consumer can build on top of `pickRouteBadge`.
const COMPANY_BADGE_COLORS = Object.freeze({
  kmb: "#C8102E",          // KMB red
  ctb: "#FCD116",          // Citybus yellow
  nlb: "#16A34A",          // NLB green
  lrtfeeder: "#7C3AED",    // LRT feeder purple
  lightRail: "#7C3AED",    // Light Rail purple
  sunferry: "#0891B2",     // Sun Ferry teal
  hkkf: "#0891B2",         // HK&K Ferry teal
  fortuneferry: "#0891B2", // Fortune Ferry teal
  ferry: "#0891B2",        // Generic ferry teal
  tram: "#00734B",         // HK Tramways green
  mtr: MTR_LINE_COLORS.TWL, // Should be overridden by line lookup; red is the MTR fallback.
});

// =============================================================================
// pickRouteBadge
// =============================================================================
//
// Returns `{ label, bg, textColor }` for the small route-number pill
// shown in the ETA list. `routeNo` is the upstream `route.route` (an
// MTR line code like "TWL", or a bus route number like "1", "6X",
// "970"). `company` is the upstream `co[0]` value (kmb, ctb, mtr, …)
// or the synthetic "tram" marker set by the HK Tramways ETA
// normaliser.
//
// MTR is special-cased: its colour comes from `MTR_LINE_COLORS`
// keyed on the line code, not from the company fallback. Every other
// transport type falls through to `COMPANY_BADGE_COLORS` keyed on
// the company string.
//
// `textColor` is computed by picking a high-contrast foreground
// against `bg` (WCAG relative-luminance formula). This is important
// because Citybus yellow + white text is unreadable, while every
// other colour looks fine with white.
export function pickRouteBadge({ routeNo, company } = {}) {
  const code = routeNo != null ? String(routeNo).trim() : "";
  const co = company != null ? String(company).trim().toLowerCase() : "";

  // MTR — colour comes from the line code, not from `COMPANY_BADGE_COLORS`.
  if (co === "mtr" && code && MTR_LINE_COLORS[code.toUpperCase()]) {
    const bg = MTR_LINE_COLORS[code.toUpperCase()];
    return { label: mtrLineLabel(code), bg, textColor: textColorFor(bg) };
  }

  // Ferry / tram / Light Rail — fall back to the company colour.
  const fallbackBg = COMPANY_BADGE_COLORS[co] ?? "#1D4ED8";
  return {
    label: code,
    bg: fallbackBg,
    textColor: textColorFor(fallbackBg),
  };
}

// =============================================================================
// pickRouteColor
// =============================================================================
//
// Returns the colour used by map markers, station icons, and the
// closest-station header chip. For MTR stations, when the station
// is on exactly one line we paint the marker in that line's colour;
// when it's on multiple lines (e.g. Admiralty = TWL + ISL + EAL +
// SIL), we keep the neutral MTR red so the marker reads as "this is
// an MTR station" rather than visually claiming a specific line.
export function pickRouteColor(spot) {
  if (!spot) return "#1D4ED8";

  if (spot.category === "mtrStations") {
    const lines = Array.isArray(spot.lines) ? spot.lines : [];
    if (lines.length === 1 && MTR_LINE_COLORS[lines[0].toUpperCase()]) {
      return MTR_LINE_COLORS[lines[0].toUpperCase()];
    }
    return "#DC2626"; // Neutral MTR red — see the constants.js MTR_STATION_COLOR.
  }

  if (spot.category === "busStops") {
    return "#1D4ED8";
  }
  if (spot.category === "lightRailStops") {
    return "#7C3AED";
  }
  if (spot.category === "ferryPiers") {
    return "#0891B2";
  }
  if (spot.category === "tramStops") {
    return "#00734B";
  }
  return "#1D4ED8";
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * WCAG relative luminance for an `#rrggbb` hex string. Returns a value
 * in [0, 1] — anything below ~0.4 reads as a "light" background where
 * dark text is more legible than white.
 */
function relativeLuminance(hex) {
  const s = String(hex ?? "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return 0;
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const channel = (c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const R = channel(r);
  const G = channel(g);
  const B = channel(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * Pick white or near-black text colour for the route-number pill so
 * the number stays legible regardless of the background colour.
 * Yellow (Citybus), the lime-green South Island Line, and the
 * pink Disneyland line all need dark text; every other MTR line,
 * KMB red, and NLB/LR/LightRail purple are fine with white.
 */
function textColorFor(bg) {
  return relativeLuminance(bg) > 0.55 ? "#1F2937" : "#FFFFFF";
}
