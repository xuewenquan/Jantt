/**
 * Critical Path Method (CPM) Engine
 *
 * Implements rigorous 2-pass Activity-On-Node (AON) graph analysis:
 * 1. Kahn's Algorithm topological sort with cycle detection
 * 2. Forward Pass: Computes Earliest Start (ES) and Earliest Finish (EF)
 * 3. Backward Pass: Computes Latest Finish (LF) and Latest Start (LS)
 * 4. Float Metrics: Total Float (TF) and Free Float (FF)
 * 5. Critical & Near-Critical identification
 * 6. Driving critical dependency link detection and contiguous path assembly
 */

import { Task, CriticalPathResult, CriticalPathOptions, TaskScheduleMetrics } from "./types";
import { addDays, diffDays, isValidISODate } from "./date-math";
import { getTaskDependencyRelations, dependencyRelationKey, getRelationLag, DependencyRelation } from "./dependencies";
import { resolvePersonById } from "./team-resolver";
import { addWorkingDays, calendarRulesSignature, diffWorkingDays, getNextWorkingDay, getPreviousWorkingDay, isWorkingDay, resolveTaskCalendar, WorkingCalendar, CalendarError } from "./calendar";

/**
 * Normalizes task dependencies into a clean string array.
 * Supports string, string[], comma-separated, or structured object formats.
 */
export function getTaskDependencies(task: Task | { dependsOn?: unknown }): string[] {
  return getTaskDependencyRelations(task).map((rel) => rel.id);
}

/**
 * Calculates the Critical Path of a task network using rigorous 2-Pass Activity-On-Node (AON)
 * operations research methodology:
 *
 * @param tasks - The array of tasks to analyze.
 * @param options - Optional target completion date, near-critical float threshold, and gap days.
 * @returns Complete CriticalPathResult with sets, metrics maps, and ordered paths.
 */
export function calculateCriticalPath(tasks: Task[], options?: CriticalPathOptions): CriticalPathResult {
  try {
    if (options?.targetDate !== undefined && (typeof options.targetDate !== "string" || (options.targetDate.trim() && !isValidISODate(options.targetDate)))) {
      throw new CalendarError("Invalid target date; expected a valid YYYY-MM-DD date.");
    }
    return calculateCriticalPathInternal(tasks, options);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    return { criticalTaskIds: new Set(), criticalDepKeys: new Set(), criticalRelationKeys: new Set(), nearCriticalTaskIds: new Set(), projectEarlyFinish: "", projectLateFinish: "", projectTotalFloat: 0, criticalPaths: [], metrics: new Map(), errors: [error.message] };
  }
}

