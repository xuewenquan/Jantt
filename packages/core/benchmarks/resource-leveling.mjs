// Run after `npm run build --workspace=@jantt/core`:
// node packages/core/benchmarks/resource-leveling.mjs [tasks:conflicting-pairs[:calendar|crowded] ...]
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { levelResources } from "../dist/index.js";

const scenarios = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["100:0", "100:5", "100:25", "500:0", "500:5", "1000:0", "1000:5", "1000:50",
    "100:5:calendar", "500:5:calendar", "1000:50:calendar", "25:0:crowded", "50:0:crowded", "100:0:crowded"];
const repetitions = 3;

function makeTasks(count, pairs, mode) {
  assert(Number.isInteger(count) && count > 0 && Number.isInteger(pairs) && pairs >= 0 && pairs * 2 <= count);
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i}`,
    start: "2026-11-02",
    end: "2026-11-02",
    assignee: mode === "crowded" ? "shared" : i < pairs * 2 ? `shared-${Math.floor(i / 2)}` : `person-${i}`
  }));
}

// Warm up the same algorithm before measuring. Inputs are freshly generated
// for every run so mutations or a previous run cannot affect the result.
levelResources(makeTasks(20, 2), { defaultGapDays: 0 });
console.log(`Node ${process.version}; ${repetitions} measured runs; no dependencies`);
console.log("tasks,pairs,mode,initial_conflicts,remaining_conflicts,adjustments,median_ms,min_ms,max_ms");
for (const scenario of scenarios) {
  const [countText, pairsText, mode = "plain"] = scenario.split(":");
  const count = Number(countText), pairs = Number(pairsText);
  assert(["plain", "calendar", "crowded"].includes(mode));
  assert(mode !== "crowded" || pairs === 0);
  const options = mode === "calendar"
    ? { defaultGapDays: 0, calendar: { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-11-03"] } }
    : { defaultGapDays: 0 };
  const times = [];
  let result;
  for (let i = 0; i < repetitions; i++) {
    const tasks = makeTasks(count, pairs, mode);
    const start = performance.now();
    result = levelResources(tasks, options);
    times.push(performance.now() - start);
    assert.equal(result.initialOverallocations.length, mode === "crowded" ? 1 : pairs);
    assert.equal(result.remainingOverallocations.length, 0);
    assert.equal(result.adjustments.length, mode === "crowded" ? count - 1 : pairs);
    assert.equal(result.unresolvedReasons?.length ?? 0, 0);
  }
  times.sort((a, b) => a - b);
  console.log([count, pairs, mode, result.initialOverallocations.length, result.remainingOverallocations.length,
    result.adjustments.length, times[1].toFixed(1), times[0].toFixed(1), times[2].toFixed(1)].join(","));
}
