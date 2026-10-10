/**
 * GET /api/laya/health
 *
 * Health check for the Laya decision model. Returns 200 once the model is
 * loaded and responsive, or 503 while it's still downloading / warming up.
 */
import { getLayaInstance } from "@/lib/laya";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const laya = await getLayaInstance();
    // Quick no-op forward pass to confirm the session is live
    await laya.systemOne(
      { healthcheck: "ping" },
      { ok: { type: "noul", instructions: "Is this a health check?" } }
    );
    return Response.json({ status: "ok", warm: true });
  } catch (err) {
    console.error("[/api/laya/health]", err);
    return Response.json(
      { status: "degraded", warm: false, detail: err?.message ?? String(err) },
      { status: 503 }
    );
  }
}
