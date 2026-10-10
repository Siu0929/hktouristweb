/**
 * run-quantize.mjs — ONNX model graph-optimization + profiling CLI
 *
 * Run with:
 *   node scripts/run-quantize.mjs
 *
 * What it does:
 *   1. Loads the source ONNX model (default: public/laya-distilled/laya-fp16.onnx)
 *      with graphOptimizationLevel='all' and dumps the optimized graph.
 *   2. Prints model metadata (inputs, outputs, file size).
 *   3. Benchmarks cold-start and warm-run inference latency.
 *
 * The optimized model is written to the same directory with "-opt" appended
 * to the filename (e.g. laya-fp16-opt.onnx). Set LAYA_OPT_MODEL_DIR env
 * to change the output path.
 *
 * Options:
 *   --model <path>       Source ONNX file  (default: public/laya-distilled/laya-fp16.onnx)
 *   --output <path>      Optimized output  (default: <same-dir>/laya-fp16-opt.onnx)
 *   --compare             Also benchmark the source model for speedup ratio
 *   --benchmark <n>      Number of timed runs (default: 20)
 *   --warmup <n>         Number of warmup runs (default: 5)
 *   --threads <n>        Intra-op threads  (default: 1)
 *   --interop-threads <n> Inter-op threads  (default: 1)
 *
 * Environment variables:
 *   LAYA_OPT_MODEL_DIR    Overrides the output directory for the optimized model.
 *   LAYA_MODEL_DIR       Source model directory (default: public/laya-distilled/).
 */

import { InferenceSession, Tensor } from "onnxruntime-node";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────

