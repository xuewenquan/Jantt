/**
 * Autonomous Resource Leveling Heuristic Engine
 *
 * Resolves resource over-allocations across concurrent tasks using
 * Operations Research heuristics, Critical Path Method (CPM) total float,
 * task priorities, and dependency-preserving cascading.
 * Strictly zero external dependencies.
 */

import { Task, CriticalPathResult, Person, CalendarPreset } from "./types";
import { addDays, diffDays, isValidISODate } from "./date-math";
import { calculateCriticalPath } from "./cpm";
import { resolveSchedule } from "./resolver";
import { DEFAULT_GAP_DAYS } from "./constants";
import { WorkingCalendar, CalendarError, addWorkingDays, calendarRulesSignature, diffWorkingDays, getNextWorkingDay, isWorkingDay, resolveTaskCalendar } from "./calendar";
import { resolvePersonById } from "./team-resolver";

export interface ResourceAllocation {
  resourceId: string;
  date: string; // YYYY-MM-DD
  tasks: string[]; // Task IDs active on this date
  totalUnits: number; // Sum of allocation units (e.g. 2.0 = 200%)
  capacity: number; // Max allowed units (default 1.0)
  isOverallocated: boolean;
}

export interface LevelingAdjustment {
  taskId: string;
  resourceId: string;
  previousStart: string;
  previousEnd: string;
  newStart: string;
  newEnd: string;
  delayDays: number;
  reason: string;
  withinFloat: boolean;
}

export interface ResourceLevelingOptions {
  /** Maximum units a resource can be assigned per day before being overallocated (default: 1.0). */
  defaultCapacity?: number;
  /** Custom per-resource capacity limits, e.g. { "alice": 0.5 } for part-time (default: 1.0). */
  resourceCapacities?: Record<string, number>;
  /** Default gap days between tasks when shifting (default: 2). */
  defaultGapDays?: number;
  /** Contractual completion date used for float-based prioritization. */
  targetDate?: string;
  /** Whether working days should be respected during shifts. */
  useWorkingDays?: boolean;
  /** Working calendar to respect during shifts. */
  calendar?: WorkingCalendar | CalendarPreset;
  calendars?: Record<string, WorkingCalendar>;
  people?: Person[];
  /** Maximum leveling passes (default: twice the task count, between 50 and 1000). */
  maxIterations?: number;
}

export interface LevelingResult {
  tasks: Task[];
  adjustments: LevelingAdjustment[];
  initialOverallocations: ResourceAllocation[];
  remainingOverallocations: ResourceAllocation[];
  projectDurationChanged: boolean;
  daysAdded: number;
  unresolvedReasons?: string[];
}

function taskCalendar(task: Task, options?: ResourceLevelingOptions): WorkingCalendar | undefined {
  const person = resolvePersonById(options?.people, task.assignee);
  if (!(options?.useWorkingDays || options?.calendar || task.calendar || task.calendarId || person?.calendar || person?.calendarId)) return undefined;
  return resolveTaskCalendar(task, { people: options?.people, calendars: options?.calendars, defaultCalendar: options?.calendar });
}

function resourceCalendar(task: Task, options?: ResourceLevelingOptions): WorkingCalendar | undefined {
  const person = resolvePersonById(options?.people, task.assignee);
  if (!person?.calendar && !person?.calendarId) return undefined;
  return resolveTaskCalendar({ ...task, calendar: undefined, calendarId: undefined }, {
    people: options?.people, calendars: options?.calendars, defaultCalendar: options?.calendar
  });
}

/** A locked task only violates dependencies when its early start is later than
 * its own calendar-normalized start; starting on a non-working day is not a
 * dependency violation. */
function hasLockedViolation(task: Task, cpm: CriticalPathResult, options?: ResourceLevelingOptions): boolean {
  if (!task.locked) return false;
  const calendar = taskCalendar(task, options);
  const baseline = calendar ? getNextWorkingDay(task.start, calendar) : task.start;
  const earlyStart = cpm.metrics.get(task.id)?.earlyStart;
  return Boolean(earlyStart && earlyStart > baseline);
}

function availabilitySearchAllowance(calendar?: WorkingCalendar): number {
  return 366 + 7 * ((calendar?.holidays?.length || 0) + (calendar?.exceptions?.length || 0));
}

