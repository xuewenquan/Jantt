import { describe, it, expect, vi } from "vitest";
import {
  parseDependencyRelation,
  getTaskDependencyRelations,
  filterDependencies,
  appendDependency,
  isTaskStartBlocked,
  DependencyRelation
} from "../src/dependencies";
import { resolveSchedule, calculateCriticalPath } from "../src/resolver";
import { Task } from "../src/types";
import { createTaskSidebar } from "../src/sidebar";
import { TaskScheduleCoordinator } from "../src/rendering/task-schedule-coordinator";
import { renderDependencyLinks } from "../src/renderers/dependency-links";
import { layout } from "../src/layout";

describe("Enterprise 4-Type Dependency & Lead/Lag Engine", () => {
  it("renders and deletes parallel links independently", () => {
    const data = { tasks: [
      { id: "a", start: "2026-11-02", end: "2026-11-04" },
      { id: "b", start: "2026-11-04", end: "2026-11-05", dependsOn: ["a:FS+0d", "a:FS-1d"] }
    ] };
    const result = layout(data, { showCriticalPath: true });
    let updated = data as import("../src/types").JanttData;
    const links = renderDependencyLinks({ dependencies: result.dependencies, canvasWidth: 300, canvasHeight: 100, showCritical: true,
      onLinkDelete: (from, to, index) => { updated = TaskScheduleCoordinator.removeDependency(updated, from, to, index); }
    });
    expect(links.depPathElements.size).toBe(2);
    expect(result.dependencies[0].path).not.toBe(result.dependencies[1].path);
    expect(links.depPathElements.get(result.dependencies[1])!.getAttribute("title")).toContain("FS -1d");
    const paths = [...links.svg.querySelectorAll<SVGPathElement>(".jantt-dep-path")];
    expect(paths[paths.length - 1].classList.contains("is-critical")).toBe(true);
    links.depPathElements.get(result.dependencies[1])!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getTaskDependencyRelations(updated.tasks[1])).toEqual([{ id: "a", type: "FS", lagDays: 0, explicitZeroLag: true }]);
  });
  it("edits relationships without losing types, lags, or hyphenated IDs", () => {
    const input = ["task-1:SS+0d", { id: "task-2", type: "FF" as const, lag: -2 }, "task-3"];
    const appended = appendDependency(input, "task-4");
    expect(appended).toEqual([...input, "task-4"]);
    expect(filterDependencies(appended, (id) => id !== "task-3")).toEqual([input[0], input[1], "task-4"]);
    expect(filterDependencies("task-1:SS+0d,task-2:FF-2d", (id) => id !== "task-2")).toBe("task-1:SS+0d");
  });

  it("preserves relationship details when a task is saved or another task is deleted", () => {
    const a: Task = { id: "task-1", category: "dev", start: "2026-09-01", end: "2026-09-02" };
    const b: Task = { id: "task-2", category: "dev", start: "2026-09-01", end: "2026-09-02" };
    const c: Task = { id: "task-3", category: "dev", start: "2026-09-05", end: "2026-09-06", dependsOn: ["task-1:SS+0d", { id: "task-2", type: "FF", lag: -2 }] };
    const onSave = vi.fn();
    const sidebar = createTaskSidebar({ task: c, allTasks: [a, b, c], categories: {}, onSave, onClose: () => {} });
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave.mock.calls[0][0].dependsOn).toEqual(c.dependsOn);
    sidebar.element.remove();
    const result = TaskScheduleCoordinator.deleteTask({ tasks: [a, b, c] }, "task-1");
    expect(result.tasks.find((task) => task.id === "task-3")?.dependsOn).toEqual({ id: "task-2", type: "FF", lag: -2 });
    expect(c.dependsOn).toEqual(["task-1:SS+0d", { id: "task-2", type: "FF", lag: -2 }]);
  });

  it("uses relationship type and calendars when showing sidebar timing conflicts", () => {
    const a: Task = { id: "a", category: "dev", start: "2026-11-04", end: "2026-11-06" };
    const b: Task = { id: "b", category: "dev", start: "2026-11-05", end: "2026-11-06", dependsOn: "a:SS+1d" };
    const sidebar = createTaskSidebar({ task: b, allTasks: [a, b], categories: {}, scheduleContext: { calendar: "standard" }, onSave: () => {}, onClose: () => {} });
    expect(sidebar.element.querySelector<HTMLElement>("#jantt-sidebar-dep-conflict-box")?.style.display).toBe("none");
    sidebar.element.remove();
    const fs = { ...b, dependsOn: "a:FS+1d" };
    const second = createTaskSidebar({ task: fs, allTasks: [a, fs], categories: {}, scheduleContext: { calendar: "standard" }, onSave: () => {}, onClose: () => {} });
    second.element.querySelector<HTMLButtonElement>("#jantt-sidebar-align-btn")!.click();
    expect(second.element.querySelector<HTMLInputElement>("#jantt-sidebar-start")?.value).toBe("2026-11-09");
    expect(second.element.querySelector<HTMLInputElement>("#jantt-sidebar-end")?.value).toBe("2026-11-10");
    second.element.remove();
  });

  it("edits relationship type and an explicit zero lag in the sidebar", () => {
    const a: Task = { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-05" };
    const b: Task = { id: "b", category: "dev", start: "2026-11-02", end: "2026-11-03", dependsOn: "a" };
    const onSave = vi.fn();
    const sidebar = createTaskSidebar({ task: b, allTasks: [a, b], categories: {}, onSave, onClose: () => {} });
    const type = sidebar.element.querySelector<HTMLSelectElement>("[data-dep-type='0']")!;
    type.value = "SS";
    type.dispatchEvent(new Event("change"));
    const lag = sidebar.element.querySelector<HTMLInputElement>("[data-dep-lag='0']")!;
    lag.value = "0";
    lag.dispatchEvent(new Event("change"));
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave.mock.calls[0][0].dependsOn).toEqual([{ id: "a", type: "SS", lagDays: 0 }]);
    sidebar.element.remove();
  });

  it("adds and removes individual parallel relationships in the sidebar", () => {
    const a: Task = { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-05" };
    const b: Task = { id: "b", category: "dev", start: "2026-11-02", end: "2026-11-03", dependsOn: "a:SS+1d" };
    const onSave = vi.fn();
    const sidebar = createTaskSidebar({ task: b, allTasks: [a, b], categories: {}, onSave, onClose: () => {} });
    const add = sidebar.element.querySelector<HTMLSelectElement>("#jantt-sidebar-add-dep-select")!;
    add.value = "a";
    add.dispatchEvent(new Event("change"));
    const lag = sidebar.element.querySelector<HTMLInputElement>("[data-dep-lag='1']")!;
    lag.value = "-2";
    lag.dispatchEvent(new Event("change"));
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave.mock.calls[0][0].dependsOn).toEqual([{ id: "a", type: "SS", lagDays: 1 }, { id: "a", type: "FS", lagDays: -2 }]);
    sidebar.element.querySelector<HTMLButtonElement>("[data-remove-dep='0']")!.click();
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave.mock.calls[1][0].dependsOn).toEqual([{ id: "a", type: "FS", lagDays: -2 }]);
    sidebar.element.remove();
  });

  it("uses the transitive predecessor schedule when previewing sidebar conflicts", () => {
    const a: Task = { id: "a", start: "2026-11-01", end: "2026-11-05" };
    const b: Task = { id: "b", start: "2026-11-02", end: "2026-11-03", dependsOn: "a" };
    const c: Task = { id: "c", start: "2026-11-05", end: "2026-11-06", dependsOn: "b" };
    const sidebar = createTaskSidebar({ task: c, allTasks: [a, b, c], categories: {}, onSave: () => {}, onClose: () => {} });
    expect(sidebar.element.textContent).toContain("Dependency Timing Conflict");
    sidebar.element.remove();
  });

  it("does not add an identical default dependency twice from the sidebar", () => {
    const a: Task = { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-05" };
    const b: Task = { id: "b", category: "dev", start: "2026-11-06", end: "2026-11-07", dependsOn: "a" };
    const onSave = vi.fn();
    const sidebar = createTaskSidebar({ task: b, allTasks: [a, b], categories: {}, onSave, onClose: () => {} });
    const add = sidebar.element.querySelector<HTMLSelectElement>("#jantt-sidebar-add-dep-select")!;
    add.value = "a";
    add.dispatchEvent(new Event("change"));
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave.mock.calls[0][0].dependsOn).toBe("a");
    sidebar.element.remove();
  });

  it("does not mark tasks blocked by a dangling predecessor", () => {
    expect(isTaskStartBlocked({ dependsOn: "ghost" }, new Map())).toBe(false);
  });

  it("saves resource allocation from the task sidebar as allocation units", () => {
    const task: Task = { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-03" };
    const onSave = vi.fn();
    const sidebar = createTaskSidebar({ task, allTasks: [task], categories: {}, onSave, onClose: () => {} });
    sidebar.element.querySelector<HTMLInputElement>("#jantt-sidebar-allocation")!.value = "50";
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave.mock.calls[0][0].allocation).toBe(0.5);
    sidebar.element.remove();
  });

  it("prevents saving a dependency cycle from the sidebar", () => {
    const a: Task = { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-03" };
    const b: Task = { id: "b", category: "dev", start: "2026-11-04", end: "2026-11-05", dependsOn: "a" };
    const onSave = vi.fn();
    const sidebar = createTaskSidebar({ task: a, allTasks: [a, b], categories: {}, onSave, onClose: () => {} });
    const select = sidebar.element.querySelector<HTMLSelectElement>("#jantt-sidebar-add-dep-select")!;
    select.value = "b";
    select.dispatchEvent(new Event("change"));
    sidebar.element.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(sidebar.element.textContent).toMatch(/circular dependency/i);
    sidebar.element.remove();
  });
  describe("parseDependencyRelation", () => {
    it("parses classic string id as default FS with 0 lag", () => {
      const rel = parseDependencyRelation("task-1");
      expect(rel).toEqual({ id: "task-1", type: "FS", lagDays: 0 });
    });

    it("parses explicit relationship types without lag", () => {
      expect(parseDependencyRelation("task-A:SS")).toEqual({ id: "task-A", type: "SS", lagDays: 0 });
      expect(parseDependencyRelation("task-B:FF")).toEqual({ id: "task-B", type: "FF", lagDays: 0 });
      expect(parseDependencyRelation("task-C:SF")).toEqual({ id: "task-C", type: "SF", lagDays: 0 });
      expect(parseDependencyRelation("task-D:FS")).toEqual({ id: "task-D", type: "FS", lagDays: 0 });
    });

    it("parses positive lag offsets (lag time)", () => {
      expect(parseDependencyRelation("task-1:FS+3d")).toEqual({ id: "task-1", type: "FS", lagDays: 3 });
      expect(parseDependencyRelation("task-1:SS+5")).toEqual({ id: "task-1", type: "SS", lagDays: 5 });
      expect(parseDependencyRelation("task-1+2d")).toEqual({ id: "task-1", type: "FS", lagDays: 2 });
    });

    it("parses negative lag offsets (lead time)", () => {
      expect(parseDependencyRelation("task-1:FF-2d")).toEqual({ id: "task-1", type: "FF", lagDays: -2 });
      expect(parseDependencyRelation("task-1-3d")).toEqual({ id: "task-1", type: "FS", lagDays: -3 });
      expect(parseDependencyRelation("task-1:FS-3")).toEqual({ id: "task-1", type: "FS", lagDays: -3 });
    });

    it("parses structured dependency objects", () => {
      expect(parseDependencyRelation({ id: "task-1", type: "SS", lag: 4 })).toEqual({
        id: "task-1",
        type: "SS",
        lagDays: 4
      });
      expect(parseDependencyRelation({ id: "task-2", type: "FF", lagDays: -1 })).toEqual({
        id: "task-2",
        type: "FF",
        lagDays: -1
      });
    });

    it("returns null for invalid inputs", () => {
      expect(parseDependencyRelation("")).toBeNull();
      expect(parseDependencyRelation(null)).toBeNull();
      expect(parseDependencyRelation({})).toBeNull();
    });
  });

  describe("getTaskDependencyRelations", () => {
    it("extracts multiple dependencies from a comma-separated string", () => {
      const task = { dependsOn: "t1:FS+2d, t2:SS, t3:FF-1d" };
      const relations = getTaskDependencyRelations(task);
      expect(relations).toHaveLength(3);
      expect(relations[0]).toEqual({ id: "t1", type: "FS", lagDays: 2 });
      expect(relations[1]).toEqual({ id: "t2", type: "SS", lagDays: 0 });
      expect(relations[2]).toEqual({ id: "t3", type: "FF", lagDays: -1 });
    });

    it("extracts dependencies from mixed arrays (strings & objects)", () => {
      const task = {
        dependsOn: [
          "t1",
          { id: "t2", type: "SS" as const, lag: 3 },
          "t3:SF+1"
        ]
      };
      const relations = getTaskDependencyRelations(task);
      expect(relations).toHaveLength(3);
      expect(relations[1]).toEqual({ id: "t2", type: "SS", lagDays: 3 });
      expect(relations[2]).toEqual({ id: "t3", type: "SF", lagDays: 1 });
    });
  });

  describe("resolveSchedule with 4-Type Dependencies", () => {
    it("distinguishes explicit zero lag from an omitted lag", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-05" },
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-02", dependsOn: [{ id: "A", lagDays: 0 }] },
        { id: "C", category: "dev", start: "2026-09-01", end: "2026-09-02", dependsOn: "A:FS+0d" },
        { id: "D", category: "dev", start: "2026-09-01", end: "2026-09-02", dependsOn: "A" }
      ];
      const resolved = resolveSchedule(tasks, 2);
      expect(resolved.find((t) => t.id === "B")!.start).toBe("2026-09-05");
      expect(resolved.find((t) => t.id === "C")!.start).toBe("2026-09-05");
      expect(resolved.find((t) => t.id === "D")!.start).toBe("2026-09-07");
    });

    it("propagates dependencies through chains longer than 24 tasks", () => {
      const tasks: Task[] = Array.from({ length: 30 }, (_, i) => ({
        id: String(i), category: "dev", start: "2026-09-01", end: "2026-09-02",
        ...(i ? { dependsOn: String(i - 1) } : {})
      })).reverse();
      expect(resolveSchedule(tasks, 0).find((t) => t.id === "29")!.start).toBe("2026-09-30");
    });
    it("paces Finish-to-Start (FS) with positive lag", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-05" }, // 4 days duration
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-04", dependsOn: "A:FS+3d" } // 3 days lag after A finishes (Sept 5 + 3 = Sept 8)
      ];

      const resolved = resolveSchedule(tasks);
      const b = resolved.find((t) => t.id === "B")!;
      expect(b.start).toBe("2026-09-08");
      expect(b.end).toBe("2026-09-11"); // preserves 3-day duration
    });

    it("paces Start-to-Start (SS) with lag", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-20" }, // Long task
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-05", dependsOn: "A:SS+2d" } // Starts 2 days after A starts (Sept 1 + 2 = Sept 3)
      ];

      const resolved = resolveSchedule(tasks);
      const b = resolved.find((t) => t.id === "B")!;
      expect(b.start).toBe("2026-09-03");
      expect(b.end).toBe("2026-09-07"); // preserves 4-day duration
    });

    it("paces Finish-to-Finish (FF) with lag", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-10" },
        // B has duration of 5 days. Must finish on or after A's finish + 1d (Sept 11).
        // Therefore B must start at least on Sept 11 - 5d = Sept 6.
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-06", dependsOn: "A:FF+1d" }
      ];

      const resolved = resolveSchedule(tasks);
      const b = resolved.find((t) => t.id === "B")!;
      expect(b.start).toBe("2026-09-06");
      expect(b.end).toBe("2026-09-11");
    });

    it("paces Start-to-Finish (SF) with lag", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-10", end: "2026-09-20" },
        // B has duration of 4 days. Must finish on or after A's start + 2d (Sept 12).
        // Therefore B must start at least on Sept 12 - 4d = Sept 8.
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-05", dependsOn: "A:SF+2d" }
      ];

      const resolved = resolveSchedule(tasks);
      const b = resolved.find((t) => t.id === "B")!;
      expect(b.start).toBe("2026-09-08");
      expect(b.end).toBe("2026-09-12");
    });

    it("correctly resolves multi-dependency convergence with mixed types", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-05" }, // FS target: Sept 5 + 0 = Sept 5
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-15" }, // SS+6 target: Sept 1 + 6 = Sept 7
        // C has duration 3 days. Depends on both A (FS) and B (SS+6d).
        // Must honor the latest constraint: max(Sept 5, Sept 7) = Sept 7.
        { id: "C", category: "dev", start: "2026-09-01", end: "2026-09-04", dependsOn: ["A:FS", "B:SS+6d"] }
      ];

      const resolved = resolveSchedule(tasks, 0);
      const c = resolved.find((t) => t.id === "C")!;
      expect(c.start).toBe("2026-09-07");
      expect(c.end).toBe("2026-09-10");
    });

    it("honors all four independently lagged relationships between the same tasks", () => {
      const relations = ["A:FS-1d", "A:SS+6d", "A:FF+5d", "A:SF+10d"];
      for (const dependsOn of [relations, [...relations].reverse()]) {
        const tasks: Task[] = [
          { id: "A", start: "2026-09-01", end: "2026-09-05" },
          { id: "B", start: "2026-08-30", end: "2026-09-01", dependsOn }
        ];
        const b = resolveSchedule(tasks, 0).find((task) => task.id === "B")!;
        expect([b.start, b.end]).toEqual(["2026-09-09", "2026-09-11"]);
        expect(calculateCriticalPath(tasks, { defaultGapDays: 0 }).metrics.get("B")?.earlyStart).toBe("2026-09-09");
      }
    });
  });

  describe("CPM relationship constraints", () => {
    it("assembles critical paths when task IDs contain the dependency-key separator", () => {
      const tasks: Task[] = [
        { id: "a->b", start: "2026-09-01", end: "2026-09-02" },
        { id: "c->d", start: "2026-09-01", end: "2026-09-02", dependsOn: [{ id: "a->b", type: "FS", lag: 0 }] }
      ];
      const result = calculateCriticalPath(tasks, { defaultGapDays: 0 });
      expect(result.criticalPaths).toEqual([["a->b", "c->d"]]);
    });
    it("reports cycles without inventing critical path results", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-02", dependsOn: "B" },
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-02", dependsOn: "A" }
      ];
      const result = calculateCriticalPath(tasks);
      expect(result.errors?.[0]).toMatch(/circular/i);
      expect(result.metrics.size).toBe(0);
      expect(result.criticalRelationKeys?.size).toBe(0);
      expect(calculateCriticalPath([]).criticalRelationKeys?.size).toBe(0);
      expect(calculateCriticalPath([{ ...tasks[0], dependsOn: "A" }]).errors || []).toEqual([]);
    });

    it("keeps free float independent of a late target date", () => {
      const tasks: Task[] = [{ id: "A", category: "dev", start: "2026-09-01", end: "2026-09-03" }];
      const metrics = calculateCriticalPath(tasks, { targetDate: "2026-09-06" }).metrics.get("A")!;
      expect(metrics.totalFloat).toBe(3);
      expect(metrics.freeFloat).toBe(0);
    });
    it.each([
      ["FS", "2026-09-07"], ["SS", "2026-09-03"],
      ["FF", "2026-09-05"], ["SF", "2026-09-01"]
    ] as const)("calculates %s with an independent lag", (type, expectedStart) => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-05" },
        { id: "B", category: "dev", start: "2026-08-30", end: "2026-09-01", dependsOn: [{ id: "A", type, lag: 2 }] }
      ];
      const result = calculateCriticalPath(tasks);
      expect(result.metrics.get("B")!.earlyStart).toBe(expectedStart);
      expect(result.metrics.get("A")!.earlyFinish).toBe("2026-09-05");
      expect(result.metrics.get("A")!.totalFloat).toBe(0);
      expect(result.criticalDepKeys.has("A->B")).toBe(type !== "SF");
    });

    it("uses each predecessor's lag and preserves explicit zero", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-09-01", end: "2026-09-04" },
        { id: "B", category: "dev", start: "2026-09-01", end: "2026-09-06" },
        { id: "C", category: "dev", start: "2026-09-01", end: "2026-09-02", dependsOn: [{ id: "A", lag: 3 }, { id: "B", lag: 0 }] }
      ];
      const result = calculateCriticalPath(tasks, { defaultGapDays: 5 });
      expect(result.metrics.get("C")!.earlyStart).toBe("2026-09-07");
      expect(result.metrics.get("B")!.freeFloat).toBe(1);
      expect(result.criticalDepKeys.has("A->C")).toBe(true);
    });
  });
});
