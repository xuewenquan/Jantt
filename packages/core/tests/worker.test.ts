import { describe, it, expect } from "vitest";
import { createScheduleWorkerClient } from "../src/worker";
import type { JanttData } from "../src/types";

describe("ScheduleWorkerClient", () => {
  const samplePlan: JanttData = {
    meta: { title: "Async Scheduling Plan" },
    tasks: [
      { id: "t1", label: "Spec", category: "dev", start: "2026-11-01", end: "2026-11-04" },
      { id: "t2", label: "Build", category: "dev", start: "2026-11-02", end: "2026-11-08", dependsOn: "t1" }
    ]
  };

  it("resolves schedule dependencies asynchronously", async () => {
    const client = createScheduleWorkerClient();
    const resolved: any = await client.resolveSchedule(samplePlan, { defaultGapDays: 1 });

    expect(resolved.tasks).toHaveLength(2);
    // t1 ends 2026-11-04, gapDays=1 -> t2 starts 2026-11-05
    expect(resolved.tasks[1].start).toBe("2026-11-05");
    client.terminate();
  });

  it("uses the project calendar in asynchronous scheduling", async () => {
    const client = createScheduleWorkerClient();
    const plan: JanttData = {
      meta: { calendar: "standard", defaultGapDays: 1 },
      tasks: [
        { id: "a", start: "2026-11-04", end: "2026-11-06" },
        { id: "b", start: "2026-11-04", end: "2026-11-05", dependsOn: "a" }
      ]
    };
    const resolved = await client.resolveSchedule(plan) as JanttData;
    expect(resolved.tasks[1].start).toBe("2026-11-09");
    client.terminate();
  });

  it("executes Monte Carlo schedule simulation asynchronously", async () => {
    const client = createScheduleWorkerClient();
    const result = await client.runMonteCarlo(samplePlan, { iterations: 100 });

    expect(result.iterations).toBe(100);
    expect(result.percentiles.P50.durationDays).toBeGreaterThan(0);
    expect(result.taskCriticality.length).toBeGreaterThan(0);
    client.terminate();
  });

  it("executes resource leveling asynchronously", async () => {
    const client = createScheduleWorkerClient();
    const overAllocatedPlan: JanttData = {
      tasks: [
        { id: "a", label: "Task A", category: "dev", start: "2026-11-01", end: "2026-11-05", assignee: "Alice", priority: "urgent" },
        { id: "b", label: "Task B", category: "dev", start: "2026-11-02", end: "2026-11-04", assignee: "Alice", priority: "low" }
      ]
    };

    const result = await client.levelResources(overAllocatedPlan);
    expect(result.tasks).toHaveLength(2);
    expect(result.adjustments.length).toBeGreaterThanOrEqual(1);
    client.terminate();
  });

  it("uses resource capacities from project metadata", async () => {
    const client = createScheduleWorkerClient();
    const plan: JanttData = { meta: { resourceCapacities: { alice: 0.5 } }, tasks: [
      { id: "a", category: "dev", assignee: "alice", allocation: 0.75, start: "2026-11-02", end: "2026-11-02" }
    ] };
    const result = await client.levelResources(plan);
    expect(result.remainingOverallocations[0]).toMatchObject({ resourceId: "alice", capacity: 0.5, totalUnits: 0.75 });
    client.terminate();
  });

  it("uses the project target date for resource leveling float", async () => {
    const client = createScheduleWorkerClient();
    const plan: JanttData = { meta: { targetDate: "2026-11-10", defaultGapDays: 1 }, tasks: [
      { id: "a", assignee: "alice", start: "2026-11-02", end: "2026-11-02", locked: true },
      { id: "b", assignee: "alice", start: "2026-11-02", end: "2026-11-02" }
    ] };
    const result = await client.levelResources(plan);
    expect(result.adjustments[0].withinFloat).toBe(true);
    client.terminate();
  });

  it("handles termination cleanly", () => {
    const client = createScheduleWorkerClient();
    expect(typeof client.isWorkerActive()).toBe("boolean");
    expect(() => client.terminate()).not.toThrow();
  });
});