function mayHaveInactiveDays(calendar?: WorkingCalendar): boolean {
  if (!calendar) return false;
  const days = new Set<number>(calendar.workingDays ?? [1, 2, 3, 4, 5]);
  return [0, 1, 2, 3, 4, 5, 6].some((day) => !days.has(day)) || Boolean(calendar.holidays?.length || calendar.exceptions?.length || calendar.region);
}

function resourceCapacity(resourceId: string, options?: ResourceLevelingOptions): number {
  const person = resolvePersonById(options?.people, resourceId);
  return options?.resourceCapacities?.[resourceId]
    ?? (person ? options?.resourceCapacities?.[person.id] ?? options?.resourceCapacities?.[person.name] : undefined)
    ?? options?.defaultCapacity ?? 1;
}

function exceedsCapacity(units: number, capacity: number): boolean {
  return units > capacity && units - capacity > Number.EPSILON * Math.max(Math.abs(units), Math.abs(capacity)) * 8;
}

function taskResourceId(task: Task, options?: ResourceLevelingOptions): string | undefined {
  if (!task.assignee) return undefined;
  return resolvePersonById(options?.people, task.assignee)?.id || task.assignee;
}

const PRIORITY_SCORES: Record<string, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1
};

/**
 * Extracts the allocation units requested by a task (default: 1.0).
 */
export function getTaskAllocationUnits(task: Task): number {
  if (typeof task.allocation === "number" && !isNaN(task.allocation)) {
    return Math.max(0, task.allocation);
  }
  if (
    task.fields &&
    typeof task.fields.allocation === "number" &&
    !isNaN(task.fields.allocation)
  ) {
    return Math.max(0, task.fields.allocation);
  }
  return 1.0;
}

/**
 * Detects all dates where a resource's total workload exceeds their capacity.
 */
export function detectOverAllocations(
  tasks: Task[],
  options?: ResourceLevelingOptions
): ResourceAllocation[] {
  const liveTasks = (tasks || []).filter((t) => !t._deleted && t.assignee);
  if (liveTasks.length === 0) return [];

  // Group tasks by assignee
  const tasksByResource = new Map<string, Task[]>();
  for (const t of liveTasks) {
    const res = taskResourceId(t, options)!;
    if (!tasksByResource.has(res)) {
      tasksByResource.set(res, []);
    }
    tasksByResource.get(res)!.push(t);
  }

  const overallocations: ResourceAllocation[] = [];
  const calendars = new Map(liveTasks.map((task) => [task.id, taskCalendar(task, options)]));

  for (const [resourceId, resTasks] of tasksByResource.entries()) {
    const capacity = resourceCapacity(resourceId, options);
    const availability = resourceCalendar(resTasks[0], options);

    // Find date boundary for this resource
    let minDate = resTasks[0].start;
    let maxDate = resTasks[0].end;
    for (const t of resTasks) {
      if (t.start < minDate) minDate = t.start;
      if (t.end > maxDate) maxDate = t.end;
    }

    let curr = minDate;
    while (isValidISODate(curr) && diffDays(curr, maxDate) >= 0) {
      const activeTasks: string[] = [];
      let totalUnits = 0;
      let compensation = 0;

      for (const t of resTasks) {
        // Task is active if start <= curr <= end
        const cal = calendars.get(t.id);
        if (t.start <= curr && curr <= t.end && (!cal || isWorkingDay(curr, cal))) {
          const units = getTaskAllocationUnits(t);
          if (units > 0) {
            activeTasks.push(t.id);
            const corrected = units - compensation;
            const sum = totalUnits + corrected;
            compensation = (sum - totalUnits) - corrected;
            totalUnits = sum;
          }
        }
      }

      const availableCapacity = availability && !isWorkingDay(curr, availability) ? 0 : capacity;
      if (exceedsCapacity(totalUnits, availableCapacity)) {
        overallocations.push({
          resourceId,
          date: curr,
          tasks: activeTasks,
          totalUnits,
          capacity: availableCapacity,
          isOverallocated: true
        });
      }

      if (curr === maxDate) break;
      curr = addDays(curr, 1);
    }
  }

  // Sort overallocations chronologically
  overallocations.sort((a, b) => a.date.localeCompare(b.date));
  return overallocations;
}

