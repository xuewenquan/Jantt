import { describe, it, expect } from "vitest";
import {
  SchedulePipeline,
  SanitizeStage,
  CycleGuardStage,
  CascadeResolveStage,
  CriticalPathStage
} from "../src/pipeline";
import { Task } from "../src/types";
import { TaskScheduleCoordinator } from "../src/rendering/task-schedule-coordinator";

describe("SchedulePipeline Assembly Line", () => {
  it("reports an unknown calendar and stops without cascading dates", () => {
    const tasks: Task[] = [
      { id: "a", start: "2026-11-02", end: "2026-11-03", calendarId: "missing" },
      { id: "b", start: "2026-11-02", end: "2026-11-03", dependsOn: "a" }
    ];
    const result = SchedulePipeline.createDefault({ includeCriticalPath: true }).execute(tasks);
    expect(result.diagnostics.join(" ")).toMatch(/unknown calendar.*missing/i);
    expect(result.tasks.map((task) => task.start)).toEqual(["2026-11-02", "2026-11-02"]);
    expect(result.context.options?.cpmResult).toBeUndefined();
    expect(result.context.fatalError).toMatch(/unknown calendar.*missing/i);
    expect(() => TaskScheduleCoordinator.updateTask({ tasks }, { ...tasks[1], label: "changed" })).toThrow(/unknown calendar.*missing/i);
  });

  it("passes the project target date into the pipeline critical path", () => {
    const tasks: Task[] = [{ id: "a", start: "2026-09-01", end: "2026-09-03" }];
    const result = SchedulePipeline.createDefault({ includeCriticalPath: true }).execute(tasks, { targetDate: "2026-08-30" });
    expect(result.context.options?.cpmResult.projectTotalFloat).toBeLessThan(0);
  });

  it("does not flag a locked task on a non-working day as a dependency violation", () => {
    const tasks: Task[] = [{ id: "a", start: "2026-11-07", end: "2026-11-07", locked: true }];
    const result = SchedulePipeline.createDefault().execute(tasks, { calendar: "standard" });
    expect(result.diagnostics.join(" ")).not.toMatch(/violates a dependency constraint/i);
  });
  it("preserves relationship type and lag when removing a dangling dependency", () => {
    const tasks: Task[] = [
      { id: "a", start: "2026-01-01", end: "2026-01-05" },
      { id: "b", start: "2026-01-01", end: "2026-01-02", dependsOn: [{ id: "a", type: "SS", lag: 1 }, "missing:FS+3d"] }
    ];
    const result = SchedulePipeline.createDefault().execute(tasks, { defaultGapDays: 2 });
    expect(result.tasks[1].dependsOn).toEqual({ id: "a", type: "SS", lag: 1 });
    expect(result.tasks[1].start).toBe("2026-01-02");
  });
  it("SanitizeStage corrects inverted dates and removes self/dangling dependencies", () => {
    const stage = new SanitizeStage();
    const tasks: Task[] = [
      {
        id: "t1",
        label: "Task 1",
        start: "2026-03-10",
        end: "2026-03-05", // Inverted date!
        dependsOn: "t1",   // Self dependency!
        progress: 0,
        status: "not-started"
      },
      {
        id: "t2",
        label: "Task 2",
        start: "2026-03-05",
        end: "2026-03-08",
        dependsOn: "non-existent-task", // Dangling dependency!
        progress: 0,
        status: "not-started"
      }
    ];

    const ctx = { defaultGapDays: 2, diagnostics: [] };
    const sanitized = stage.process(tasks, ctx);

    // Inverted date corrected
    expect(sanitized[0].start).toBe("2026-03-10");
    expect(sanitized[0].end).toBe("2026-03-10");
    // Self-dependency removed
    expect(sanitized[0].dependsOn).toBeNull();
    // Dangling dependency removed
    expect(sanitized[1].dependsOn).toBeNull();
    // Diagnostic recorded
    expect(ctx.diagnostics.length).toBeGreaterThan(0);
    expect(ctx.diagnostics.some((message) => message.includes("Removed invalid dependencies"))).toBe(true);
  });

  it("CycleGuardStage detects dependency loops", () => {
    const stage = new CycleGuardStage();
    const cyclicTasks: Task[] = [
      { id: "a", label: "A", start: "2026-01-01", end: "2026-01-05", dependsOn: "b", progress: 0, status: "not-started" },
      { id: "b", label: "B", start: "2026-01-06", end: "2026-01-10", dependsOn: "a", progress: 0, status: "not-started" }
    ];

    const ctx = { defaultGapDays: 2, diagnostics: [] };
    stage.process(cyclicTasks, ctx);

    expect(ctx.diagnostics.some((d) => d.includes("Circular dependency"))).toBe(true);
  });

  it("does not cascade a cyclic graph and reports locked constraint violations", () => {
    const stage = new CascadeResolveStage();
    const cyclic: Task[] = [
      { id: "a", start: "2026-01-01", end: "2026-01-02", dependsOn: "b" },
      { id: "b", start: "2026-01-01", end: "2026-01-02", dependsOn: "a" }
    ];
    const context = { defaultGapDays: 1, diagnostics: [] as string[] };
    expect(stage.process(cyclic, context)).toEqual(cyclic);
    expect(context.diagnostics[0]).toMatch(/circular/i);
    const locked: Task[] = [
      { id: "a", start: "2026-01-01", end: "2026-01-05" },
      { id: "b", start: "2026-01-02", end: "2026-01-03", dependsOn: "a", locked: true }
    ];
    const lockedContext = { defaultGapDays: 0, diagnostics: [] as string[] };
    expect(stage.process(locked, lockedContext)[1].start).toBe("2026-01-02");
    expect(lockedContext.diagnostics[0]).toMatch(/locked.*violates/i);
  });

  it("CascadeResolveStage shifts downstream tasks while respecting gap days and locked flags", () => {
    const stage = new CascadeResolveStage();
    const tasks: Task[] = [
      { id: "t1", label: "T1", start: "2026-01-01", end: "2026-01-05", dependsOn: null, progress: 0, status: "not-started" },
      { id: "t2", label: "T2", start: "2026-01-01", end: "2026-01-03", dependsOn: "t1", progress: 0, status: "not-started" },
      { id: "t3", label: "T3", start: "2026-01-01", end: "2026-01-04", dependsOn: "t1", locked: true, progress: 0, status: "not-started" }
    ];

    const ctx = { defaultGapDays: 2 };
    const resolved = stage.process(tasks, ctx);

    // t1 is unchanged
    expect(resolved[0].start).toBe("2026-01-01");
    expect(resolved[0].end).toBe("2026-01-05");

    // t2 starts after t1.end (2026-01-05) + 2 days = 2026-01-07
    expect(resolved[1].start).toBe("2026-01-07");
    expect(resolved[1].end).toBe("2026-01-09");

    // t3 is locked, must remain 2026-01-01 to 2026-01-04
    expect(resolved[2].start).toBe("2026-01-01");
    expect(resolved[2].end).toBe("2026-01-04");
  });

  it("CriticalPathStage tags critical tasks and computes metrics", () => {
    const stage = new CriticalPathStage();
    const tasks: Task[] = [
      { id: "A", label: "Task A", start: "2026-09-01", end: "2026-09-10", dependsOn: null, progress: 0, status: "not-started" },
      { id: "B", label: "Task B", start: "2026-09-10", end: "2026-09-20", dependsOn: "A", progress: 0, status: "not-started" },
      { id: "C", label: "Task C", start: "2026-09-01", end: "2026-09-05", dependsOn: null, progress: 0, status: "not-started" }
    ];

    const ctx = { defaultGapDays: 0, options: {} };
    const tagged = stage.process(tasks, ctx);

    expect(tagged.find((t) => t.id === "A")?.critical).toBe(true);
    expect(tagged.find((t) => t.id === "B")?.critical).toBe(true);
    expect(tagged.find((t) => t.id === "C")?.critical).toBe(false);
    expect(ctx.options.cpmResult).toBeDefined();
    expect(ctx.options.cpmResult.criticalTaskIds.has("A")).toBe(true);
    expect(ctx.options.cpmResult.criticalTaskIds.has("B")).toBe(true);
  });

  it("SchedulePipeline executes full assembly line cleanly", () => {
    const pipeline = SchedulePipeline.createDefault({ includeCriticalPath: true });
    expect(pipeline.getStages().length).toBe(4);

    const rawTasks: Task[] = [
      { id: "a", label: "Task A", start: "2026-02-01", end: "2026-02-05", dependsOn: null, progress: 0, status: "not-started" },
      { id: "b", label: "Task B", start: "2026-02-01", end: "2026-01-20", dependsOn: "a", progress: 0, status: "not-started" } // inverted end
    ];

    const result = pipeline.execute(rawTasks, { defaultGapDays: 1 });
    expect(result.tasks.length).toBe(2);
    // Task B inverted date sanitized and cascaded after Task A
    expect(result.tasks[1].start).toBe("2026-02-06");
  });
});
