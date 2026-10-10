/**
 * POST /api/laya
 *
 * Thin Next.js wrapper around the Laya decision model.
 * Accepts any state + questions shape that Laya's systemOne() accepts.
 *
 * Request body (JSON):
 *   state      {object}  - context object (ticket, query, POI record …)
 *   questions  {object}  - map of question-key → question definition
 *   options    {object}  - optional Laya.load() overrides (modelDir, repo …)
 *
 * Response:
 *   { answers: { ... }, usage: { ... } }
 *
 * Errors:
 *   400  missing state or questions
 *   500  model load failure or inference error
 *
 * Env vars (also settable per-request in options):
 *   LAYA_MODEL_DIR   use a local ONNX bundle instead of downloading
 *   LAYA_REPO        HuggingFace repo (default: "receptron/laya-onnx")
 *   LAYA_SUBFOLDER  checkpoint subfolder (default: "multilingual")
 *   LAYA_REVISION    commit hash or "main"
 *   LAYA_CACHE       override cache directory
 *   HF_TOKEN         HuggingFace token for private repos
 */

import { getLayaInstance } from "@/lib/laya";

export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { state, questions, options } = body;

  if (!state || typeof state !== "object") {
    return Response.json({ error: '"state" (object) is required' }, { status: 400 });
  }
  if (!questions || typeof questions !== "object") {
    return Response.json({ error: '"questions" (object) is required' }, { status: 400 });
  }

  try {
    const laya = await getLayaInstance(options);
    const result = await laya.systemOne(state, questions);
    return Response.json(result);
  } catch (err) {
    console.error("[/api/laya]", err);
    return Response.json(
      { error: "Laya inference failed", detail: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}

/**
 * GET /api/laya
 *
 * Returns the model load status without forcing a forward pass — useful as a
 * cheap liveness probe. Use GET /api/laya/health for a deep check that runs
 * a no-op inference.
 */
export async function GET() {
  try {
    await getLayaInstance();
    return Response.json({ status: "ok" });
  } catch (err) {
    console.error("[/api/laya GET]", err);
    return Response.json(
      { status: "degraded", detail: err?.message ?? String(err) },
      { status: 503 }
    );
  }
}