/**
 * Determines precedence between two conflicting tasks.
 * Returns negative if task A should proceed before task B.
 */
function compareLevelingPrecedence(
  a: Task,
  b: Task,
  cpm: CriticalPathResult
): number {
  // 1. Locked / milestone tasks cannot be deferred
  if (a.locked && !b.locked) return -1;
  if (!a.locked && b.locked) return 1;
  if (a.milestone && !b.milestone) return -1;
  if (!a.milestone && b.milestone) return 1;

  // 2. Priority ranking (urgent > high > medium > low)
  const aPrio = PRIORITY_SCORES[a.priority || "medium"] ?? 2;
  const bPrio = PRIORITY_SCORES[b.priority || "medium"] ?? 2;
  if (aPrio !== bPrio) {
    return bPrio - aPrio; // Higher score first
  }

  // 3. Critical path tasks have 0 total float and must not be deferred
  const aMetrics = cpm.metrics.get(a.id);
  const bMetrics = cpm.metrics.get(b.id);
  const aCritical = aMetrics?.isCritical ?? false;
  const bCritical = bMetrics?.isCritical ?? false;
  if (aCritical && !bCritical) return -1;
  if (!aCritical && bCritical) return 1;

  // 4. CPM Total Float: Smaller float has less flexibility
  const aFloat = aMetrics?.totalFloat ?? 0;
  const bFloat = bMetrics?.totalFloat ?? 0;
  if (aFloat !== bFloat) {
    return aFloat - bFloat; // Smaller float first
  }

  // 5. Scheduled start date (earlier start first)
  const startDiff = a.start.localeCompare(b.start);
  if (startDiff !== 0) return startDiff;

  // 6. Tie breaker
  return a.id.localeCompare(b.id);
}

/**
 * Computes project finish date (max end date across all live tasks).
 */
function getProjectFinish(tasks: Task[]): string {
  let finish = "";
  for (const t of tasks) {
    if (!t._deleted && (!finish || diffDays(finish, t.end) > 0)) {
      finish = t.end;
    }
  }
  return finish;
}

/** Find a forward slot that does not overload the candidate's resource. */
function findResourceSlot(candidate: Task, tasks: Task[], anchor: Task, gap: number, options?: ResourceLevelingOptions): { start: string; end: string } | null {
  const resourceId = taskResourceId(candidate, options);
  if (!resourceId || exceedsCapacity(getTaskAllocationUnits(candidate), resourceCapacity(resourceId, options))) return null;
  const calendar = taskCalendar(candidate, options);
  const duration = calendar ? Math.max(diffWorkingDays(candidate.start, candidate.end, calendar), 0) : Math.max(diffDays(candidate.start, candidate.end), 0);
  const advance = (date: string, days: number) => {
    try {
      const result = calendar ? addWorkingDays(date, days, calendar) : addDays(date, days);
      return isValidISODate(result) ? result : "";
    } catch (error) {
      if (error instanceof CalendarError) return "";
      throw error;
    }
  };
  const rules = calendarRulesSignature(calendar);
  const canHaveGap = (task: Task) => {
    const otherCalendar = taskCalendar(task, options);
    return mayHaveInactiveDays(otherCalendar) && calendarRulesSignature(otherCalendar) !== rules;
  };
  const anchorStart = canHaveGap(anchor) ? anchor.start : anchor.end;
  let start = advance(anchorStart > candidate.start ? anchorStart : candidate.start, Math.max(1, gap));
  if (!start) return null;
  const others = tasks.filter((t) => t.id !== candidate.id && taskResourceId(t, options) === resourceId);
  // Scanning a finite booking does not consume the allowance for resource
  // unavailability; each such step advances toward that booking's end.
  for (let search = 0; search < others.length + availabilitySearchAllowance(resourceCalendar(candidate, options));) {
    const end = advance(start, duration);
    if (!end) return null;
    const shifted = { ...candidate, start, end };
    const overlapping = others.filter((t) => t.start <= end && t.end >= start).map((t) => ({
      ...t, start: t.start < start ? start : t.start, end: t.end > end ? end : t.end
    }));
    const conflict = detectOverAllocations([shifted, ...overlapping], options).find((item) => item.tasks.includes(candidate.id));
    if (!conflict) return { start, end };
    const blockers = others.filter((t) => conflict.tasks.includes(t.id));
    const earliestEnd = blockers.map((t) => t.end).sort()[0];
    const hasIntermittentBlocker = blockers.some(canHaveGap);
    const next = earliestEnd && !hasIntermittentBlocker ? advance(earliestEnd, Math.max(1, gap)) : advance(start, 1);
    if (!next) return null;
    if (!hasIntermittentBlocker) search++;
    start = next > start ? next : advance(start, 1);
  }
  return null;
}

