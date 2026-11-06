import { Task } from "../../types";
import { addDays, diffDays } from "../../date-math";
import { getTaskDependencyRelations, getRelationLag } from "../../dependencies";
import { resolveTaskCalendar, addWorkingDays, diffWorkingDays, getNextWorkingDay, CalendarError } from "../../calendar";
import { IPipelineStage, PipelineContext } from "../contracts";
import { calculateCriticalPath } from "../../cpm";
import { resolvePersonById } from "../../team-resolver";

/**
 * CascadeResolveStage:
 * Implements coordinated multi-predecessor pacing:
 * 1. Enterprise 4-Type Dependency Relationships:
 *    - FS (Finish-to-Start)
 *    - SS (Start-to-Start)
 *    - FF (Finish-to-Finish)
 *    - SF (Start-to-Finish)
 *    with positive/negative lead & lag support.
 * 2. Multi-Calendar & Statutory Holiday awareness:
 *    Skips non-working days and holidays when a working calendar is active.
 * 3. Honors locked tasks (`locked: true`).
 */
export class CascadeResolveStage implements IPipelineStage<Task[], Task[]> {
  public readonly name = "CascadeResolveStage";

  public process(tasks: Task[], context: PipelineContext): Task[] {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return [];
    }
    const liveTasks = tasks.filter((t) => !t._deleted);
    if (liveTasks.length === 0) {
      return [];
    }

    const ids = new Set(liveTasks.map((t) => t.id));
    const pending = new Map(liveTasks.map((t) => [t.id, getTaskDependencyRelations(t).filter((r) => r.id !== t.id && ids.has(r.id)).length]));
    const successors = new Map(liveTasks.map((t) => [t.id, [] as string[]]));
    for (const task of liveTasks) for (const rel of getTaskDependencyRelations(task)) if (rel.id !== task.id) successors.get(rel.id)?.push(task.id);
    const queue = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
    for (let i = 0; i < queue.length; i++) for (const id of successors.get(queue[i]) || []) {
      const count = pending.get(id)! - 1;
      pending.set(id, count);
      if (count === 0) queue.push(id);
    }
    if (queue.length < liveTasks.length) {
      const error = "Circular dependency cycle detected in schedule graph.";
      if (!context.diagnostics?.includes(error)) context.diagnostics?.push(error);
      return tasks.map((task) => ({ ...task }));
    }

    const defaultGapDays = context.defaultGapDays;
    const globalUseWorking = Boolean(context.useWorkingDays || context.calendar);

    // Pure deep clone of tasks ensuring nested objects (baseline, fields, dependsOn) are not mutated
    const byId = Object.fromEntries(
      liveTasks.map((t) => [
        t.id,
        {
          ...t,
          start: t.start,
          end: t.end,
          baseline: t.baseline ? { ...t.baseline } : undefined,
          fields: t.fields ? { ...t.fields } : undefined,
          dependsOn: Array.isArray(t.dependsOn) ? [...t.dependsOn] : t.dependsOn
        }
      ])
    );

    // Normalize task starts before applying dependency constraints.
    for (const t of Object.values(byId)) {
      const person = resolvePersonById(context.people, t.assignee);
      if (!t.locked && (globalUseWorking || t.calendar || t.calendarId || person?.calendar || person?.calendarId)) {
        const cal = resolveTaskCalendar(t, { people: context.people, calendars: context.calendars, defaultCalendar: context.calendar });
        const duration = Math.max(diffWorkingDays(t.start, t.end, cal), 0);
        t.start = getNextWorkingDay(t.start, cal);
        t.end = addWorkingDays(t.start, duration, cal);
      }
    }

    // Every predecessor has been resolved before its successors in this order.
    for (const id of queue) {
      const t = byId[id];
      if (t.locked) continue;

      const person = resolvePersonById(context.people, t.assignee);
      const isTaskWorkingCal = globalUseWorking || Boolean(t.calendar || t.calendarId || person?.calendar || person?.calendarId);
      const taskCal = isTaskWorkingCal
        ? resolveTaskCalendar(t, {
            people: context.people,
            calendars: context.calendars,
            defaultCalendar: context.calendar
          })
        : null;

      // Filter self-dependencies and dangling links
      const relations = getTaskDependencyRelations(t).filter((rel) => rel.id !== t.id && Boolean(byId[rel.id]));
      let calculatedMinStart: string | null = null;

      if (relations.length > 0) {
        const duration = taskCal
          ? Math.max(diffWorkingDays(t.start, t.end, taskCal), 0)
          : Math.max(diffDays(t.start, t.end), 0);

        for (const rel of relations) {
          const prereq = byId[rel.id];
          if (!prereq) continue;

          const lag = getRelationLag(rel, t, defaultGapDays);
          let minForThisDep: string;

          if (taskCal) {
            switch (rel.type) {
              case "SS":
                minForThisDep = addWorkingDays(prereq.start, lag, taskCal);
                break;
              case "FF":
                minForThisDep = addWorkingDays(addWorkingDays(prereq.end, lag, taskCal), -duration, taskCal);
                break;
              case "SF":
                minForThisDep = addWorkingDays(addWorkingDays(prereq.start, lag, taskCal), -duration, taskCal);
                break;
              case "FS":
              default:
                minForThisDep = addWorkingDays(prereq.end, lag, taskCal);
                break;
            }
          } else {
            switch (rel.type) {
              case "SS":
                minForThisDep = addDays(prereq.start, lag);
                break;
              case "FF":
                minForThisDep = addDays(addDays(prereq.end, lag), -duration);
                break;
              case "SF":
                minForThisDep = addDays(addDays(prereq.start, lag), -duration);
                break;
              case "FS":
              default:
                minForThisDep = addDays(prereq.end, lag);
                break;
            }
          }

          if (!calculatedMinStart || diffDays(calculatedMinStart, minForThisDep) > 0) {
            calculatedMinStart = minForThisDep;
          }
        }
      }

      if (calculatedMinStart && diffDays(t.start, calculatedMinStart) > 0) {
        if (taskCal) {
          const duration = Math.max(diffWorkingDays(t.start, t.end, taskCal), 0);
          t.start = calculatedMinStart;
          t.end = addWorkingDays(calculatedMinStart, duration, taskCal);
        } else {
          const duration = Math.max(diffDays(t.start, t.end), 0);
          t.start = calculatedMinStart;
          t.end = addDays(calculatedMinStart, duration);
        }
      }
    }
    const result = tasks.map((orig) => byId[orig.id] || { ...orig });
    if (context.diagnostics && result.some((task) => task.locked)) {
      const cpm = calculateCriticalPath(result, context);
      for (const task of result) {
        if (!task.locked) continue;
        const earlyStart = cpm.metrics.get(task.id)?.earlyStart;
        if (!earlyStart) continue;
        const person = resolvePersonById(context.people, task.assignee);
        const hasCalendar = Boolean(context.useWorkingDays || context.calendar || task.calendar || task.calendarId || person?.calendar || person?.calendarId);
        let calendar;
        try {
          calendar = hasCalendar
            ? resolveTaskCalendar(task, { people: context.people, calendars: context.calendars, defaultCalendar: context.calendar })
            : undefined;
        } catch (error) {
          if (error instanceof CalendarError) continue;
          throw error;
        }
        const baseline = calendar ? getNextWorkingDay(task.start, calendar) : task.start;
        if (earlyStart > baseline) {
          context.diagnostics.push(`Locked task '${task.id}' violates a dependency constraint.`);
        }
      }
    }
    return result;
  }
}
