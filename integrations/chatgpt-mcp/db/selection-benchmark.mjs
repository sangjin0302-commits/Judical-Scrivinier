import { performance } from "node:perf_hooks";

import { selectExamCandidates } from "./fast-exam-selection.mjs";

export function selectionLatencySummary(samples) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("nonempty finite latency samples required");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const nearestRank = (q) => sorted[Math.ceil(q * sorted.length) - 1];
  return { count: sorted.length, p50Ms: nearestRank(0.5), p95Ms: nearestRank(0.95), maxMs: sorted.at(-1) };
}

/** Measures DB selection time only. Pass an already-connected client; never logs inputs or rows. */
export async function benchmarkExamSelection(client, inputs, { clock = () => performance.now(),
  select = selectExamCandidates } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("benchmark inputs required");
  const samples = [];
  for (const input of inputs) {
    const start = clock();
    await select(client, input);
    samples.push(clock() - start);
  }
  return selectionLatencySummary(samples);
}