function calculateCriticalPathInternal(tasks: Task[], options?: CriticalPathOptions): CriticalPathResult {
  const criticalTaskIds = new Set<string>();
  const criticalDepKeys = new Set<string>();
  const criticalRelationKeys = new Set<string>();
  const criticalPairs = new Map<string, [string, string]>();
  const nearCriticalTaskIds = new Set<string>();
  const metrics = new Map<string, TaskScheduleMetrics>();
  const criticalPaths: string[][] = [];

  const liveTasks = (tasks || []).filter((t) => !t._deleted);

  if (liveTasks.length === 0) {
    return {
      criticalTaskIds,
      criticalDepKeys,
      criticalRelationKeys,
      nearCriticalTaskIds,
      projectEarlyFinish: "",
      projectLateFinish: "",
      projectTotalFloat: 0,
      criticalPaths,
      metrics
    };
  }

  const byId = new Map<string, Task>();
  const predMap = new Map<string, string[]>();
  const succMap = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const durationMap = new Map<string, number>();
  const relationsMap = new Map<string, DependencyRelation[]>();
  const calendars = new Map<string, WorkingCalendar | undefined>();
  const calendarSignatures = new Map<string, string>();

  liveTasks.forEach((t) => {
    byId.set(t.id, t);
    predMap.set(t.id, []);
    succMap.set(t.id, []);
    inDegree.set(t.id, 0);
    const person = resolvePersonById(options?.people, t.assignee);
    const useCalendar = Boolean(options?.useWorkingDays || options?.calendar || t.calendar || t.calendarId || person?.calendar || person?.calendarId);
    const calendar = useCalendar ? resolveTaskCalendar(t, {
      people: options?.people, calendars: options?.calendars, defaultCalendar: options?.calendar
    }) : undefined;
    calendars.set(t.id, calendar);
    calendarSignatures.set(t.id, calendarRulesSignature(calendar));
    const dur = Math.max(0, calendar ? diffWorkingDays(t.start, t.end, calendar) : diffDays(t.start, t.end));
    durationMap.set(t.id, dur);
  });

  // Build clean graph edges
  liveTasks.forEach((t) => {
    const relations = getTaskDependencyRelations(t).filter((rel) => rel.id !== t.id && byId.has(rel.id));
    relationsMap.set(t.id, relations);
    const validDeps = relations.map((rel) => rel.id);
    predMap.set(t.id, validDeps);
    inDegree.set(t.id, validDeps.length);

    validDeps.forEach((depId) => {
      succMap.get(depId)!.push(t.id);
    });
  });

  // 1. Topological Sort via Kahn's Algorithm
  const queue: string[] = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  const topologicalOrder: string[] = [];
  const inDegreeCopy = new Map(inDegree);

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const currId = queue[queueIndex];
    topologicalOrder.push(currId);

    const succs = succMap.get(currId) || [];
    for (const sId of succs) {
      const remaining = inDegreeCopy.get(sId)! - 1;
      inDegreeCopy.set(sId, remaining);
      if (remaining === 0) {
        queue.push(sId);
      }
    }
  }

  // Express each dependency as successor start >= predecessor start + offset.
  const edgeOffset = (successor: Task, relation: DependencyRelation): number => {
    const lag = getRelationLag(relation, successor, options?.defaultGapDays ?? 0);
    const predDuration = durationMap.get(relation.id)!;
    const succDuration = durationMap.get(successor.id)!;
    return lag + (relation.type === "FS" || relation.type === "FF" ? predDuration : 0)
      - (relation.type === "FF" || relation.type === "SF" ? succDuration : 0);
  };

  const addTaskDays = (id: string, date: string, days: number): string => {
    const calendar = calendars.get(id);
    return calendar ? addWorkingDays(date, days, calendar) : addDays(date, days);
  };
  const previousTaskDay = (id: string, date: string): string => {
    const calendar = calendars.get(id);
    return calendar ? getPreviousWorkingDay(date, calendar) : date;
  };
  const taskDifference = (id: string, start: string, end: string): number => {
    const calendar = calendars.get(id);
    return calendar ? diffWorkingDays(start, end, calendar) : diffDays(start, end);
  };
  const earliestSuccessor = (successor: Task, relation: DependencyRelation, predecessorStart: string): string => {
    if (!calendars.get(successor.id) && !calendars.get(relation.id)) {
      return addDays(predecessorStart, edgeOffset(successor, relation));
    }
    const predDate = relation.type === "FS" || relation.type === "FF"
      ? addTaskDays(relation.id, predecessorStart, durationMap.get(relation.id)!) : predecessorStart;
    const lag = getRelationLag(relation, successor, options?.defaultGapDays ?? 0);
    const anchor = addTaskDays(successor.id, predDate, lag);
    return relation.type === "FF" || relation.type === "SF"
      ? addTaskDays(successor.id, anchor, -durationMap.get(successor.id)!) : anchor;
  };

  // Invert a monotonic date constraint. Snapping is necessary when the two
  // tasks use different calendars, where subtracting a lag is not its inverse.
  const latestFeasibleStart = (id: string, reference: string, feasible: (date: string) => boolean): string => {
    const test = (offset: number) => {
      const candidate = addDays(reference, offset);
      if (!isValidISODate(candidate)) return false;
      try {
        return feasible(previousTaskDay(id, candidate));
      } catch (error) {
        if (error instanceof CalendarError) return false;
        throw error;
      }
    };
    let low = 0;
    let high = 0;
    let step = 1;
    if (test(0)) {
      while (step < 131072 && test(step)) { low = step; step *= 2; }
      high = step;
    } else {
      // Only date-specific failures below the supported range are infeasible;
      // do not eagerly probe the calendar near year 1000.
      const minOffset = Math.max(diffDays(reference, "1000-01-01"), -131072);
      low = Math.max(-step, minOffset);
      while (step < 131072 && !test(low) && low > minOffset) {
        high = low;
        step *= 2;
        low = Math.max(-step, minOffset);
      }
    }
    if (!test(low) || test(high)) throw new CalendarError(`Cannot determine a feasible date for task '${id}'`);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (test(middle)) low = middle; else high = middle;
    }
    return previousTaskDay(id, addDays(reference, low));
  };

  // A cyclic network has no valid topological CPM calculation.
  if (topologicalOrder.length < liveTasks.length) {
    return { criticalTaskIds, criticalDepKeys, criticalRelationKeys, nearCriticalTaskIds, projectEarlyFinish: "", projectLateFinish: "", projectTotalFloat: 0, criticalPaths, metrics, errors: ["Circular dependency cycle detected in schedule graph."] };
  }

  // 2. Forward Pass: Compute ES and EF
  const earlyStartMap = new Map<string, string>();
  const earlyFinishMap = new Map<string, string>();
  const drivingPredsMap = new Map<string, string[]>();

  for (const taskId of topologicalOrder) {
    const task = byId.get(taskId)!;
    const preds = predMap.get(taskId) || [];
    const dur = durationMap.get(taskId)!;
    const relations = relationsMap.get(taskId) || [];

    const calendar = calendars.get(taskId);
    let calculatedES = calendar ? getNextWorkingDay(task.start, calendar) : task.start;

    if (preds.length > 0) {
      let maxCandidateES: string | null = null;
      for (const rel of relations) {
        const predES = earlyStartMap.get(rel.id) || byId.get(rel.id)!.start;
        const candidateES = earliestSuccessor(task, rel, predES);
        if (!maxCandidateES || diffDays(maxCandidateES, candidateES) > 0) {
          maxCandidateES = candidateES;
        }
      }
      if (maxCandidateES && diffDays(calculatedES, maxCandidateES) > 0) {
        calculatedES = maxCandidateES;
      }
    }

    // Determine driving predecessors
    const drivingPreds: string[] = [];
    if (preds.length > 0) {
      for (const rel of relations) {
        const predES = earlyStartMap.get(rel.id) || byId.get(rel.id)!.start;
        const expectedES = earliestSuccessor(task, rel, predES);
        if (diffDays(expectedES, calculatedES) === 0) {
          drivingPreds.push(rel.id);
        }
      }
    }

    earlyStartMap.set(taskId, calculatedES);
    earlyFinishMap.set(taskId, addTaskDays(taskId, calculatedES, dur));
    drivingPredsMap.set(taskId, drivingPreds);
  }

  // Determine Project Early Finish (T_E)
  let projectEarlyFinish = earlyFinishMap.get(liveTasks[0].id)!;
  liveTasks.forEach((t) => {
    const ef = earlyFinishMap.get(t.id) || t.end;
    if (diffDays(projectEarlyFinish, ef) > 0) {
      projectEarlyFinish = ef;
    }
  });

  // 3. Backward Pass: Compute LF and LS
  // Target date support (enables negative float when contractual deadline is breached)
  const projectLateFinish = options?.targetDate && options.targetDate.trim() !== ""
    ? options.targetDate.trim()
    : projectEarlyFinish;

  const lateFinishMap = new Map<string, string>();
  const lateStartMap = new Map<string, string>();

  // Process in reverse topological order
  const reversedOrder = [...topologicalOrder].reverse();

  const sameCalendarRules = (a: string, b: string) => Boolean(calendars.get(a) && calendars.get(b))
    && calendarSignatures.get(a) === calendarSignatures.get(b);

  for (const taskId of reversedOrder) {
    const succs = succMap.get(taskId) || [];
    const dur = durationMap.get(taskId)!;
    const taskCalendar = calendars.get(taskId);

    {
      let minCandidateLS = !taskCalendar
        ? addDays(projectLateFinish, -dur)
        : isWorkingDay(projectLateFinish, taskCalendar)
          ? addTaskDays(taskId, projectLateFinish, -dur)
          : latestFeasibleStart(taskId, earlyStartMap.get(taskId)!, (start) => addTaskDays(taskId, start, dur) <= projectLateFinish);
      for (const sId of new Set(succs)) {
        const succTask = byId.get(sId)!;
        const succLS = lateStartMap.get(sId)!;
        for (const rel of relationsMap.get(sId)!.filter((r) => r.id === taskId)) {
          const candidateLS = sameCalendarRules(taskId, sId)
            ? addTaskDays(taskId, succLS, -edgeOffset(succTask, rel))
            : calendars.get(taskId) || calendars.get(sId)
              ? latestFeasibleStart(taskId, earlyStartMap.get(taskId)!, (start) => earliestSuccessor(succTask, rel, start) <= succLS)
              : addDays(succLS, -edgeOffset(succTask, rel));
          if (diffDays(candidateLS, minCandidateLS) > 0) minCandidateLS = candidateLS;
        }
      }
      lateStartMap.set(taskId, minCandidateLS);
      lateFinishMap.set(taskId, addTaskDays(taskId, minCandidateLS, dur));
    }

  }

  // 4. Compute Total Float (TF) & Free Float (FF)
  const totalFloatMap = new Map<string, number>();
  const freeFloatMap = new Map<string, number>();
  let minTotalFloat = Infinity;

  liveTasks.forEach((t) => {
    const es = earlyStartMap.get(t.id)!;
    const ls = lateStartMap.get(t.id)!;
    const tf = taskDifference(t.id, es, ls);
    totalFloatMap.set(t.id, tf);
    if (tf < minTotalFloat) {
      minTotalFloat = tf;
    }

    // Free float measures delay without moving any successor or the early finish.
    const succs = succMap.get(t.id) || [];
    {
      const duration = durationMap.get(t.id)!;
      const taskCalendar = calendars.get(t.id);
      const projectLimit = !taskCalendar
        ? addDays(projectEarlyFinish, -duration)
        : isWorkingDay(projectEarlyFinish, taskCalendar)
          ? addTaskDays(t.id, projectEarlyFinish, -duration)
          : latestFeasibleStart(t.id, es, (start) => addTaskDays(t.id, start, duration) <= projectEarlyFinish);
      let minSuccGap = taskDifference(t.id, es, projectLimit);
      for (const sId of new Set(succs)) {
        const succTask = byId.get(sId)!;
        const succES = earlyStartMap.get(sId)!;
        for (const rel of relationsMap.get(sId)!.filter((r) => r.id === t.id)) {
          const allowedStart = sameCalendarRules(t.id, sId)
            ? addTaskDays(t.id, succES, -edgeOffset(succTask, rel))
            : calendars.get(t.id) || calendars.get(sId)
              ? latestFeasibleStart(t.id, es, (start) => earliestSuccessor(succTask, rel, start) <= succES)
              : addDays(succES, -edgeOffset(succTask, rel));
          const ffDelta = taskDifference(t.id, es, allowedStart);
          if (ffDelta < minSuccGap) minSuccGap = ffDelta;
        }
      }
      freeFloatMap.set(t.id, Math.max(0, minSuccGap));
    }
  });

  const projectTotalFloat = minTotalFloat === Infinity ? 0 : minTotalFloat;

  // 5. Critical & Near-Critical Classification
  const nearCriticalThreshold = options?.nearCriticalThresholdDays ?? 3;

  liveTasks.forEach((t) => {
    const tf = totalFloatMap.get(t.id)!;
    const isCritical = tf <= 0 || tf === minTotalFloat;
    const isNearCritical = !isCritical && tf - Math.min(0, minTotalFloat) <= nearCriticalThreshold;

    if (isCritical) {
      criticalTaskIds.add(t.id);
    } else if (isNearCritical) {
      nearCriticalTaskIds.add(t.id);
    }

    let slackLabel = `${tf}d buffer`;
    if (tf < 0) {
      slackLabel = `Overdue by ${Math.abs(tf)}d`;
    } else if (tf === 0) {
      slackLabel = "0d (Critical)";
    }

    metrics.set(t.id, {
      taskId: t.id,
      earlyStart: earlyStartMap.get(t.id)!,
      earlyFinish: earlyFinishMap.get(t.id)!,
      lateStart: lateStartMap.get(t.id)!,
      lateFinish: lateFinishMap.get(t.id)!,
      totalFloat: tf,
      freeFloat: freeFloatMap.get(t.id)!,
      isCritical,
      isNearCritical,
      drivingPredecessors: drivingPredsMap.get(t.id) || [],
      slackLabel
    });
  });

  // 6. Identify Driving Critical Dependency Links (A -> B)
  liveTasks.forEach((t) => {
    if (!criticalTaskIds.has(t.id)) return;
    const tES = earlyStartMap.get(t.id)!;
    (relationsMap.get(t.id) || []).forEach((rel) => {
      const pId = rel.id;
      if (criticalTaskIds.has(pId)) {
        const drivingDate = earliestSuccessor(t, rel, earlyStartMap.get(pId)!);
        if (diffDays(drivingDate, tES) === 0) {
          criticalDepKeys.add(`${pId}->${t.id}`);
          criticalRelationKeys.add(dependencyRelationKey(pId, t.id, rel));
          criticalPairs.set(JSON.stringify([pId, t.id]), [pId, t.id]);
        }
      }
    });
  });

  // 7. Assemble Contiguous Critical Path Sequences
  const criticalIncoming = new Map<string, number>();
  criticalTaskIds.forEach((id) => criticalIncoming.set(id, 0));
  criticalPairs.forEach(([, to]) => {
    if (criticalIncoming.has(to)) {
      criticalIncoming.set(to, criticalIncoming.get(to)! + 1);
    }
  });

  const criticalStartNodes: string[] = [];
  criticalIncoming.forEach((count, id) => {
    if (count === 0) criticalStartNodes.push(id);
  });

  const criticalAdj = new Map<string, string[]>();
  criticalTaskIds.forEach((id) => criticalAdj.set(id, []));
  criticalPairs.forEach(([from, to]) => {
    if (criticalAdj.has(from)) {
      criticalAdj.get(from)!.push(to);
    }
  });

  const limit = Number.isFinite(options?.maxCriticalPaths) ? Math.max(1, Math.floor(options!.maxCriticalPaths!)) : 1000;
  let criticalPathsTruncated = false;
  for (const startId of criticalStartNodes) {
    const path = [startId];
    const stack = [{ id: startId, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const nexts = criticalAdj.get(frame.id) || [];
      if (nexts.length === 0 && frame.next === 0) {
        if (criticalPaths.length === limit) { criticalPathsTruncated = true; break; }
        criticalPaths.push([...path]);
        frame.next++;
      } else if (frame.next < nexts.length) {
        const next = nexts[frame.next++];
        path.push(next);
        stack.push({ id: next, next: 0 });
      } else {
        stack.pop();
        path.pop();
      }
    }
    if (criticalPathsTruncated) break;
  }

  return {
    criticalTaskIds,
    criticalDepKeys,
    criticalRelationKeys,
    nearCriticalTaskIds,
    projectEarlyFinish,
    projectLateFinish,
    projectTotalFloat,
    criticalPaths,
    criticalPathsTruncated,
    metrics
  };
}