const DTYPE_LABELS = {
  [Tensor.Type.float32]: "float32",
  [Tensor.Type.float16]: "float16",
  [Tensor.Type.int64]: "int64",
  [Tensor.Type.int32]: "int32",
  [Tensor.Type.int8]: "int8",
  [Tensor.Type.uint8]: "uint8",
  [Tensor.Type.bool]: "bool",
  [Tensor.Type.string]: "string",
};

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function divider(label) {
  const line = "─".repeat(58);
  console.log(`\n${line}`);
  if (label) console.log(`  ${label}`);
  if (label) console.log(line);
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
let pos = 0;
while (pos < args.length) {
  const arg = args[pos];
  if (arg === "--model" || arg === "-m") flags.model = args[++pos];
  else if (arg === "--output" || arg === "-o") flags.output = args[++pos];
  else if (arg === "--compare" || arg === "-c") flags.compare = true;
  else if (arg === "--benchmark" || arg === "-b") flags.benchmark = parseInt(args[++pos], 10);
  else if (arg === "--warmup" || arg === "-w") flags.warmup = parseInt(args[++pos], 10);
  else if (arg === "--threads" || arg === "-t") flags.threads = parseInt(args[++pos], 10);
  else if (arg === "--interop-threads") flags.interopThreads = parseInt(args[++pos], 10);
  else if (arg === "--help" || arg === "-h") {
    console.log(`
ONNX Graph Optimization + Profiling CLI

Usage: node scripts/run-quantize.mjs [options]

Options:
  --model <path>           Source ONNX file
  --output <path>          Output path for optimized model
  --compare                Also benchmark the source model for speedup ratio
  --benchmark <n>          Number of timed runs (default: 20)
  --warmup <n>             Number of warmup runs (default: 5)
  --threads <n>            Intra-op threads (default: 1)
  --interop-threads <n>    Inter-op threads (default: 1)
  --help                   Show this message

Environment:
  LAYA_MODEL_DIR           Source model directory
  LAYA_OPT_MODEL_DIR       Output directory for optimized model

Default model: <LAYA_MODEL_DIR or public/laya-distilled>/laya-fp16.onnx
Default output: <LAYA_OPT_MODEL_DIR or same-dir>/laya-fp16-opt.onnx
`);
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
  pos++;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const modelDir = process.env.LAYA_MODEL_DIR
  ?? path.join(process.cwd(), "public", "laya-distilled");
const srcName = "laya-fp16.onnx";
const srcModel = flags.model ?? path.join(modelDir, srcName);
const optDir = process.env.LAYA_OPT_MODEL_DIR ?? modelDir;
const defaultOutput = path.join(optDir, "laya-fp16-opt.onnx");
const outputPath = flags.output ?? defaultOutput;
const benchmarkRuns = flags.benchmark ?? 20;
const warmupRuns = flags.warmup ?? 5;
const threads = flags.threads ?? 1;
const interopThreads = flags.interopThreads ?? 1;

// ─── Verify source file exists ───────────────────────────────────────────────

try {
  await fs.access(srcModel);
} catch {
  console.error(`\n❌ Source model not found: ${srcModel}`);
  console.error(`   Set LAYA_MODEL_DIR env var or use --model <path>`);
  process.exit(1);
}

// ─── Metadata loader ──────────────────────────────────────────────────────────

async function loadMetadata(modelPath) {
  const session = await InferenceSession.create(modelPath, {
    graphOptimizationLevel: "disabled",
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const stat = await fs.stat(modelPath);
  return {
    session,
    inputMetadata: session.inputMetadata.map((m) => ({
      name: m.name,
      shape: [...m.shape],
      dtype: DTYPE_LABELS[m.type] ?? `dtype(${m.type})`,
    })),
    outputMetadata: session.outputMetadata.map((m) => ({
      name: m.name,
      shape: [...m.shape],
      dtype: DTYPE_LABELS[m.type] ?? `dtype(${m.type})`,
    })),
    fileSize: stat.size,
    fileSizeHuman: formatBytes(stat.size),
  };
}

function buildFeeds(meta) {
  const feeds = {};
  for (const input of meta.inputMetadata) {
    const numElements = input.shape.reduce((a, b) => a * (b > 0 ? b : 1), 1);
    let dtype = input.dtype;
    let TypedArray;
    if (dtype === "float16") {
      TypedArray = Uint16Array;
      dtype = "float16";
    } else if (dtype === "float32") {
      TypedArray = Float32Array;
      dtype = "float32";
    } else if (dtype === "int64") {
      TypedArray = BigInt64Array;
      dtype = "int64";
    } else if (dtype === "int32") {
      TypedArray = Int32Array;
      dtype = "int32";
    } else {
      TypedArray = Float32Array; // fallback
      dtype = "float32";
    }
    const arr = new TypedArray(numElements);
    feeds[input.name] = new Tensor(
      dtype,
      arr,
      input.shape.map((d) => (d > 0 ? d : 1))
    );
  }
  return feeds;
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

async function benchmark(modelPath, label, meta, warmup, runs) {
  divider(label);
  console.log(`  Model: ${modelPath}`);

  // Cold start.
  console.log(`\n  🔄 Cold start (first load + first inference)…`);
  const coldT0 = Date.now();
  const coldSession = await InferenceSession.create(modelPath, {
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: interopThreads,
  });
  const feeds = buildFeeds(meta);
  await coldSession.run(feeds);
  const coldMs = Date.now() - coldT0;
  console.log(`     Cold start: ${formatMs(coldMs)}`);
  await coldSession.release();

  // Warm runs.
  console.log(`\n  🔥 Warm runs (${warmup} warmup + ${runs} timed)…`);
  const warmSession = await InferenceSession.create(modelPath, {
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: interopThreads,
  });
  for (let i = 0; i < warmup; i++) await warmSession.run(feeds);

  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = Date.now();
    await warmSession.run(feeds);
    times.push(Date.now() - t);
  }

  const med = median(times);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`     Median: ${formatMs(med)}`);
  console.log(`     Mean:   ${formatMs(mean)}`);
  console.log(`     Min:    ${formatMs(Math.min(...times))}`);
  console.log(`     Max:    ${formatMs(Math.max(...times))}`);

  await warmSession.release();

  return { coldMs, medianMs: med, meanMs: mean, allRuns: times };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════╗
║   ONNX Graph Optimization + Profiling (JavaScript)        ║
╚══════════════════════════════════════════════════════════╝
`);

console.log(`Source model:   ${srcModel}`);
console.log(`Output path:    ${outputPath}`);
console.log(`Benchmark runs: ${benchmarkRuns} timed / ${warmupRuns} warmup`);
console.log(`Threads:        intra=${threads} interop=${interopThreads}`);

// Load metadata.
divider("Model metadata");
const meta = await loadMetadata(srcModel);
console.log(`  File size:   ${meta.fileSizeHuman}`);
console.log(`  Inputs:`);
for (const i of meta.inputMetadata) {
  console.log(`    ${i.name}  dtype=${i.dtype}  shape=[${i.shape.join(",")}]`);
}
console.log(`  Outputs:`);
for (const o of meta.outputMetadata) {
  console.log(`    ${o.name}  dtype=${o.dtype}  shape=[${o.shape.join(",")}]`);
}

// Export optimized model.
divider("Graph optimization (graphOptimizationLevel='all')");
console.log(`  Loading source model…`);
const t0 = Date.now();

await fs.mkdir(path.dirname(outputPath), { recursive: true });

const session = await InferenceSession.create(srcModel, {
  graphOptimizationLevel: "all",
  optimizedModelFilePath: outputPath,
  intraOpNumThreads: threads,
  interOpNumThreads: interopThreads,
});

const loadMs = Date.now() - t0;
console.log(`  Session load time: ${formatMs(loadMs)}`);

// Run one inference to ensure ONNX Runtime has processed the graph.
const feeds = buildFeeds(meta);
await session.run(feeds);
await session.release();

const optStat = await fs.stat(outputPath);
const sizeDelta = optStat.size - meta.fileSize;
console.log(`\n  ✅ Optimized model written`);
console.log(`     File: ${outputPath}`);
console.log(`     Original: ${meta.fileSizeHuman}`);
console.log(`     Optimized: ${formatBytes(optStat.size)}`);
console.log(`     Delta: ${sizeDelta >= 0 ? "+" : ""}${(sizeDelta / 1024).toFixed(1)} KB (${((optStat.size / meta.fileSize - 1) * 100).toFixed(1)}%)`);

// Benchmark optimized model.
const optMeta = await loadMetadata(outputPath);
const optBench = await benchmark(outputPath, "Optimized model benchmark", optMeta, warmupRuns, benchmarkRuns);

// Compare with source if requested.
if (flags.compare) {
  const srcBench = await benchmark(srcModel, "Source model benchmark (baseline)", meta, warmupRuns, benchmarkRuns);

  const sizeDiff = optStat.size - meta.fileSize;
  const speedup = srcBench.medianMs / optBench.medianMs;

  divider("Comparison summary");
  console.log(`  File size:   ${meta.fileSizeHuman} → ${formatBytes(optStat.size)}  (${sizeDiff >= 0 ? "+" : ""}${(sizeDiff / 1024).toFixed(1)} KB)`);
  console.log(`  Cold start:  ${formatMs(srcBench.coldMs)} → ${formatMs(optBench.coldMs)}`);
  console.log(`  Warm median: ${formatMs(srcBench.medianMs)} → ${formatMs(optBench.medianMs)}`);
  console.log(`  Speedup:     ${speedup.toFixed(2)}x${speedup > 1.0 ? " ✅ faster" : speedup < 1.0 ? " ⚠️ slower" : "  (same)"}`);
} else {
  console.log(`\n  ℹ️  Run with --compare to also benchmark the source model and show speedup ratio.`);
}

console.log(`\n✅ Done. Optimized model: ${outputPath}\n`);
