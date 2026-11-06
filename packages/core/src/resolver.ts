import { Task, JanttData } from "./types";
import { DEFAULT_GAP_DAYS } from "./constants";
import { getTaskDependencies } from "./cpm";
import { CascadeResolveStage } from "./pipeline/stages/cascade-resolve-stage";
import type { PipelineContext } from "./pipeline/contracts";

export { getTaskDependencies, calculateCriticalPath } from "./cpm";

/**
 * Detects whether a set of tasks contains circular dependencies using Kahn's topological sort.
 */
export function hasDependencyCycle(tasks: Task[]): boolean {
  const liveTasks = (tasks || []).filter((t) => !t._deleted);
  const byId = new Set(liveTasks.map((t) => t.id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  // Check for self-dependencies (1-node cycle)
  for (const t of liveTasks) {
    if (getTaskDependencies(t).includes(t.id)) {
      return true;
    }
  }

  liveTasks.forEach((t) => {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  });

  liveTasks.forEach((t) => {
    const deps = getTaskDependencies(t).filter((d) => byId.has(d));
    inDegree.set(t.id, deps.length);
    deps.forEach((d) => {
      adj.get(d)?.push(t.id);
    });
  });

  const queue: string[] = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  let visited = 0;
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const curr = queue[queueIndex];
    visited++;
    const successors = adj.get(curr) || [];
    for (const s of successors) {
      const newDeg = (inDegree.get(s) || 1) - 1;
      inDegree.set(s, newDeg);
      if (newDeg === 0) {
        queue.push(s);
      }
    }
  }

  return visited < liveTasks.length;
}

const defaultCascadeStage = new CascadeResolveStage();

/** Calendar context shared by scheduling entry points for a project. */
export function getScheduleContext(data: JanttData): Omit<PipelineContext, "defaultGapDays"> {
  return { calendar: data.meta?.calendar, useWorkingDays: data.meta?.useWorkingDays, calendars: data.calendars, people: data.people, targetDate: data.meta?.targetDate };
}

/**
 * Returns the roots and their transitive predecessors, with root objects
 * overriding stored tasks that share an ID. Only this subgraph can affect the
 * roots' earliest dates.
 */
export function resolveDependencySubgraph(tasks: Task[], roots: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const root of roots) byId.set(root.id, root);
  const needed = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (needed.has(current.id)) continue;
    needed.add(current.id);
    for (const id of getTaskDependencies(current)) {
      if (id === current.id || needed.has(id)) continue;
      const predecessor = byId.get(id);
      if (predecessor) stack.push(predecessor);
    }
  }
  return [...needed].map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Resolves the scheduling cascade for a list of tasks.
 *
 * Implements coordinated multi-predecessor pacing:
 * 1. Multi-Dependency Resolution: If a task depends on multiple tasks (e.g. [A, B]),
 *    it cannot start before max(A.end, B.end) + gapDays. Preserves task duration when shifted.
 *
 * Locked tasks (`locked: true`) are never moved.
 *
 * @param tasks - The array of tasks to resolve.
 * @param defaultGapDays - Default spacing between sibling tasks (default: 2).
 * @returns A fresh, schedule-consistent array of tasks.
 */
export function resolveSchedule(tasks: Task[], defaultGapDays = DEFAULT_GAP_DAYS, options?: Omit<PipelineContext, "defaultGapDays">): Task[] {
  return defaultCascadeStage.process(tasks, { ...options, defaultGapDays });
}

