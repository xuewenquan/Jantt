import { describe, it, expect } from "vitest";
import {
  detectOverAllocations,
  levelResources,
  getTaskAllocationUnits
} from "../src/resource-leveler";
import { CALENDAR_PRESETS, addWorkingDays, isWorkingDay } from "../src/calendar";
import { addDays } from "../src/date-math";
import { getTaskDependencyRelations } from "../src/dependencies";
import { resolveSchedule } from "../src/resolver";
import type { Task } from "../src/types";

describe("Autonomous Resource Leveling Heuristic Engine", () => {
  describe("getTaskAllocationUnits", () => {
    it("defaults to 1.0 when allocation is unspecified", () => {
      const task: Task = { id: "t1", category: "dev", start: "2026-11-01", end: "2026-11-05" };
      expect(getTaskAllocationUnits(task)).toBe(1.0);
    });

    it("reads allocation from direct property or custom fields", () => {
      const task1: Task = { id: "t1", category: "dev", start: "2026-11-01", end: "2026-11-05", allocation: 0.5 };
      expect(getTaskAllocationUnits(task1)).toBe(0.5);

      const task2: Task = {
        id: "t2",
        category: "dev",
        start: "2026-11-01",
        end: "2026-11-05",
        fields: { allocation: 0.8 }
      };
      expect(getTaskAllocationUnits(task2)).toBe(0.8);
    });
  });

  describe("detectOverAllocations", () => {
    it("finishes scanning at the last supported date", () => {
      const tasks: Task[] = [{ id: "a", assignee: "alice", start: "9999-12-31", end: "9999-12-31" }];
      expect(detectOverAllocations(tasks, { defaultCapacity: 0 })[0].date).toBe("9999-12-31");
    });
    it("does not include zero-allocation tasks in a capacity conflict", () => {
      const tasks: Task[] = [
        { id: "zero", assignee: "alice", start: "2026-11-02", end: "2026-11-02", allocation: 0, priority: "low" },
        { id: "over", assignee: "alice", start: "2026-11-02", end: "2026-11-02", allocation: 2 }
      ];
      expect(detectOverAllocations(tasks)[0].tasks).toEqual(["over"]);
      const result = levelResources(tasks);
      expect(result.adjustments).toEqual([]);
      expect(result.tasks[0].start).toBe("2026-11-02");
      expect(result.remainingOverallocations[0].tasks).toEqual(["over"]);
    });
    it("preserves small allocation values in overload details", () => {
      const tasks: Task[] = [{ id: "a", assignee: "alice", start: "2026-11-02", end: "2026-11-02", allocation: 0.001 }];
      expect(detectOverAllocations(tasks, { defaultCapacity: 0 })[0].totalUnits).toBe(0.001);
    });
    it("detects small real overloads without reporting floating-point noise", () => {
      const task = { assignee: "alice", start: "2026-11-02", end: "2026-11-02" };
      expect(detectOverAllocations([{ ...task, id: "small", allocation: 0.00005 }], { defaultCapacity: 0 })).toHaveLength(1);
      expect(detectOverAllocations([{ ...task, id: "a", allocation: 0.1 }, { ...task, id: "b", allocation: 0.2 }], { defaultCapacity: 0.3 })).toEqual([]);
      const many = Array.from({ length: 1000 }, (_, i) => ({ ...task, id: String(i), allocation: 0.001 }));
      expect(detectOverAllocations(many, { defaultCapacity: 1 })).toEqual([]);
    });
    it("groups a person's ID and name as the same resource", () => {
      const tasks: Task[] = [
        { id: "a", assignee: "p1", start: "2026-11-02", end: "2026-11-02", allocation: 0.4 },
        { id: "b", assignee: "alice", start: "2026-11-02", end: "2026-11-02", allocation: 0.4 }
      ];
      const result = detectOverAllocations(tasks, { people: [{ id: "p1", name: "Alice" }], resourceCapacities: { Alice: 0.5 } });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ resourceId: "p1", totalUnits: 0.8, capacity: 0.5, tasks: ["a", "b"] });
    });
    it("detects work on a resource's non-working day when the task calendar differs", () => {
      const tasks: Task[] = [{ id: "a", assignee: "alice", calendar: "continuous", start: "2026-11-06", end: "2026-11-09" }];
      const result = detectOverAllocations(tasks, { people: [{ id: "alice", name: "Alice", calendar: "standard" }] });
      expect(result.map((item) => item.date)).toEqual(["2026-11-07", "2026-11-08"]);
      expect(result[0]).toMatchObject({ tasks: ["a"], totalUnits: 1, capacity: 0 });
    });
    it("skips non-working days when a resource calendar is active", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", assignee: "alice", start: "2026-11-06", end: "2026-11-09" },
        { id: "b", category: "dev", assignee: "alice", start: "2026-11-06", end: "2026-11-09" }
      ];
      expect(detectOverAllocations(tasks, { calendar: "standard" }).map((a) => a.date)).toEqual(["2026-11-06", "2026-11-09"]);
    });
    it("returns empty when no resources overlap", () => {
      const tasks: Task[] = [
        { id: "t1", category: "dev", assignee: "alice", start: "2026-11-01", end: "2026-11-04" },
        { id: "t2", category: "dev", assignee: "alice", start: "2026-11-05", end: "2026-11-08" },
        { id: "t3", category: "qa", assignee: "bob", start: "2026-11-02", end: "2026-11-06" }
      ];
      const result = detectOverAllocations(tasks);
      expect(result).toHaveLength(0);
    });

    it("detects over-allocation when tasks overlap for the same resource", () => {
      const tasks: Task[] = [
        { id: "t1", category: "dev", assignee: "alice", start: "2026-11-02", end: "2026-11-06" },
        { id: "t2", category: "dev", assignee: "alice", start: "2026-11-04", end: "2026-11-08" }
      ];
      const result = detectOverAllocations(tasks);
      expect(result.length).toBeGreaterThan(0);
      // Overlap days are 2026-11-04, 2026-11-05, 2026-11-06
      const dates = result.map((r) => r.date);
      expect(dates).toContain("2026-11-04");
      expect(dates).toContain("2026-11-05");
      expect(dates).toContain("2026-11-06");
      expect(result[0].resourceId).toBe("alice");
      expect(result[0].tasks).toEqual(["t1", "t2"]);
      expect(result[0].totalUnits).toBe(2.0);
    });

    it("respects custom resource capacities", () => {
      const tasks: Task[] = [
        // Charlie has a single 0.8 unit task, but his capacity is 0.5 (part-time)
        { id: "t1", category: "design", assignee: "charlie", start: "2026-11-01", end: "2026-11-03", allocation: 0.8 }
      ];
      const singleResult = detectOverAllocations(tasks, { resourceCapacities: { charlie: 0.5 } });
      expect(singleResult).toHaveLength(3);
      expect(singleResult[0].tasks).toEqual(["t1"]);
      expect(singleResult[0].totalUnits).toBe(0.8);
      const tasksMulti: Task[] = [
        { id: "t1", category: "design", assignee: "charlie", start: "2026-11-01", end: "2026-11-03", allocation: 0.3 },
        { id: "t2", category: "design", assignee: "charlie", start: "2026-11-02", end: "2026-11-04", allocation: 0.3 }
      ];
      // Total 0.6 > capacity 0.5
      const result = detectOverAllocations(tasksMulti, {
        resourceCapacities: { charlie: 0.5 }
      });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].resourceId).toBe("charlie");
      expect(result[0].totalUnits).toBe(0.6);
    });
  });

  describe("levelResources Heuristic", () => {
    it("levels around a locked task that starts on a non-working day", () => {
      const tasks: Task[] = [
        { id: "locked", start: "2026-11-07", end: "2026-11-07", assignee: "alice", locked: true },
        { id: "a", start: "2026-11-02", end: "2026-11-03", assignee: "alice" },
        { id: "b", start: "2026-11-02", end: "2026-11-03", assignee: "alice" }
      ];
      const result = levelResources(tasks, { calendar: "standard", defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.unresolvedReasons || []).toEqual([]);
      expect(result.tasks.find((task) => task.id === "locked")).toMatchObject({ start: "2026-11-07", end: "2026-11-07" });
    });
    it("stops scanning a task with an invalid end date", () => {
      const tasks: Task[] = [{ id: "a", assignee: "alice", start: "2026-11-02", end: "TBD" }];
      expect(detectOverAllocations(tasks)).toEqual([]);
    }, 5000);
    it("accepts a temporary locked conflict when the other task can move later", () => {
      const tasks: Task[] = [
        { id: "locked-alice", start: "2026-11-02", end: "2026-11-02", assignee: "alice", locked: true },
        { id: "a", start: "2026-11-02", end: "2026-11-02", assignee: "alice" },
        { id: "b", start: "2026-11-03", end: "2026-11-03", assignee: "bob", dependsOn: "a:SS+1d" },
        { id: "locked-bob", start: "2026-11-04", end: "2026-11-04", assignee: "bob", locked: true }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.unresolvedReasons || []).toEqual([]);
      expect(result.tasks.find((task) => task.id === "b")?.start).toBe("2026-11-05");
    });
    it("avoids repeated resource conflicts created by cascading successors", () => {
      const tasks: Task[] = [
        { id: "t0", start: "2026-11-03", end: "2026-11-03", assignee: "bob", locked: true },
        { id: "t1", start: "2026-11-04", end: "2026-11-05", assignee: "bob", locked: true },
        { id: "t2", start: "2026-11-02", end: "2026-11-03", assignee: "alice", priority: "high" },
        { id: "t3", start: "2026-11-02", end: "2026-11-04", assignee: "bob", priority: "low", dependsOn: "t1:FF-1d" },
        { id: "t4", start: "2026-11-03", end: "2026-11-05", assignee: "bob", priority: "high", dependsOn: "t3:SF+0d" },
        { id: "t5", start: "2026-11-03", end: "2026-11-05", assignee: "alice", locked: true },
        { id: "t6", start: "2026-11-02", end: "2026-11-02", assignee: "bob", priority: "high", dependsOn: "t4:SF-1d" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.unresolvedReasons || []).toEqual([]);
      const byId = new Map(result.tasks.map((task) => [task.id, task]));
      expect(byId.get("t3")!.end >= addDays(byId.get("t1")!.end, -1)).toBe(true);
      expect(byId.get("t4")!.end >= byId.get("t3")!.start).toBe(true);
      expect(byId.get("t6")!.end >= addDays(byId.get("t4")!.start, -1)).toBe(true);
    });
    it("avoids cascading a successor into a locked resource booking", () => {
      const tasks: Task[] = [
        { id: "a", start: "2026-11-03", end: "2026-11-03", assignee: "alice", priority: "low" },
        { id: "b", start: "2026-11-02", end: "2026-11-02", assignee: "bob", priority: "high", dependsOn: "a:SF-1d" },
        { id: "c", start: "2026-11-04", end: "2026-11-05", assignee: "bob", locked: true, dependsOn: "b:FS-1d" },
        { id: "d", start: "2026-11-03", end: "2026-11-05", assignee: "alice", priority: "high" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.unresolvedReasons || []).toEqual([]);
      expect(result.tasks.find((task) => task.id === "a")?.start).toBe("2026-11-03");
      expect(result.tasks.find((task) => task.id === "c")?.start).toBe("2026-11-04");
    });
    it("reorders two future bookings to preserve a locked successor", () => {
      const tasks: Task[] = [
        { id: "t0", start: "2026-11-02", end: "2026-11-03", assignee: "bob", priority: "low" },
        { id: "t1", start: "2026-11-02", end: "2026-11-03", assignee: "alice", priority: "high", dependsOn: "t0:SS-1d" },
        { id: "t2", start: "2026-11-02", end: "2026-11-04", assignee: "bob", locked: true, dependsOn: "t0:SF-1d" },
        { id: "t3", start: "2026-11-03", end: "2026-11-03", assignee: "bob", priority: "low" },
        { id: "t4", start: "2026-11-04", end: "2026-11-05", assignee: "bob", priority: "low", dependsOn: "t2:FS+0d" },
        { id: "t5", start: "2026-11-03", end: "2026-11-04", assignee: "alice", priority: "high" },
        { id: "t6", start: "2026-11-05", end: "2026-11-05", assignee: "bob", priority: "high" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.unresolvedReasons || []).toEqual([]);
      expect(result.tasks.find((task) => task.id === "t2")?.start).toBe("2026-11-02");
      const byId = new Map(result.tasks.map((task) => [task.id, task]));
      expect(byId.get("t1")!.start >= addDays(byId.get("t0")!.start, -1)).toBe(true);
      expect(byId.get("t2")!.end >= addDays(byId.get("t0")!.start, -1)).toBe(true);
      expect(byId.get("t4")!.start >= byId.get("t2")!.end).toBe(true);
    });
    it("uses the target date when reporting whether a delay fits within float", () => {
      const tasks: Task[] = [
        { id: "a", assignee: "alice", start: "2026-11-02", end: "2026-11-02", locked: true },
        { id: "b", assignee: "alice", start: "2026-11-02", end: "2026-11-02" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 1, targetDate: "2026-11-10" });
      expect(result.adjustments[0].withinFloat).toBe(true);
    });
    it("leaves an overload unresolved when no later supported date exists", () => {
      const tasks: Task[] = [
        { id: "a", assignee: "alice", start: "9999-12-31", end: "9999-12-31", locked: true },
        { id: "b", assignee: "alice", start: "9999-12-31", end: "9999-12-31" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.tasks.map((task) => task.start)).toEqual(["9999-12-31", "9999-12-31"]);
      expect(result.remainingOverallocations).toHaveLength(1);
      expect(result.unresolvedReasons?.[0]).toMatch(/could not find.*heuristic search/i);
    });
    it("searches past a long explicit resource holiday", () => {
      const start = "2026-01-01";
      const holidays = Array.from({ length: 400 }, (_, day) => addDays(start, day));
      const tasks: Task[] = [{ id: "a", assignee: "alice", calendar: "continuous", start, end: start }];
      const options = { people: [{ id: "alice", name: "Alice", calendar: { workingDays: [0, 1, 2, 3, 4, 5, 6] as (0 | 1 | 2 | 3 | 4 | 5 | 6)[], holidays } }] };
      const result = levelResources(tasks, options);
      expect(result.tasks[0].start).toBe(addDays(start, 400));
      expect(result.remainingOverallocations).toEqual([]);
    });

    it("searches past a long resource holiday when resolving an overlap", () => {
      const start = "2026-01-01";
      const holidays = Array.from({ length: 400 }, (_, day) => addDays(start, day + 1));
      const tasks: Task[] = [
        { id: "a", assignee: "alice", calendar: "continuous", start, end: start, locked: true },
        { id: "b", assignee: "alice", calendar: "continuous", start, end: start }
      ];
      const options = { defaultGapDays: 1, people: [{ id: "alice", name: "Alice", calendar: { workingDays: [0, 1, 2, 3, 4, 5, 6] as (0 | 1 | 2 | 3 | 4 | 5 | 6)[], holidays } }] };
      const result = levelResources(tasks, options);
      expect(result.tasks[1].start).toBe(addDays(start, 401));
      expect(result.remainingOverallocations).toEqual([]);
    });
    it("finds feasible schedules in a seeded set of small constrained networks", () => {
      let seed = 9157;
      const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 7) % max; };
      const types = ["FS", "SS", "FF", "SF"] as const;
      let feasibleCount = 0;
      for (let scenario = 0; scenario < 500; scenario++) {
        const raw = Array.from({ length: 5 }, (_, i) => ({
          id: i, start: random(3), duration: 1 + random(2), resource: random(2) ? "alice" : "bob",
          locked: random(5) === 0, priority: random(2) ? "high" : "low",
          predecessor: i && random(3) === 0 ? random(i) : null, type: types[random(4)]
        }));
        const isFeasible = (starts: number[]) => raw.every((task, i) => {
          if (task.predecessor !== null) {
            const pred = raw[task.predecessor];
            const from = starts[task.predecessor] + (task.type[0] === "F" ? pred.duration : 0);
            const to = starts[i] + (task.type[1] === "F" ? task.duration : 0);
            if (to < from) return false;
          }
          return raw.every((other, j) => j <= i || other.resource !== task.resource
            || starts[i] + task.duration < starts[j] || starts[j] + other.duration < starts[i]);
        });
        const search = (index: number, starts: number[]): boolean => {
          if (index === raw.length) return isFeasible(starts);
          const task = raw[index];
          for (let start = task.start; start <= task.start + (task.locked ? 0 : 5); start++) {
            if (search(index + 1, [...starts, start])) return true;
          }
          return false;
        };
        if (!search(0, [])) continue;
        feasibleCount++;
        const tasks: Task[] = raw.map((task) => ({
          id: `t${task.id}`, category: "dev", start: addDays("2026-11-02", task.start),
          end: addDays("2026-11-02", task.start + task.duration), assignee: task.resource,
          locked: task.locked, priority: task.priority,
          ...(task.predecessor === null ? {} : { dependsOn: [{ id: `t${task.predecessor}`, type: task.type, lagDays: 0 }] })
        }));
        const result = levelResources(tasks, { defaultGapDays: 0 });
        expect(result.remainingOverallocations, `scenario ${scenario}`).toEqual([]);
        expect(result.unresolvedReasons || [], `scenario ${scenario}`).toEqual([]);
      }
      expect(feasibleCount).toBe(248);
    });
    it("moves a flexible blocker to preserve a task constrained by a locked successor", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", start: "2026-11-03", end: "2026-11-04", assignee: "alice", locked: true },
        { id: "b", category: "dev", start: "2026-11-03", end: "2026-11-04", assignee: "alice", priority: "low", dependsOn: "a:FF+0d" },
        { id: "c", category: "dev", start: "2026-11-04", end: "2026-11-06", assignee: "bob", locked: true, dependsOn: "b:FF+0d" },
        { id: "d", category: "dev", start: "2026-11-03", end: "2026-11-05", assignee: "bob", dependsOn: "b:SS+0d" },
        { id: "e", category: "dev", start: "2026-11-04", end: "2026-11-05", assignee: "alice", priority: "high" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks.find((t) => t.id === "b")?.start).toBe("2026-11-05");
      expect(result.tasks.find((t) => t.id === "e")?.start).toBe("2026-11-07");
      expect(result.tasks.find((t) => t.id === "c")?.end).toBe("2026-11-06");
    });

    it("reorders a blocker using the resource calendar and keeps the locked successor fixed", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", start: "2026-11-03", end: "2026-11-04", assignee: "alice", locked: true },
        { id: "b", category: "dev", start: "2026-11-03", end: "2026-11-04", assignee: "alice", priority: "low", dependsOn: "a:FF+0d" },
        { id: "c", category: "dev", start: "2026-11-04", end: "2026-11-06", assignee: "bob", locked: true, dependsOn: "b:FF+0d" },
        { id: "d", category: "dev", start: "2026-11-03", end: "2026-11-05", assignee: "bob", dependsOn: "b:SS+0d" },
        { id: "e", category: "dev", start: "2026-11-04", end: "2026-11-05", assignee: "alice", priority: "high" }
      ];
      const people = [{ id: "alice", name: "Alice", calendar: "standard" }, { id: "bob", name: "Bob", calendar: "continuous" }];
      const result = levelResources(tasks, { defaultGapDays: 0, people });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks.find((t) => t.id === "b")?.start).toBe("2026-11-05");
      expect(result.tasks.find((t) => t.id === "e")?.start).toBe("2026-11-09");
      expect(result.tasks.find((t) => t.id === "c")?.end).toBe("2026-11-06");
    });
    it("returns executable mixed-calendar schedules when no conflicts remain", () => {
      let seed = 87423;
      const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % max; };
      const types = ["FS", "SS", "FF", "SF"] as const;
      const people = [{ id: "alice", name: "Alice", calendar: "standard" }, { id: "bob", name: "Bob", calendar: "continuous" }];
      let solved = 0;
      for (let scenario = 0; scenario < 20; scenario++) {
        const tasks: Task[] = [];
        for (let i = 0; i < 8; i++) {
          const assignee = random(2) ? "alice" : "bob";
          const calendar = assignee === "alice" ? "standard" : "continuous";
          const start = addWorkingDays("2026-11-02", random(4), calendar);
          const end = addWorkingDays(start, 1 + random(3), calendar);
          const dependsOn = i && random(3) ? [{ id: `t${random(i)}`, type: types[random(4)], lagDays: random(5) - 2 }] : undefined;
          tasks.push({ id: `t${i}`, category: "dev", assignee, calendar, start, end, dependsOn });
        }
        const result = levelResources(tasks.reverse(), { people, defaultGapDays: 0 });
        if (result.remainingOverallocations.length || result.unresolvedReasons?.length) continue;
        solved++;
        const byId = new Map(result.tasks.map((task) => [task.id, task]));
        for (const task of result.tasks) for (const relation of getTaskDependencyRelations(task)) {
          const pred = byId.get(relation.id)!;
          const from = relation.type[0] === "F" ? pred.end : pred.start;
          const to = relation.type[1] === "F" ? task.end : task.start;
          expect(to >= addWorkingDays(from, relation.lagDays, task.calendar as "standard" | "continuous"), `${scenario}: ${pred.id} ${relation.type} ${task.id}`).toBe(true);
        }
        const end = result.tasks.map((task) => task.end).sort().at(-1)!;
        for (let date = "2026-11-02"; date <= end; date = addDays(date, 1)) {
          for (const person of people) {
            const load = result.tasks.filter((task) => task.assignee === person.id && task.start <= date && date <= task.end && isWorkingDay(date, task.calendar as "standard" | "continuous")).length;
            expect(load, `${scenario}: ${person.id} ${date}`).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(solved).toBeGreaterThan(0);
    });
    it("finds a slot beyond 366 already occupied tasks", () => {
      const tasks: Task[] = Array.from({ length: 370 }, (_, i) => ({
        id: `t${String(i).padStart(3, "0")}`, category: "dev", assignee: "alice",
        start: "2026-11-02", end: "2026-11-02"
      }));
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.adjustments).toHaveLength(369);
    }, 20000);
    it("allows partial allocations to share capacity while moving only the excess", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", assignee: "alice", priority: "high", allocation: 0.6, start: "2026-11-02", end: "2026-11-03" },
        { id: "b", category: "dev", assignee: "alice", priority: "low", allocation: 0.6, start: "2026-11-02", end: "2026-11-03" },
        { id: "c", category: "dev", assignee: "alice", priority: "medium", allocation: 0.4, start: "2026-11-02", end: "2026-11-03" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks.find((t) => t.id === "a")?.start).toBe("2026-11-02");
      expect(result.tasks.find((t) => t.id === "c")?.start).toBe("2026-11-02");
      expect(result.tasks.find((t) => t.id === "b")?.start).toBe("2026-11-04");
    });
    it.each([[1], [1, 1, 1, 1, 1, 1, 1]] as const)("uses an earlier gap in a long task's intermittent calendar", (...workingDays) => {
      const tasks: Task[] = [
        { id: "a", assignee: "alice", start: "2026-11-02", end: "2026-11-30", calendar: { workingDays }, locked: true },
        { id: "b", assignee: "alice", start: "2026-11-02", end: "2026-11-02", calendar: "continuous" },
        { id: "c", start: "2026-11-04", end: "2026-11-04", locked: true, dependsOn: "b:FF+0d" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 1 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks.find((task) => task.id === "b")?.start).toBe("2026-11-03");
      expect(result.tasks.find((task) => task.id === "c")?.start).toBe("2026-11-04");
    });
    it.each(["standard", { id: "other-name", workingDays: [5, 4, 3, 2, 1] }] as const)("finds a slot after a long booking on an equivalent working calendar", (calendar) => {
      const tasks: Task[] = [
        { id: "a", assignee: "alice", start: "2026-11-02", end: "2028-11-02", calendar: "standard", locked: true },
        { id: "b", assignee: "alice", start: "2026-11-02", end: "2026-11-02", calendar: typeof calendar === "string" ? calendar : { ...calendar, workingDays: [...calendar.workingDays] } }
      ];
      const result = levelResources(tasks, { defaultGapDays: 1 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks.find((task) => task.id === "b")?.start).toBe("2028-11-03");
    });
    it("searches past a long booking when calendars differ only after it ends", () => {
      const tasks: Task[] = [
        { id: "a", assignee: "alice", start: "2026-11-02", end: "2028-11-02", calendar: { workingDays: [1, 2, 3, 4, 5], holidays: ["2029-01-01"] }, locked: true },
        { id: "b", assignee: "alice", start: "2026-11-02", end: "2026-11-02", calendar: "standard" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 1 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks.find((task) => task.id === "b")?.start).toBe("2028-11-03");
    });
    it("keeps mixed relationships and calendars valid while resolving multiple resources", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", assignee: "alice", priority: "high", start: "2026-11-02", end: "2026-11-04" },
        { id: "b", category: "dev", assignee: "alice", start: "2026-11-02", end: "2026-11-04", dependsOn: "a:SS+0d" },
        { id: "c", category: "dev", assignee: "bob", start: "2026-11-02", end: "2026-11-05", dependsOn: "b:FF+1d" },
        { id: "d", category: "dev", assignee: "bob", priority: "high", start: "2026-11-06", end: "2026-11-09" }
      ];
      const people = [{ id: "alice", name: "Alice", calendar: "standard" }, { id: "bob", name: "Bob", calendar: "continuous" }];
      const result = levelResources(tasks, { people, defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      const resolved = resolveSchedule(result.tasks, 0, { people });
      expect(resolved.map((t) => [t.start, t.end])).toEqual(result.tasks.map((t) => [t.start, t.end]));
      expect(result.tasks.find((t) => t.id === "c")!.end >= "2026-11-10").toBe(true);
    });
    it("finds distinct slots for a large group sharing one resource", () => {
      const tasks: Task[] = Array.from({ length: 60 }, (_, i) => ({
        id: `t${String(i).padStart(2, "0")}`, category: "dev", assignee: "alice",
        start: "2026-11-02", end: "2026-11-03"
      }));
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.adjustments).toHaveLength(59);
      expect(result.unresolvedReasons).toEqual([]);
    });
    it("does not repeatedly defer a predecessor and cascade its conflicting successor", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", assignee: "alice", priority: "low", start: "2026-11-02", end: "2026-11-04" },
        { id: "b", category: "dev", assignee: "alice", priority: "high", start: "2026-11-04", end: "2026-11-05", dependsOn: "a:FS+0d" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toHaveLength(0);
      expect(result.adjustments).toHaveLength(1);
      expect(result.adjustments[0].taskId).toBe("b");
      expect(result.tasks.find((t) => t.id === "a")?.start).toBe("2026-11-02");
      expect(result.tasks.find((t) => t.id === "b")?.start).toBe("2026-11-05");
    });
    it("resolves dependencies even when the initial schedule has no resource conflict", () => {
      const tasks: Task[] = [
        { id: "a", start: "2026-11-02", end: "2026-11-03" },
        { id: "b", start: "2026-11-02", end: "2026-11-03", dependsOn: "a:FS+1d" },
        { id: "deleted", start: "2026-11-02", end: "2026-11-03", _deleted: true }
      ];
      const result = levelResources(tasks);
      expect(result.tasks.find((task) => task.id === "b")?.start).toBe("2026-11-04");
      expect(result.tasks.find((task) => task.id === "deleted")?._deleted).toBe(true);
      expect(result.remainingOverallocations).toEqual([]);
    });

    it("reports cycles and incompatible locked tasks even without resource conflicts", () => {
      const tasks: Task[] = [
        { id: "a", start: "2026-11-02", end: "2026-11-04" },
        { id: "b", start: "2026-11-02", end: "2026-11-03", dependsOn: "a", locked: true }
      ];
      expect(levelResources(tasks).unresolvedReasons?.[0]).toMatch(/locked.*violates/i);
      const cyclic = [{ ...tasks[0], dependsOn: "b" }, tasks[1]];
      const result = levelResources(cyclic);
      expect(result.unresolvedReasons?.[0]).toMatch(/circular/i);
      expect(result.tasks).toEqual(cyclic);
    });
    it("continues resolving other resources after an impossible overload", () => {
      const tasks: Task[] = [
        { id: "a", assignee: "alice", allocation: 2, start: "2026-11-02", end: "2026-11-03" },
        { id: "b", assignee: "bob", start: "2026-11-02", end: "2026-11-03" },
        { id: "c", assignee: "bob", start: "2026-11-02", end: "2026-11-03" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.adjustments.some((adjustment) => adjustment.resourceId === "bob")).toBe(true);
      expect(result.remainingOverallocations.every((allocation) => allocation.resourceId === "alice")).toBe(true);
      expect(result.unresolvedReasons?.some((reason) => reason.includes("alice"))).toBe(true);
    });
    it("moves an individually assigned task to a period when the resource is available", () => {
      const tasks: Task[] = [{ id: "a", assignee: "alice", calendar: "continuous", start: "2026-11-06", end: "2026-11-07" }];
      const result = levelResources(tasks, { people: [{ id: "alice", name: "Alice", calendar: "standard" }] });
      expect(result.remainingOverallocations).toEqual([]);
      expect(result.tasks[0]).toMatchObject({ start: "2026-11-09", end: "2026-11-10" });
    });
    it("chooses another task when delaying the preferred candidate would break a locked successor", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", assignee: "alice", priority: "high", start: "2026-11-02", end: "2026-11-03" },
        { id: "b", category: "dev", assignee: "alice", priority: "low", start: "2026-11-02", end: "2026-11-03" },
        { id: "c", category: "dev", locked: true, start: "2026-11-03", end: "2026-11-04", dependsOn: "b:FS+0d" }
      ];
      const result = levelResources(tasks, { defaultGapDays: 0 });
      expect(result.remainingOverallocations).toHaveLength(0);
      expect(result.adjustments[0].taskId).toBe("a");
      expect(result.tasks.find((t) => t.id === "c")?.start).toBe("2026-11-03");
    });
    it("reports an overload that delaying cannot solve", () => {
      const tasks: Task[] = [{ id: "a", category: "dev", assignee: "alice", start: "2026-11-06", end: "2026-11-09", allocation: 2 }];
      const result = levelResources(tasks);
      expect(result.remainingOverallocations.length).toBeGreaterThan(0);
      expect(result.unresolvedReasons?.[0]).toMatch(/exceeds capacity/);
    });

    it("keeps the working calendar while moving a task and cascading its successor", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", assignee: "alice", priority: "high", start: "2026-11-05", end: "2026-11-06" },
        { id: "b", category: "dev", assignee: "alice", start: "2026-11-05", end: "2026-11-06" },
        { id: "c", category: "dev", start: "2026-11-06", end: "2026-11-09", dependsOn: "b:FS+1d" }
      ];
      const result = levelResources(tasks, { calendar: "standard", defaultGapDays: 1 });
      expect(result.remainingOverallocations).toHaveLength(0);
      expect(result.tasks.find((t) => t.id === "b")?.start).toBe("2026-11-09");
      expect(result.tasks.find((t) => t.id === "c")?.start).toBe("2026-11-11");
    });
    it("levels concurrent tasks by shifting the lower priority task", () => {
      const tasks: Task[] = [
        {
          id: "t1",
          label: "Critical Backend Architecture",
          category: "dev",
          assignee: "alice",
          priority: "urgent",
          start: "2026-11-02",
          end: "2026-11-05" // 3 days
        },
        {
          id: "t2",
          label: "Minor UI Cleanup",
          category: "dev",
          assignee: "alice",
          priority: "low",
          start: "2026-11-03",
          end: "2026-11-06"
        }
      ];

      const result = levelResources(tasks, { defaultGapDays: 1 });

      expect(result.adjustments).toHaveLength(1);
      const adj = result.adjustments[0];
      expect(adj.taskId).toBe("t2");
      expect(adj.delayDays).toBeGreaterThan(0);

      // t1 should remain unchanged
      const t1Leveled = result.tasks.find((t) => t.id === "t1")!;
      expect(t1Leveled.start).toBe("2026-11-02");
      expect(t1Leveled.end).toBe("2026-11-05");

      // t2 should start after t1 ends + 1 gap day: 2026-11-05 + 1 = 2026-11-06
      const t2Leveled = result.tasks.find((t) => t.id === "t2")!;
      expect(t2Leveled.start).toBe("2026-11-06");

      // No over-allocations should remain
      expect(result.remainingOverallocations).toHaveLength(0);
    });

    it("honors locked tasks and shifts non-locked task even if locked task has lower priority", () => {
      const tasks: Task[] = [
        {
          id: "t1",
          label: "Fixed Contractor Slot",
          category: "dev",
          assignee: "alice",
          locked: true,
          priority: "low",
          start: "2026-11-02",
          end: "2026-11-05"
        },
        {
          id: "t2",
          label: "Urgent Task",
          category: "dev",
          assignee: "alice",
          priority: "urgent",
          start: "2026-11-03",
          end: "2026-11-06"
        }
      ];

      const result = levelResources(tasks, { defaultGapDays: 1 });

      const t1 = result.tasks.find((t) => t.id === "t1")!;
      expect(t1.start).toBe("2026-11-02"); // Locked task never moves

      const t2 = result.tasks.find((t) => t.id === "t2")!;
      expect(t2.start).toBe("2026-11-06"); // Shifted to after t1
    });

    it("cascades downstream dependencies of leveled tasks", () => {
      const tasks: Task[] = [
        {
          id: "t1",
          category: "dev",
          assignee: "alice",
          priority: "high",
          start: "2026-11-01",
          end: "2026-11-05"
        },
        {
          id: "t2",
          category: "dev",
          assignee: "alice",
          priority: "low",
          start: "2026-11-02",
          end: "2026-11-04"
        },
        {
          id: "t3",
          category: "qa",
          assignee: "bob",
          dependsOn: "t2",
          start: "2026-11-05",
          end: "2026-11-07"
        }
      ];

      const result = levelResources(tasks, { defaultGapDays: 1 });

      const t2 = result.tasks.find((t) => t.id === "t2")!;
      // t1 ends Nov 5. t2 shifted to Nov 6 - Nov 8 (duration 2 days)
      expect(t2.start).toBe("2026-11-06");
      expect(t2.end).toBe("2026-11-08");

      // t3 depends on t2. It must be cascaded to start after t2 ends (Nov 8 + 1 = Nov 9)
      const t3 = result.tasks.find((t) => t.id === "t3")!;
      expect(t3.start).toBe("2026-11-09");
      expect(t3.end).toBe("2026-11-11");
    });

    it("supports working days and calendars when leveling", () => {
      const tasks: Task[] = [
        {
          id: "t1",
          category: "dev",
          assignee: "alice",
          start: "2026-11-04", // Wednesday
          end: "2026-11-06" // Friday
        },
        {
          id: "t2",
          category: "dev",
          assignee: "alice",
          start: "2026-11-05",
          end: "2026-11-06"
        }
      ];

      const result = levelResources(tasks, {
        defaultGapDays: 1,
        useWorkingDays: true,
        calendar: CALENDAR_PRESETS.standard
      });

      const t2 = result.tasks.find((t) => t.id === "t2")!;
      // t1 ends Friday Nov 6. +1 working day gap -> starts Monday Nov 9!
      expect(t2.start).toBe("2026-11-09");
    });
  });
});