/**
 * Autonomous Resource Leveling Heuristic.
 *
 * Iteratively shifts non-critical, lower-priority tasks when resource over-allocations occur,
 * attempting to preserve milestone gates and project completion within available CPM float.
 */
export function levelResources(
  tasks: Task[],
  options?: ResourceLevelingOptions
): LevelingResult {
  const liveTasks = (tasks || []).filter((t) => !t._deleted);
  const restoreDeleted = (updated: Task[]) => {
    const byId = new Map(updated.map((task) => [task.id, task]));
    return (tasks || []).map((task) => task._deleted ? { ...task } : byId.get(task.id) || { ...task });
  };
  if (liveTasks.length === 0) {
    return {
      tasks: restoreDeleted([]),
      adjustments: [],
      initialOverallocations: [],
      remainingOverallocations: [],
      projectDurationChanged: false,
      daysAdded: 0
    };
  }

  const initialFinish = getProjectFinish(liveTasks);
  const initialOverallocations = detectOverAllocations(liveTasks, options);
  const defaultGap = options?.defaultGapDays ?? DEFAULT_GAP_DAYS;
  const maxIterations = options?.maxIterations ?? Math.min(1000, Math.max(50, liveTasks.length * 2));
  const scheduleOptions = { useWorkingDays: options?.useWorkingDays, calendar: options?.calendar, calendars: options?.calendars, people: options?.people };
  const cpmOptions = { ...scheduleOptions, defaultGapDays: defaultGap, targetDate: options?.targetDate, maxCriticalPaths: 1 };
  const unresolvedReasons: string[] = [];
  const rejectedConflicts = new Map<string, string>();
  const previousMoves = new Map<string, string>();

  // Start with a dependency-consistent schedule before considering resources.
  let workingTasks: Task[] = resolveSchedule(liveTasks, defaultGap, scheduleOptions);
  const baselineCpm = calculateCriticalPath(workingTasks, cpmOptions);
  if (baselineCpm.errors?.length) {
    const finalFinish = getProjectFinish(workingTasks);
    const daysAdded = Math.max(0, diffDays(initialFinish, finalFinish));
    return {
      tasks: restoreDeleted(workingTasks),
      adjustments: [],
      initialOverallocations,
      remainingOverallocations: initialOverallocations,
      projectDurationChanged: daysAdded > 0,
      daysAdded,
      unresolvedReasons: baselineCpm.errors
    };
  }
  const invalidLocks = workingTasks.filter((t) => hasLockedViolation(t, baselineCpm, options));
  if (invalidLocks.length) {
    const finalFinish = getProjectFinish(workingTasks);
    const daysAdded = Math.max(0, diffDays(initialFinish, finalFinish));
    return {
      tasks: restoreDeleted(workingTasks), adjustments: [], initialOverallocations,
      remainingOverallocations: detectOverAllocations(workingTasks, options),
      projectDurationChanged: daysAdded > 0, daysAdded,
      unresolvedReasons: invalidLocks.map((t) => `Locked task '${t.id}' violates a dependency constraint.`)
    };
  }
  const adjustments: LevelingAdjustment[] = [];

  let pass = 0;
  let cpm = baselineCpm;
  while (pass < maxIterations) {
    pass++;
    if (pass > 1) cpm = calculateCriticalPath(workingTasks, cpmOptions);
    if (cpm.errors?.length) {
      unresolvedReasons.push(...cpm.errors);
      break;
    }
    const conflicts = detectOverAllocations(workingTasks, options);
    if (conflicts.length === 0) {
      break;
    }
    const lockedIds = new Set(workingTasks.filter((task) => task.locked).map((task) => task.id));
    const lockedConflictKeys = (conflict: ResourceAllocation) => conflict.tasks.flatMap((id) => lockedIds.has(id)
      ? conflict.tasks.filter((other) => other !== id).map((other) => JSON.stringify([conflict.resourceId, conflict.date, id, other])) : []);
    const lockedConflicts = new Set(conflicts.flatMap(lockedConflictKeys));
    const newLockedConflicts = (trial: Task[]) => lockedIds.size === 0 ? [] : detectOverAllocations(trial, options)
      .filter((conflict) => lockedConflictKeys(conflict).some((key) => !lockedConflicts.has(key)));
    // A move that creates a new locked conflict is acceptable when the
    // conflicting flexible task can be shifted past the locked booking into a
    // schedule that still satisfies every locked dependency.
    const introducesLockedConflict = (trial: Task[]): boolean => {
      let current = trial;
      for (let step = 0; step < 2; step++) {
        const conflicts = newLockedConflicts(current);
        if (!conflicts.length) return false;
        let progressed = false;
        for (const conflict of conflicts) {
          if (conflict.tasks.filter((id) => !lockedIds.has(id)).length !== 1) continue;
          const candidate = current.find((task) => !task.locked && conflict.tasks.includes(task.id));
          const anchor = current.find((task) => task.locked && conflict.tasks.includes(task.id));
          if (!candidate || !anchor) continue;
          const slot = findResourceSlot(candidate, current, anchor, defaultGap, options);
          if (!slot || slot.start <= candidate.start) continue;
          const moved = resolveSchedule(current.map((task) => task.id === candidate.id ? { ...task, ...slot } : task), defaultGap, scheduleOptions);
          const movedCpm = calculateCriticalPath(moved, cpmOptions);
          if (movedCpm.errors?.length || moved.some((task) => hasLockedViolation(task, movedCpm, options))) continue;
          current = moved;
          progressed = true;
          break;
        }
        if (!progressed) return true;
      }
      return newLockedConflicts(current).length > 0;
    };

    // Continue with other resources when one conflict cannot be resolved.
    const conflictKey = (conflict: ResourceAllocation) => `${conflict.resourceId}\u0000${conflict.capacity}\u0000${[...conflict.tasks].sort().join("\u0000")}`;
    const earliestConflict = conflicts.find((conflict) => !rejectedConflicts.has(conflictKey(conflict)));
    if (!earliestConflict) break;
    const currentKey = conflictKey(earliestConflict);
    const conflictingTasks = workingTasks.filter((t) =>
      earliestConflict.tasks.includes(t.id)
    );

    // Sort to determine which task should keep its place
    conflictingTasks.sort((a, b) => compareLevelingPrecedence(a, b, cpm));

    if (conflictingTasks.length < 2) {
      const candidate = conflictingTasks[0];
      const availability = candidate && resourceCalendar(candidate, options);
      const capacity = resourceCapacity(earliestConflict.resourceId, options);
      if (candidate && !candidate.locked && availability && !exceedsCapacity(getTaskAllocationUnits(candidate), capacity)) {
        const calendar = taskCalendar(candidate, options);
        const duration = calendar ? Math.max(diffWorkingDays(candidate.start, candidate.end, calendar), 0) : Math.max(diffDays(candidate.start, candidate.end), 0);
        let found = false;
        const searchDays = availabilitySearchAllowance(availability);
        for (let days = 1; days <= searchDays; days++) {
          let newStart: string;
          let newEnd: string;
          try {
            newStart = calendar ? addWorkingDays(candidate.start, days, calendar) : addDays(candidate.start, days);
            if (!isValidISODate(newStart)) break;
            newEnd = calendar ? addWorkingDays(newStart, duration, calendar) : addDays(newStart, duration);
            if (!isValidISODate(newEnd)) break;
          } catch (error) {
            if (error instanceof CalendarError) break;
            throw error;
          }
          const shifted = { ...candidate, start: newStart, end: newEnd };
          if (detectOverAllocations([shifted], options).length) continue;
          const trial = resolveSchedule(workingTasks.map((t) => t.id === candidate.id ? shifted : t), defaultGap, scheduleOptions);
          const trialCpm = calculateCriticalPath(trial, cpmOptions);
          if (trialCpm.errors?.length || trial.some((t) => hasLockedViolation(t, trialCpm, options))) break;
          if (introducesLockedConflict(trial)) continue;
          adjustments.push({
            taskId: candidate.id, resourceId: earliestConflict.resourceId,
            previousStart: candidate.start, previousEnd: candidate.end, newStart, newEnd,
            delayDays: diffDays(candidate.start, newStart),
            reason: `Shifted to respect resource availability on ${earliestConflict.date}`,
            withinFloat: (calendar ? diffWorkingDays(candidate.start, newStart, calendar) : diffDays(candidate.start, newStart)) <= (cpm.metrics.get(candidate.id)?.totalFloat ?? 0)
          });
          workingTasks = trial;
          found = true;
          break;
        }
        if (found) {
          rejectedConflicts.clear();
          continue;
        }
        rejectedConflicts.set(currentKey, `Could not find a schedule for task '${candidate.id}' within the search of up to ${searchDays} task-calendar days while respecting resource availability and locked dependencies.`);
      } else {
        rejectedConflicts.set(currentKey, `Cannot resolve ${earliestConflict.resourceId} overload on ${earliestConflict.date}: a task exceeds capacity or is locked.`);
      }
      continue;
    }
    let moved = false;
    const candidates = [...conflictingTasks.slice(1).reverse(), conflictingTasks[0]];
    const previousCandidate = previousMoves.get(currentKey);
    if (previousCandidate) candidates.sort((a, b) => Number(a.id === previousCandidate) - Number(b.id === previousCandidate));
    const lockBlocked: { candidate: Task; anchor: Task; lateStart: string }[] = [];
    for (const candidate of candidates) {
      if (candidate.locked) continue;
      const anchor = conflictingTasks.find((t) => t.id !== candidate.id)!;
      const calendar = taskCalendar(candidate, options);
      const slot = findResourceSlot(candidate, workingTasks, anchor, defaultGap, options);
      if (!slot) continue;
      const { start: newStart, end: newEnd } = slot;
      const shiftAmount = diffDays(candidate.start, newStart);
      if (shiftAmount <= 0) continue;

      const trial = resolveSchedule(workingTasks.map((t) => t.id === candidate.id ? { ...t, start: newStart, end: newEnd } : t), defaultGap, scheduleOptions);
      const trialCpm = calculateCriticalPath(trial, cpmOptions);
      const breaksLock = trial.some((t) => hasLockedViolation(t, trialCpm, options));
      if (trialCpm.errors?.length || breaksLock) {
        if (breaksLock && !trialCpm.errors?.length) lockBlocked.push({ candidate, anchor, lateStart: newStart });
        continue;
      }
      if (introducesLockedConflict(trial)) continue;
      // Cascading an anchor after its predecessor can recreate the same conflict
      // indefinitely; try another candidate instead of accepting that move.
      const pairConflict = (pair: Task[]) => detectOverAllocations(pair, options).some((item) => item.capacity > 0 && item.tasks.length === 2);
      if (pairConflict([candidate, anchor])) {
        const shiftedPair = trial.filter((t) => t.id === candidate.id || t.id === anchor.id);
        if (pairConflict(shiftedPair)) continue;
      }

      const floatShift = calendar ? diffWorkingDays(candidate.start, newStart, calendar) : shiftAmount;
      adjustments.push({
        taskId: candidate.id, resourceId: earliestConflict.resourceId,
        previousStart: candidate.start, previousEnd: candidate.end, newStart, newEnd,
        delayDays: shiftAmount,
        reason: `Shifted to resolve resource contention with task '${anchor.id}' on ${earliestConflict.date}`,
        withinFloat: floatShift <= (cpm.metrics.get(candidate.id)?.totalFloat ?? 0)
      });
      workingTasks = trial;
      previousMoves.set(currentKey, candidate.id);
      rejectedConflicts.clear();
      moved = true;
      break;
    }
    // Movable future bookings may occupy the only slot that preserves a
    // locked successor. Try moving one or two bookings after the constrained task.
    if (!moved) for (const { candidate, anchor, lateStart } of lockBlocked) {
      const resourceId = taskResourceId(candidate, options);
      const calendar = taskCalendar(candidate, options);
      const earliestStart = calendar ? addWorkingDays(anchor.end, Math.max(1, defaultGap), calendar) : addDays(anchor.end, Math.max(1, defaultGap));
      const blockers = workingTasks.filter((task) => !task.locked && task.id !== candidate.id && task.id !== anchor.id
        && taskResourceId(task, options) === resourceId && task.start < lateStart && task.end >= earliestStart);
      function* groups(): Generator<Task[]> {
        for (const blocker of blockers) yield [blocker];
        let pairs = 0;
        for (let i = 0; i < blockers.length; i++) for (let j = i + 1; j < blockers.length && pairs < 256; j++, pairs++) yield [blockers[i], blockers[j]];
      }
      for (const group of groups()) {
        const excluded = new Set(group.map((task) => task.id));
        const firstSlot = findResourceSlot(candidate, workingTasks.filter((task) => !excluded.has(task.id)), anchor, defaultGap, options);
        if (!firstSlot || firstSlot.start >= lateStart || firstSlot.start <= candidate.start) continue;
        const firstTrial = resolveSchedule(workingTasks.map((task) => task.id === candidate.id ? { ...task, ...firstSlot } : task), defaultGap, scheduleOptions);
        const firstCpm = calculateCriticalPath(firstTrial, cpmOptions);
        if (firstCpm.errors?.length || firstTrial.some((task) => hasLockedViolation(task, firstCpm, options))) continue;
        let trial = firstTrial;
        let valid = true;
        for (const blocker of group) {
          excluded.delete(blocker.id);
          const shiftedCandidate = trial.find((task) => task.id === candidate.id)!;
          const shiftedBlocker = trial.find((task) => task.id === blocker.id)!;
          const slot = findResourceSlot(shiftedBlocker, trial.filter((task) => !excluded.has(task.id)), shiftedCandidate, defaultGap, options);
          if (!slot || slot.start <= shiftedBlocker.start) { valid = false; break; }
          trial = resolveSchedule(trial.map((task) => task.id === blocker.id ? { ...task, ...slot } : task), defaultGap, scheduleOptions);
          const trialCpm = calculateCriticalPath(trial, cpmOptions);
          if (trialCpm.errors?.length || trial.some((task) => hasLockedViolation(task, trialCpm, options))) { valid = false; break; }
        }
        if (!valid) continue;
        if (introducesLockedConflict(trial)) continue;
        const remaining = detectOverAllocations(trial, options);
        if (remaining.some((item) => item.resourceId === earliestConflict.resourceId && item.date === earliestConflict.date && item.tasks.includes(candidate.id))) continue;
        if (remaining.some((item) => item.resourceId === earliestConflict.resourceId && item.tasks.includes(candidate.id) && group.some((blocker) => item.tasks.includes(blocker.id)))) continue;
        for (const original of [candidate, ...group]) {
          const updated = trial.find((task) => task.id === original.id)!;
          const cal = taskCalendar(original, options);
          const floatShift = cal ? diffWorkingDays(original.start, updated.start, cal) : diffDays(original.start, updated.start);
          adjustments.push({ taskId: original.id, resourceId: earliestConflict.resourceId,
            previousStart: original.start, previousEnd: original.end, newStart: updated.start, newEnd: updated.end,
            delayDays: diffDays(original.start, updated.start), withinFloat: floatShift <= (cpm.metrics.get(original.id)?.totalFloat ?? 0),
            reason: `Reordered resource tasks to preserve locked dependencies on ${earliestConflict.date}` });
        }
        workingTasks = trial;
        rejectedConflicts.clear();
        moved = true;
        break;
      }
      if (moved) break;
    }
    if (!moved) {
      rejectedConflicts.set(currentKey, `Could not find a resolution for ${earliestConflict.resourceId} overload on ${earliestConflict.date} within the heuristic search while respecting locked tasks and dependencies.`);
    }
  }

  const finalFinish = getProjectFinish(workingTasks);
  const remainingOverallocations = detectOverAllocations(workingTasks, options);
  unresolvedReasons.push(...rejectedConflicts.values());
  if (remainingOverallocations.length && pass >= maxIterations) {
    unresolvedReasons.push(`Resource leveling stopped after ${maxIterations} iterations.`);
  }
  const daysAdded = Math.max(0, diffDays(initialFinish, finalFinish));
  const projectDurationChanged = daysAdded > 0;

  return {
    tasks: restoreDeleted(workingTasks),
    adjustments,
    initialOverallocations,
    remainingOverallocations,
    projectDurationChanged,
    daysAdded,
    unresolvedReasons
  };
}
