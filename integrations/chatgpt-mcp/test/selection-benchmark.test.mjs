import assert from "node:assert/strict";
import test from "node:test";

import { benchmarkExamSelection, selectionLatencySummary } from "../db/selection-benchmark.mjs";

test("selection latency p50/p95 use nearest rank without logging exam content", async () => {
  const inputs = [{ requestId: "a" }, { requestId: "b" }, { requestId: "c" },
    { requestId: "d" }, { requestId: "e" }];
  const times = [0, 3, 3, 12, 12, 17, 17, 19, 19, 20];
  let index = 0;
  const result = await benchmarkExamSelection({}, inputs, {
    select: async () => [{ prompt_text: "private" }], clock: () => times[index++],
  });
  assert.deepEqual(result, { count: 5, p50Ms: 3, p95Ms: 9, maxMs: 9 });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(selectionLatencySummary([1, 2, 3, 4, 5]),
    { count: 5, p50Ms: 3, p95Ms: 5, maxMs: 5 });
});

test("invalid latency samples fail closed", () => {
  assert.throws(() => selectionLatencySummary([]), /samples required/);
  assert.throws(() => selectionLatencySummary([1, Number.NaN]), /samples required/);
});
