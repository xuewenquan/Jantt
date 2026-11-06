/**
 * Jantt Enterprise Dependency Engine
 *
 * Implements ANSI/PMI Standard 4-Type Dependency Relationships:
 * 1. FS (Finish-to-Start) - Successor starts after Predecessor finishes [Default]
 * 2. SS (Start-to-Start) - Successor starts after Predecessor starts
 * 3. FF (Finish-to-Finish) - Successor finishes after Predecessor finishes
 * 4. SF (Start-to-Finish) - Successor finishes after Predecessor starts
 *
 * Supports Lead & Lag (positive and negative day offsets),
 * compact string shorthand (`t1:SS+2d`, `t1:FF-1`), and structured object syntax.
 */

import { getEffectiveGap, isTaskDone } from "./utils";

export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface DependencyRelation {
  id: string;
  type: DependencyType;
  lagDays: number;
  /** Present when a zero lag was explicitly supplied. */
  explicitZeroLag?: boolean;
}

/** Stable identity for a relationship, including its type and lag semantics. */
export function dependencyRelationKey(fromId: string, toId: string, relation: DependencyRelation): string {
  return JSON.stringify([fromId, toId, relation.type, relation.lagDays, Boolean(relation.explicitZeroLag)]);
}

export interface DependencyObject {
  id: string;
  type?: DependencyType;
  lag?: number;
  lagDays?: number;
}

export type DependencyItem = string | DependencyObject;
export type DependencyInput = string | DependencyItem[] | DependencyObject | null | undefined;

/** Whether recorded predecessor progress prevents a task from starting. */
export function isTaskStartBlocked(
  task: { dependsOn?: unknown; gapDays?: number | null; minGapDays?: number | null },
  tasksById: ReadonlyMap<string, { status?: string; progress?: number | null }>,
  defaultGapDays = 0
): boolean {
  return getTaskDependencyRelations(task).some((relation) => {
    const predecessor = tasksById.get(relation.id);
    if (!predecessor) return false;
    const lag = getRelationLag(relation, task, defaultGapDays);
    if (lag < 0 || relation.type === "FF" || relation.type === "SF") return false;
    const finished = isTaskDone(predecessor);
    if (relation.type === "FS") return !finished;
    return !finished && predecessor.status !== "in-progress" && (predecessor.progress ?? 0) <= 0;
  });
}

/** Filter relationships by predecessor ID without discarding type or lag. */
export function filterDependencies(input: DependencyInput, keep: (id: string) => boolean): DependencyInput {
  const valid = (item: DependencyItem) => {
    const relation = parseDependencyRelation(item);
    return !relation || keep(relation.id);
  };
  if (typeof input === "string") {
    const items = input.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    const remaining = items.filter(valid);
    return remaining.length === items.length ? input : remaining.join(",") || null;
  }
  if (Array.isArray(input)) {
    const remaining = input.filter(valid);
    return remaining.length === input.length ? input : remaining.length === 0 ? null : remaining.length === 1 ? remaining[0] : remaining;
  }
  return input && !valid(input) ? null : input;
}

/** Remove one normalized relationship while retaining the other raw entries. */
export function removeDependencyAt(input: DependencyInput, index: number): DependencyInput {
  let position = 0;
  const keep = (item: DependencyItem) => !parseDependencyRelation(item) || position++ !== index;
  if (typeof input === "string") {
    return input.split(/[;,]/).map((item) => item.trim()).filter(Boolean).filter(keep).join(",") || null;
  }
  if (Array.isArray(input)) {
    const remaining = input.filter(keep);
    return remaining.length === 0 ? null : remaining.length === 1 ? remaining[0] : remaining;
  }
  return input && !keep(input) ? null : input;
}

/** Append a default FS relationship while retaining existing relationship data. */
export function appendDependency(input: DependencyInput, id: string): DependencyInput {
  if (getTaskDependencyRelations({ dependsOn: input }).some((relation) => relation.id === id)) return input;
  if (!input) return id;
  const items = typeof input === "string" ? input.split(/[;,]/).map((item) => item.trim()).filter(Boolean)
    : Array.isArray(input) ? input : [input];
  return [...items, id];
}

/** Effective lag: an explicit zero stays zero; an omitted lag uses the
 * successor's task gap or the project default. */
export function getRelationLag(
  relation: DependencyRelation,
  successor: { gapDays?: number | null; minGapDays?: number | null },
  defaultGapDays = 0
): number {
  return relation.lagDays !== 0 || relation.explicitZeroLag
    ? relation.lagDays
    : getEffectiveGap(successor, defaultGapDays);
}

