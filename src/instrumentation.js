/**
 * Next.js instrumentation hook.
 *
 * Runs once when the server process starts (both `next dev` and `next
 * start`). We use it to pre-load the Laya ONNX session so the first
 * `/api/laya/intent` request doesn't pay the ~10 s cold-start cost
 * (1.7 GB weights from disk + onnxruntime session init + tokenizer
 * init). Without this, the first user keystroke after a server boot
 * would feel frozen.
 *
 * Why a separate `instrumentation.js`:
 *   - `getLayaInstance()` is a heavy import (onnxruntime-node is huge).
 *     We only want it on the Node server, not the edge runtime.
 *   - Laya has a module-level `_initPromise` singleton: every
 *     subsequent call returns the same instance, so the cost is paid
 *     exactly once per worker.
 *
 * Failure handling: any error here is logged but NOT rethrown — the
 * server still boots, and the first request will trigger lazy init via
 * the route handler as a fallback. A noisy warning is better than a
 * crash.
 */
export async function register() {
  // Only warm in the Node.js server runtime. Edge / browser bundles
  // don't have onnxruntime-node.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    // Dynamic import keeps Laya out of any client/edge bundles.
    const { getLayaInstance } = await import("./lib/laya.js");
    const t0 = Date.now();
    await getLayaInstance();
    const elapsed = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[instrumentation] Laya pre-warmed in ${elapsed}ms`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[instrumentation] Laya pre-warm failed (lazy init will retry on first request):",
      err?.message ?? err
    );
  }
}