import { describe, it, expect } from "vitest";
import {
  createCalendar,
  isWorkingDay,
  addWorkingDays,
  diffWorkingDays,
  getNextWorkingDay,
  getPreviousWorkingDay,
  getWorkingDaysInRange,
  getStatutoryHolidays,
  resolveTaskCalendar,
  CALENDAR_PRESETS
} from "../src/calendar";
import { CascadeResolveStage } from "../src/pipeline/stages/cascade-resolve-stage";
import { calculateCriticalPath, resolveSchedule } from "../src/resolver";
import { SchedulePipeline } from "../src/pipeline/schedule-pipeline";
import { addDays, diffDays } from "../src/date-math";
import { getTaskDependencyRelations } from "../src/dependencies";
import type { Task, Person, WorkingCalendar } from "../src/types";

describe("Multi-Calendar & Statutory Holiday Matrix", () => {
  describe("calendar-aware critical path", () => {
    it("satisfies every relationship in mixed-calendar dependency networks", () => {
      let seed = 0x12345678;
      const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
      const types = ["FS", "SS", "FF", "SF"] as const;
      for (let scenario = 0; scenario < 12; scenario++) {
        const tasks: Task[] = [];
        for (let i = 0; i < 12; i++) {
          const calendar = random(2) ? "standard" : "continuous";
          const start = addWorkingDays("2026-11-02", random(4), calendar);
          const end = addWorkingDays(start, 1 + random(4), calendar);
          const dependsOn = i ? Array.from({ length: 1 + random(Math.min(i, 3)) }, () => ({
            id: `t${random(i)}`, type: types[random(4)], lagDays: random(5) - 2
          })) : undefined;
          tasks.push({ id: `t${i}`, category: "dev", start, end, calendar, dependsOn });
        }
        tasks.reverse();
        const scheduled = resolveSchedule(tasks, 0);
        const result = calculateCriticalPath(tasks, { defaultGapDays: 0 });
        expect(result.errors).toBeUndefined();
        const actual = new Map(scheduled.map((task) => [task.id, task]));
        for (const task of tasks) {
          const metric = result.metrics.get(task.id)!;
          expect([metric.earlyStart, metric.earlyFinish]).toEqual([actual.get(task.id)!.start, actual.get(task.id)!.end]);
          expect(metric.lateFinish <= result.projectEarlyFinish).toBe(true);
          expect(metric.totalFloat).toBeGreaterThanOrEqual(0);
          for (const rel of getTaskDependencyRelations(task)) {
            const predecessor = result.metrics.get(rel.id)!;
            for (const pass of ["early", "late"] as const) {
              const predDate = rel.type[0] === "F" ? predecessor[`${pass}Finish`] : predecessor[`${pass}Start`];
              const succDate = rel.type[1] === "F" ? metric[`${pass}Finish`] : metric[`${pass}Start`];
              expect(succDate >= addWorkingDays(predDate, rel.lagDays, task.calendar as "standard" | "continuous"), `${scenario}: ${rel.id} ${rel.type} ${task.id} ${pass}`).toBe(true);
            }
          }
        }
      }
    });
    it.each(["FS", "SS", "FF", "SF"] as const)("matches enumerated feasible dates for mixed-calendar %s constraints", (type) => {
      for (const lag of [-1, 0, 2]) {
        const tasks: Task[] = [
          { id: "a", start: "2026-11-02", end: "2026-11-04", calendar: "standard" },
          { id: "b", start: "2026-11-01", end: "2026-11-03", calendar: "continuous", dependsOn: [{ id: "a", type, lag }] }
        ];
        const result = calculateCriticalPath(tasks);
        const dates = Array.from({ length: 50 }, (_, i) => addDays("2026-10-20", i));
        const predFinish = (start: string) => addWorkingDays(start, 2, CALENDAR_PRESETS.standard);
        const succFinish = (start: string) => addDays(start, 2);
        const satisfies = (a: string, b: string) => {
          const predecessor = type[0] === "F" ? predFinish(a) : a;
          const successor = type[1] === "F" ? succFinish(b) : b;
          return successor >= addDays(predecessor, lag);
        };
        const esB = dates.find((date) => date >= tasks[1].start && satisfies(tasks[0].start, date))!;
        const finish = [tasks[0].end, succFinish(esB)].sort().at(-1)!;
        const lsB = dates.filter((date) => succFinish(date) <= finish).at(-1)!;
        const validPredecessors = dates.filter((date) => isWorkingDay(date, CALENDAR_PRESETS.standard) && predFinish(date) <= finish);
        const lsA = validPredecessors.filter((date) => satisfies(date, lsB)).at(-1)!;
        const freeA = validPredecessors.filter((date) => satisfies(date, esB)).at(-1)!;
        expect(result.metrics.get("b")?.earlyStart, `${type} ${lag} ES`).toBe(esB);
        expect(result.metrics.get("a")?.lateStart, `${type} ${lag} LS`).toBe(lsA);
        expect(result.metrics.get("a")?.freeFloat, `${type} ${lag} FF`).toBe(diffWorkingDays(tasks[0].start, freeA, CALENDAR_PRESETS.standard));
      }
    });

    it.each(["FS", "SS", "FF", "SF"] as const)("matches enumeration when the successor uses the working calendar for %s", (type) => {
      for (const lag of [-1, 0, 2]) {
        const tasks: Task[] = [
          { id: "a", start: "2026-11-02", end: "2026-11-04", calendar: "continuous" },
          { id: "b", start: "2026-11-02", end: "2026-11-04", calendar: "standard", dependsOn: [{ id: "a", type, lag }] }
        ];
        const result = calculateCriticalPath(tasks);
        const dates = Array.from({ length: 60 }, (_, i) => addDays("2026-10-20", i));
        const predFinish = (start: string) => addDays(start, 2);
        const succFinish = (start: string) => addWorkingDays(start, 2, CALENDAR_PRESETS.standard);
        const satisfies = (a: string, b: string) => {
          const predecessor = type[0] === "F" ? predFinish(a) : a;
          const successor = type[1] === "F" ? succFinish(b) : b;
          return successor >= addWorkingDays(predecessor, lag, CALENDAR_PRESETS.standard);
        };
        const workingDates = dates.filter((date) => isWorkingDay(date, CALENDAR_PRESETS.standard));
        const esB = workingDates.find((date) => date >= tasks[1].start && satisfies(tasks[0].start, date))!;
        const finish = [tasks[0].end, succFinish(esB)].sort().at(-1)!;
        const lsB = workingDates.filter((date) => succFinish(date) <= finish).at(-1)!;
        const validPredecessors = dates.filter((date) => predFinish(date) <= finish);
        const lsA = validPredecessors.filter((date) => satisfies(date, lsB)).at(-1)!;
        const freeA = validPredecessors.filter((date) => satisfies(date, esB)).at(-1)!;
        expect(result.metrics.get("b")?.earlyStart, `${type} ${lag} ES`).toBe(esB);
        expect(result.metrics.get("a")?.lateStart, `${type} ${lag} LS`).toBe(lsA);
        expect(result.metrics.get("a")?.freeFloat, `${type} ${lag} FF`).toBe(diffDays(tasks[0].start, freeA));
      }
    });
    it("respects a holiday and weekend in the forward and backward passes", () => {
      const calendar: WorkingCalendar = { ...CALENDAR_PRESETS.standard, holidays: ["2026-11-09"] };
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-11-04", end: "2026-11-06" },
        { id: "B", category: "dev", start: "2026-11-05", end: "2026-11-06", dependsOn: "A:FS+1d" }
      ];
      const options = { calendar, defaultGapDays: 0 };
      const result = calculateCriticalPath(tasks, options);
      expect(result.metrics.get("B")).toMatchObject({ earlyStart: "2026-11-10", earlyFinish: "2026-11-11", lateStart: "2026-11-10", totalFloat: 0 });
      expect(result.metrics.get("A")).toMatchObject({ lateStart: "2026-11-04", lateFinish: "2026-11-06", totalFloat: 0 });
      expect(result.criticalDepKeys.has("A->B")).toBe(true);
      expect(resolveSchedule(tasks, 0, { calendar })[1].end).toBe("2026-11-11");
      const pipeline = SchedulePipeline.createDefault({ includeCriticalPath: true }).execute(tasks, options);
      expect(pipeline.context.options?.cpmResult.projectEarlyFinish).toBe("2026-11-11");
    });

    it.each(["FS", "SS", "FF", "SF"] as const)("matches enumerated %s constraints across different holiday calendars", (type) => {
      const predCalendar: WorkingCalendar = { ...CALENDAR_PRESETS.standard, holidays: ["2026-11-09"] };
      const succCalendar: WorkingCalendar = { ...CALENDAR_PRESETS.compressed_4x10, holidays: ["2026-11-10"] };
      for (const lag of [-2, 0, 2]) {
        const tasks: Task[] = [
          { id: "a", start: "2026-11-05", end: "2026-11-10", calendar: predCalendar },
          { id: "b", start: "2026-11-02", end: "2026-11-04", calendar: succCalendar, dependsOn: [{ id: "a", type, lag }] }
        ];
        const result = calculateCriticalPath(tasks);
        const dates = Array.from({ length: 90 }, (_, i) => addDays("2026-10-01", i));
        const predFinish = (start: string) => addWorkingDays(start, 2, predCalendar);
        const succFinish = (start: string) => addWorkingDays(start, 2, succCalendar);
        const satisfies = (a: string, b: string) => {
          const predecessor = type[0] === "F" ? predFinish(a) : a;
          const successor = type[1] === "F" ? succFinish(b) : b;
          return successor >= addWorkingDays(predecessor, lag, succCalendar);
        };
        const succDays = dates.filter((date) => isWorkingDay(date, succCalendar));
        const esB = succDays.find((date) => date >= tasks[1].start && satisfies(tasks[0].start, date))!;
        const finish = [tasks[0].end, succFinish(esB)].sort().at(-1)!;
        const lsB = succDays.filter((date) => succFinish(date) <= finish).at(-1)!;
        const predDays = dates.filter((date) => isWorkingDay(date, predCalendar) && predFinish(date) <= finish);
        const lsA = predDays.filter((date) => satisfies(date, lsB)).at(-1)!;
        const freeA = predDays.filter((date) => satisfies(date, esB)).at(-1)!;
        expect(result.errors).toBeUndefined();
        expect(result.metrics.get("b")?.earlyStart, `${type} ${lag} ES`).toBe(esB);
        expect(result.metrics.get("a")?.lateStart, `${type} ${lag} LS`).toBe(lsA);
        expect(result.metrics.get("a")?.freeFloat, `${type} ${lag} FF`).toBe(diffWorkingDays(tasks[0].start, freeA, predCalendar));
      }
    });

    it("inverts constraints across different task calendars", () => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-11-04", end: "2026-11-06", calendar: "standard" },
        { id: "B", category: "dev", start: "2026-11-04", end: "2026-11-05", calendar: "continuous", dependsOn: "A:FS+2d" }
      ];
      const result = calculateCriticalPath(tasks);
      expect(result.metrics.get("B")).toMatchObject({ earlyStart: "2026-11-08", earlyFinish: "2026-11-09", totalFloat: 0 });
      expect(result.metrics.get("A")).toMatchObject({ lateStart: "2026-11-04", totalFloat: 0 });
      expect(resolveSchedule(tasks, 0)[1].start).toBe("2026-11-08");
    });

    it.each(["FS", "SS", "FF", "SF"] as const)("keeps %s cascading and CPM consistent across calendars", (type) => {
      const tasks: Task[] = [
        { id: "A", category: "dev", start: "2026-11-06", end: "2026-11-10", calendar: "standard" },
        { id: "B", category: "dev", start: "2026-11-01", end: "2026-11-03", calendar: "continuous", dependsOn: [{ id: "A", type, lag: 1 }] }
      ];
      const resolved = resolveSchedule(tasks, 0);
      const result = calculateCriticalPath(tasks);
      expect(result.metrics.get("B")!.earlyStart).toBe(resolved[1].start);
      expect(result.metrics.get("B")!.earlyFinish).toBe(resolved[1].end);
      expect(result.metrics.get("A")!.lateStart >= result.metrics.get("A")!.earlyStart).toBe(true);
    });
  });
  describe("Presets and Working Day checks", () => {
    it("does not truncate long working-day calculations", () => {
      const start = "2000-01-03";
      const end = addDays(start, 12000);
      expect(addWorkingDays(start, 6000, "continuous")).toBe(addDays(start, 6000));
      expect(diffWorkingDays(start, end, "continuous")).toBe(12000);
      expect(getWorkingDaysInRange(start, addDays(start, 6000), "continuous")).toHaveLength(6001);
    });

    it("counts very long ranges arithmetically without scanning each day", () => {
      const started = Date.now();
      expect(diffWorkingDays("1000-01-01", "9999-12-31", "standard")).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("rejects an oversized working-day offset promptly", () => {
      expect(() => addWorkingDays("2026-01-01", 999999999, "standard")).toThrow(/Cannot add/);
    });

    it("calculates critical path at the maximum supported date", () => {
      const result = calculateCriticalPath([{ id: "a", start: "9999-12-31", end: "9999-12-31", calendar: "standard" }]);
      expect(result.errors || []).toEqual([]);
      expect(result.metrics.get("a")?.earlyStart).toBe("9999-12-31");
    });

    it("reports a calendar with no working days instead of returning a non-working date", () => {
      expect(() => getNextWorkingDay("2026-11-02", { workingDays: [] })).toThrow(/No working day/);
      expect(() => addWorkingDays("2026-11-02", 1, { workingDays: [] })).toThrow(/Cannot add/);
      const result = calculateCriticalPath([{ id: "a", start: "2026-11-02", end: "2026-11-03", calendar: { workingDays: [] } }]);
      expect(result.errors?.[0]).toMatch(/No working day/);
      expect(result.metrics.size).toBe(0);
      expect(result.criticalRelationKeys?.size).toBe(0);
    });
    it("identifies weekends as non-working days in standard calendar", () => {
      const cal = createCalendar("standard");
      // 2026-11-06 is Friday, 2026-11-07 is Saturday, 2026-11-08 is Sunday, 2026-11-09 is Monday
      expect(isWorkingDay("2026-11-06", cal)).toBe(true);
      expect(isWorkingDay("2026-11-07", cal)).toBe(false);
      expect(isWorkingDay("2026-11-08", cal)).toBe(false);
      expect(isWorkingDay("2026-11-09", cal)).toBe(true);
    });

    it("continuous 24/7 calendar considers all 7 days as working", () => {
      const cal = createCalendar("continuous");
      expect(isWorkingDay("2026-11-07", cal)).toBe(true); // Saturday
      expect(isWorkingDay("2026-11-08", cal)).toBe(true); // Sunday
    });

    it("compressed 4x10 calendar treats Friday through Sunday as non-working", () => {
      const cal = createCalendar("compressed_4x10");
      expect(isWorkingDay("2026-11-05", cal)).toBe(true); // Thursday
      expect(isWorkingDay("2026-11-06", cal)).toBe(false); // Friday
      expect(isWorkingDay("2026-11-07", cal)).toBe(false); // Saturday
      expect(isWorkingDay("2026-11-08", cal)).toBe(false); // Sunday
    });

    it("honors custom exceptions (e.g. working weekend shift or extra holiday)", () => {
      const cal = createCalendar({
        workingDays: [1, 2, 3, 4, 5],
        exceptions: [
          { date: "2026-11-07", isWorkingDay: true, name: "Overtime Saturday" },
          { date: "2026-11-09", isWorkingDay: false, name: "Floating Monday Off" }
        ]
      });

      expect(isWorkingDay("2026-11-07", cal)).toBe(true); // Saturday override
      expect(isWorkingDay("2026-11-09", cal)).toBe(false); // Monday override
    });
  });

  describe("Statutory Regional Holiday Matrix", () => {
    it("generates US statutory holidays with accurate dates and observances", () => {
      const holidays2026 = getStatutoryHolidays("US", 2026);
      const dates = holidays2026.map((h) => h.date);

      // New Year's Day (Jan 1)
      expect(dates).toContain("2026-01-01");
      // MLK Day (3rd Mon of Jan)
      expect(dates).toContain("2026-01-19");
      // Memorial Day (Last Mon of May)
      expect(dates).toContain("2026-05-25");
      // Juneteenth (June 19)
      expect(dates).toContain("2026-06-19");
      // Independence Day (July 4 2026 is Saturday -> observed Friday July 3)
      expect(dates).toContain("2026-07-03");
      // Labor Day (1st Mon of Sep)
      expect(dates).toContain("2026-09-07");
      // Thanksgiving (4th Thu of Nov)
      expect(dates).toContain("2026-11-26");
      // Christmas (Dec 25)
      expect(dates).toContain("2026-12-25");
    });

    it("generates UK bank holidays including Good Friday, Easter Monday, and Summer Bank Holiday", () => {
      const holidays2026 = getStatutoryHolidays("UK", 2026);
      const dates = holidays2026.map((h) => h.date);

      // In 2026, Easter Sunday is April 5
      // Good Friday: April 3, Easter Monday: April 6
      expect(dates).toContain("2026-04-03");
      expect(dates).toContain("2026-04-06");
      // Early May Bank Holiday (First Mon of May)
      expect(dates).toContain("2026-05-04");
      // Spring Bank Holiday (Last Mon of May)
      expect(dates).toContain("2026-05-25");
      // Summer Bank Holiday (Last Mon of August)
      expect(dates).toContain("2026-08-31");
      // Christmas & Boxing Day
      expect(dates).toContain("2026-12-25");
      expect(dates).toContain("2026-12-28"); // Observed because Dec 26 is Saturday
    });
  });

  describe("addWorkingDays & diffWorkingDays", () => {
    it("snaps non-working days forward when adding 0 working days", () => {
      const cal = createCalendar("standard");
      // Saturday 2026-11-07 snaps to Monday 2026-11-09
      expect(addWorkingDays("2026-11-07", 0, cal)).toBe("2026-11-09");
      // Monday 2026-11-09 stays Monday
      expect(addWorkingDays("2026-11-09", 0, cal)).toBe("2026-11-09");
    });

    it("steps forward skipping weekends accurately", () => {
      const cal = createCalendar("standard");
      // Friday + 1 working day = Monday
      expect(addWorkingDays("2026-11-06", 1, cal)).toBe("2026-11-09");
      // Friday + 3 working days = Wednesday
      expect(addWorkingDays("2026-11-06", 3, cal)).toBe("2026-11-11");
    });

    it("steps forward skipping regional holidays and weekends", () => {
      const cal = createCalendar({
        region: "US",
        workingDays: [1, 2, 3, 4, 5]
      });
      // 2026-11-25 is Wednesday.
      // 2026-11-26 is Thanksgiving (Holiday)
      // 2026-11-27 is Friday (Working day)
      // 2026-11-28 is Sat, 2026-11-29 is Sun
      // 2026-11-30 is Monday
      // Wednesday + 1 working day -> Friday (skipping Thanksgiving)
      expect(addWorkingDays("2026-11-25", 1, cal)).toBe("2026-11-27");
      // Wednesday + 2 working days -> Monday (skipping Thanksgiving and weekend)
      expect(addWorkingDays("2026-11-25", 2, cal)).toBe("2026-11-30");
    });

    it("steps backward subtracting working days", () => {
      const cal = createCalendar("standard");
      // Monday - 1 working day = Friday
      expect(addWorkingDays("2026-11-09", -1, cal)).toBe("2026-11-06");
      // Monday - 3 working days = Wednesday
      expect(addWorkingDays("2026-11-09", -3, cal)).toBe("2026-11-04");
    });

    it("calculates diffWorkingDays correctly across weekends and holidays", () => {
      const cal = createCalendar({
        region: "US",
        workingDays: [1, 2, 3, 4, 5]
      });

      // Mon to Fri in normal week: 4 working days
      expect(diffWorkingDays("2026-11-02", "2026-11-06", cal)).toBe(4);
      // Fri to Mon: 1 working day
      expect(diffWorkingDays("2026-11-06", "2026-11-09", cal)).toBe(1);
      // Mon to Mon (1 full week): 5 working days
      expect(diffWorkingDays("2026-11-02", "2026-11-09", cal)).toBe(5);

      // Over Thanksgiving week: 2026-11-23 (Mon) to 2026-11-30 (Mon):
      // Tue(1), Wed(2), Thu(Holiday-0), Fri(3), Mon(4) -> 4 working days instead of 5!
      expect(diffWorkingDays("2026-11-23", "2026-11-30", cal)).toBe(4);

      // Inverted direction
      expect(diffWorkingDays("2026-11-09", "2026-11-06", cal)).toBe(-1);
    });

    it("extracts list of all working days in range", () => {
      const cal = createCalendar("standard");
      const days = getWorkingDaysInRange("2026-11-05", "2026-11-10", cal);
      // Thu, Fri, Mon, Tue
      expect(days).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"]);
    });

    it("getNextWorkingDay and getPreviousWorkingDay return boundary dates safely", () => {
      const cal = createCalendar("standard");
      expect(getNextWorkingDay("2026-11-07", cal)).toBe("2026-11-09");
      expect(getPreviousWorkingDay("2026-11-07", cal)).toBe("2026-11-06");
      expect(getNextWorkingDay("2026-11-06", cal)).toBe("2026-11-06");
    });
  });

  describe("Hierarchical Calendar Resolution", () => {
    it("reports unknown calendar references instead of silently using a fallback", () => {
      const task: Task = { id: "a", start: "2026-11-02", end: "2026-11-03", calendarId: "missing" };
      expect(() => resolveTaskCalendar(task)).toThrow(/unknown calendar.*missing/i);
      expect(calculateCriticalPath([task]).errors?.[0]).toMatch(/unknown calendar.*missing/i);
      expect(() => resolveTaskCalendar({ ...task, calendarId: undefined, assignee: "alice" }, {
        people: [{ id: "alice", name: "Alice", calendarId: "missing" }]
      })).toThrow(/unknown calendar.*missing/i);
    });
    const defaultCal: WorkingCalendar = { id: "global", workingDays: [1, 2, 3, 4, 5] };
    const personCal: WorkingCalendar = { id: "night-shift", workingDays: [1, 2, 3, 4] };
    const taskCal: WorkingCalendar = { id: "continuous", workingDays: [0, 1, 2, 3, 4, 5, 6] };

    const people: Person[] = [
      { id: "p1", name: "Alice", calendar: personCal },
      { id: "p2", name: "Bob" }
    ];

    it("prefers explicit task calendar over assignee and global calendar", () => {
      const task: Task = {
        id: "t1",
        category: "dev",
        start: "2026-11-01",
        end: "2026-11-05",
        assignee: "p1",
        calendar: taskCal
      };
      const resolved = resolveTaskCalendar(task, { people, defaultCalendar: defaultCal });
      expect(resolved.workingDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("falls back to assignee calendar if task has no calendar", () => {
      const task: Task = {
        id: "t2",
        category: "dev",
        start: "2026-11-01",
        end: "2026-11-05",
        assignee: "p1"
      };
      const resolved = resolveTaskCalendar(task, { people, defaultCalendar: defaultCal });
      expect(resolved.workingDays).toEqual([1, 2, 3, 4]);
    });

    it("falls back to global default calendar if assignee has no calendar", () => {
      const task: Task = {
        id: "t3",
        category: "dev",
        start: "2026-11-01",
        end: "2026-11-05",
        assignee: "p2"
      };
      const resolved = resolveTaskCalendar(task, { people, defaultCalendar: defaultCal });
      expect(resolved.id).toBe("global");
    });
  });

  describe("CascadeResolveStage Calendar Integration", () => {
    it("skips weekends when useWorkingDays is enabled in pipeline context", () => {
      const stage = new CascadeResolveStage();
      const tasks: Task[] = [
        {
          id: "t1",
          category: "dev",
          start: "2026-11-04", // Wednesday
          end: "2026-11-06" // Friday (2 working days duration)
        },
        {
          id: "t2",
          category: "qa",
          start: "2026-11-05",
          end: "2026-11-06",
          dependsOn: "t1" // Lag 1 working day -> Starts Monday 2026-11-09!
        }
      ];

      const resolved = stage.process(tasks, {
        defaultGapDays: 1,
        useWorkingDays: true,
        calendar: CALENDAR_PRESETS.standard
      });

      const t2 = resolved.find((t) => t.id === "t2")!;
      // t1 ends Friday Nov 6. +1 working day gap -> starts Monday Nov 9!
      expect(t2.start).toBe("2026-11-09");
      expect(t2.end).toBe("2026-11-10");
    });

    it("preserves standard calendar day behavior when no working calendar is requested", () => {
      const stage = new CascadeResolveStage();
      const tasks: Task[] = [
        {
          id: "t1",
          category: "dev",
          start: "2026-11-04",
          end: "2026-11-06"
        },
        {
          id: "t2",
          category: "qa",
          start: "2026-11-05",
          end: "2026-11-06",
          dependsOn: "t1"
        }
      ];

      // Standard calendar day arithmetic: Nov 6 + 1 day = Nov 7 (Saturday)
      const resolved = stage.process(tasks, { defaultGapDays: 1 });
      const t2 = resolved.find((t) => t.id === "t2")!;
      expect(t2.start).toBe("2026-11-07");
    });
  });
});