/** Render relationship details without replacing an omitted lag with zero. */
export function formatDependency(relation: DependencyRelation): string {
  const hasLag = relation.lagDays !== 0 || relation.explicitZeroLag;
  if (relation.type === "FS" && !hasLag) return relation.id;
  const lag = hasLag ? `${relation.lagDays >= 0 ? "+" : ""}${relation.lagDays}d` : "";
  return `${relation.id}:${relation.type}${lag}`;
}

/**
 * Parses shorthand strings into normalized DependencyRelation:
 * - "t1" -> { id: "t1", type: "FS", lagDays: 0 }
 * - "t1:SS" -> { id: "t1", type: "SS", lagDays: 0 }
 * - "t1:FS+2d" -> { id: "t1", type: "FS", lagDays: 2 }
 * - "t1:FF-3d" -> { id: "t1", type: "FF", lagDays: -3 }
 * - "t1+4d" -> { id: "t1", type: "FS", lagDays: 4 }
 * - "t1-2d" -> { id: "t1", type: "FS", lagDays: -2 }
 *
 * Note: a string ending in ":FS", ":SS", ":FF", or ":SF" is always parsed as a
 * typed relationship. Use a structured object for task IDs with that suffix.
 */
export function parseDependencyRelation(item: unknown): DependencyRelation | null {
  if (!item) return null;

  if (typeof item === "string") {
    const trimmed = item.trim();
    if (!trimmed) return null;

    // Pattern 1: With explicit colon type: e.g. "task-1:SS", "task-1:FF-2d", "task-1:FS+3"
    const colonMatch = trimmed.match(/^(.+):(FS|SS|FF|SF)(?:([+-]\d+)(?:d|days?)?)?$/i);
    if (colonMatch) {
      const id = colonMatch[1];
      const type = colonMatch[2].toUpperCase() as DependencyType;
      const lagDays = colonMatch[3] ? parseInt(colonMatch[3], 10) : 0;
      return { id, type, lagDays, ...(colonMatch[3] && lagDays === 0 ? { explicitZeroLag: true } : {}) };
    }

    // Pattern 2: Shorthand with '+' or '-' and explicit 'd'/'days': e.g. "task-1+2d", "task-1-3d"
    const offsetDayMatch = trimmed.match(/^([a-zA-Z0-9_\-\.]+?)([+-]\d+)(?:d|days)$/i);
    if (offsetDayMatch) {
      const id = offsetDayMatch[1];
      const lagDays = parseInt(offsetDayMatch[2], 10);
      return { id, type: "FS", lagDays, ...(lagDays === 0 ? { explicitZeroLag: true } : {}) };
    }

    // Pattern 3: Shorthand with explicit '+': e.g. "task-1+4"
    const plusMatch = trimmed.match(/^([a-zA-Z0-9_\-\.]+?)\+(\d+)$/);
    if (plusMatch) {
      const id = plusMatch[1];
      const lagDays = parseInt(plusMatch[2], 10);
      return { id, type: "FS", lagDays, ...(lagDays === 0 ? { explicitZeroLag: true } : {}) };
    }

    // Pattern 4: Plain ID (may contain hyphens, numbers, dots): e.g. "task-1", "A"
    return { id: trimmed, type: "FS", lagDays: 0 };
  }

  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id) return null;

    let type: DependencyType = "FS";
    if (typeof obj.type === "string") {
      const upper = obj.type.toUpperCase();
      if (upper === "FS" || upper === "SS" || upper === "FF" || upper === "SF") {
        type = upper as DependencyType;
      }
    }

    const lag = typeof obj.lagDays === "number" ? obj.lagDays : (typeof obj.lag === "number" ? obj.lag : 0);

    return { id, type, lagDays: lag, ...((typeof obj.lagDays === "number" || typeof obj.lag === "number") && lag === 0 ? { explicitZeroLag: true } : {}) };
  }

  return null;
}

/**
 * Extracts and normalizes all dependency relations from a task's `dependsOn` field.
 */
export function getTaskDependencyRelations(task: { dependsOn?: unknown } | null | undefined): DependencyRelation[] {
  if (!task || task.dependsOn === undefined || task.dependsOn === null) {
    return [];
  }

  const result: DependencyRelation[] = [];
  const raw = task.dependsOn;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseDependencyRelation(item);
      if (parsed) result.push(parsed);
    }
  } else if (typeof raw === "string") {
    const tokens = raw.split(/[;,]/).map((s) => s.trim()).filter((s) => s.length > 0);
    for (const token of tokens) {
      const parsed = parseDependencyRelation(token);
      if (parsed) result.push(parsed);
    }
  } else if (typeof raw === "object") {
    const parsed = parseDependencyRelation(raw);
    if (parsed) result.push(parsed);
  }

  return result;
}
