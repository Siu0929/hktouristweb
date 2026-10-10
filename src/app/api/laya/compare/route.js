/**
 * POST /api/laya/compare
 *
 * Server-side bridge for the `<TierCompare>` debug panel in
 * `LayaSuggestions.jsx`. Calls `runAllTiersForQuery()` from
 * `src/lib/laya.js` and returns the per-tier timing + verdict
 * report.
 *
 * This is a read-only diagnostic endpoint: it does NOT mutate the
 * LRU cache beyond the priming pass that `runAllTiersForQuery`
 * performs internally. The prime is required so the `cache` tier
 * returns a meaningful hit number (otherwise the cache would be
 * cold and report 0 ms / miss on every request).
 *
 * Request body (JSON):
 *   query   {string}  - raw user query
 *   locale  {string?} - locale to pass to Laya, default "zh-Hant"
 *
 * Response (200): see `runAllTiersForQuery` in src/lib/laya.js.
 *
 * Response (500) on Laya failure: the partial report is still
 * returned under `tiers.laya.error` so the UI can show "🔴 Laya
 * error: …" instead of crashing the whole panel.
 */

import { runAllTiersForQuery } from "@/lib/laya";

export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { query, locale = "zh-Hant" } = body ?? {};
  if (typeof query !== "string" || !query.trim()) {
    return Response.json(
      { error: '"query" (non-empty string) is required' },
      { status: 400 }
    );
  }

  const t0 = Date.now();
  try {
    const report = await runAllTiersForQuery(query, { locale });
    return Response.json({
      ...report,
      wallClockMs: Date.now() - t0,
    });
  } catch (err) {
    // runAllTiersForQuery can throw if the query is empty (we
    // already guarded above) or if a primitive import fails at
    // module load. Laya errors are caught inside the function and
    // surfaced via tiers.laya.error instead.
    return Response.json(
      {
        error: err?.message ?? String(err),
        wallClockMs: Date.now() - t0,
      },
      { status: 500 }
    );
  }
}
