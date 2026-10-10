// Per-user "frequent places" persisted in localStorage. Each entry mirrors a
// tourist spot ({ id, name, category, lat, lng, ... }) augmented with usage
// metadata so the home page can rank them by how often the user picks them.
//
// Stored shape per entry:
//   {
//     ...spot fields (id, name, category, lat, lng, kind, address, ...),
//     clickCount: number,        // total clicks recorded on this spot
//     lastClickedAt: number,     // Date.now() of the most recent click
//     addedAt: number,           // Date.now() when first added
//   }
//
// Ordering rule: list is sorted by (clickCount desc, lastClickedAt desc) so
// the most-used places sit at the top, with recent ties breaking toward more
// recent use. Storage is bounded to MAX_FREQUENT_PLACES entries — once we
// hit the cap, the lowest-ranked entry is dropped to make room.

const STORAGE_KEY = "hktourist:frequent-places:v2";

export const MAX_FREQUENT_PLACES = 12;

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function hasViewport(spot) {
  return (
    spot &&
    typeof spot.id === "string" &&
    typeof spot.name === "string" &&
    typeof spot.category === "string" &&
    Number.isFinite(spot.lat) &&
    Number.isFinite(spot.lng)
  );
}

// Normalise a stored entry: ensure the usage fields exist with sane values
// so older payloads (or ad-hoc test data) render sanely even if they lack
// clickCount / lastClickedAt. We keep them in-place on the spot object so
// the rest of the app can read place.clickCount directly.
function normaliseEntry(spot) {
  const clickCount =
    Number.isFinite(spot.clickCount) && spot.clickCount >= 0
      ? Math.floor(spot.clickCount)
      : 0;
  const lastClickedAt =
    Number.isFinite(spot.lastClickedAt) && spot.lastClickedAt >= 0
      ? Math.floor(spot.lastClickedAt)
      : Number.isFinite(spot.addedAt) && spot.addedAt >= 0
        ? Math.floor(spot.addedAt)
        : 0;
  const addedAt =
    Number.isFinite(spot.addedAt) && spot.addedAt >= 0
      ? Math.floor(spot.addedAt)
      : lastClickedAt || Date.now();
  return {
    ...spot,
    clickCount,
    lastClickedAt,
    addedAt,
  };
}

// Rank comparator: highest click-count first; ties broken by most-recent
// click; final fallback is insertion order (already in lastClickedAt).
function rankEntry(spot) {
  return [
    Number.isFinite(spot.clickCount) ? spot.clickCount : 0,
    Number.isFinite(spot.lastClickedAt) ? spot.lastClickedAt : 0,
  ];
}

function compareRank(a, b) {
  const ra = rankEntry(a);
  const rb = rankEntry(b);
  if (ra[0] !== rb[0]) return rb[0] - ra[0];
  if (ra[1] !== rb[1]) return rb[1] - ra[1];
  return 0;
}

export function readFrequentPlaces() {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // One-shot migration from the v1 schema (no clickCount) so existing
      // users don't lose their saved places when this upgrade rolls out.
      const legacyRaw = window.localStorage.getItem(
        "hktourist:frequent-places:v1"
      );
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        if (Array.isArray(legacy)) {
          const migrated = legacy
            .filter(hasViewport)
            .map((s) => ({
              ...s,
              clickCount: 0,
              lastClickedAt: 0,
              addedAt: Date.now(),
            }));
          writeFrequentPlaces(migrated);
          return migrated;
        }
      }
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(hasViewport).map(normaliseEntry).sort(compareRank);
  } catch {
    return [];
  }
}

export function writeFrequentPlaces(places) {
  if (!isBrowser()) return;
  try {
    const sanitized = [...places]
      .filter(hasViewport)
      .map(normaliseEntry)
      .sort(compareRank)
      .slice(0, MAX_FREQUENT_PLACES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Storage may be full or disabled — fail silently so the UI keeps working.
  }
}

// Record a click on `spot`. If it already exists we bump its clickCount
// and lastClickedAt and re-rank; otherwise we add it as a new entry with
// clickCount = 1. Returns the updated list. The cap is enforced after
// sorting so the worst-ranked entry gets dropped, not whichever one ran
// out of space.
export function addFrequentPlace(spot) {
  if (!hasViewport(spot)) return readFrequentPlaces();
  const now = Date.now();
  const current = readFrequentPlaces();
  const existingIdx = current.findIndex((p) => p.id === spot.id);
  let next;
  if (existingIdx >= 0) {
    next = current.map((p, idx) =>
      idx === existingIdx
        ? normaliseEntry({
            ...p,
            ...spot,
            clickCount: (p.clickCount ?? 0) + 1,
            lastClickedAt: now,
          })
        : p
    );
  } else {
    next = [
      normaliseEntry({
        ...spot,
        clickCount: 1,
        lastClickedAt: now,
        addedAt: now,
      }),
      ...current,
    ];
  }
  writeFrequentPlaces(next);
  return readFrequentPlaces();
}

export function removeFrequentPlace(id) {
  const next = readFrequentPlaces().filter((p) => p.id !== id);
  writeFrequentPlaces(next);
  return next;
}

export function clearFrequentPlaces() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    // Also clear the legacy v1 key so a future downgrade doesn't surface
    // stale entries.
    window.localStorage.removeItem("hktourist:frequent-places:v1");
  } catch {
    // ignore
  }
}

export function isFrequentPlace(id) {
  return readFrequentPlaces().some((p) => p.id === id);
}
