import { JanttData } from "../types";
import { dependencySignature, stableJson } from "./task-merger";

/**
 * Computes a fast, deterministic 64-bit FNV-1a content hash of a Jantt plan.
 * Normalizes keys, excludes soft-deleted tombstones, and sorts elements by deterministic IDs
 * so identical logical plans always yield the identical hash regardless of key order.
 */
export function calculatePlanHash(data: JanttData | null | undefined): string {
  if (!data) return "0000000000000000";

  // Normalize active tasks (excluding soft-deleted tombstones)
  const normalizedTasks = Array.isArray(data.tasks)
    ? [...data.tasks]
        .filter((t) => !t._deleted)
        .map((t) => ({
          id: String(t.id || ""),
          label: String(t.label || t.name || ""),
          start: String(t.start || ""),
          end: String(t.end || ""),
          progress: Number(t.progress || 0),
          status: String(t.status || "not-started"),
          category: String(t.category || ""),
          assignee: String(t.assignee || t.person || ""),
          assignees: Array.isArray(t.assignees) ? [...t.assignees].sort() : [],
          dependsOn: dependencySignature(t),
          gapDays: t.gapDays ?? null,
          minGapDays: t.minGapDays ?? null,
          calendar: t.calendar ?? null,
          calendarId: t.calendarId ?? null,
          allocation: t.allocation ?? null,
          fields: t.fields ?? null,
          notes: String(t.notes || ""),
          color: String(t.color || "")
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  const normalizedNotes = Array.isArray(data.notes)
    ? [...data.notes]
        .filter((n) => !n._deleted)
        .map((n) => ({
          id: String(n.id || ""),
          title: String(n.title || ""),
          content: String(n.content || ""),
          pinned: Boolean(n.pinned)
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  const normalizedPeople = Array.isArray(data.people)
    ? [...data.people]
        .map((p) => ({
          id: String(p.id || ""),
          name: String(p.name || ""),
          role: String(p.role || ""),
          calendar: p.calendar ?? null,
          calendarId: p.calendarId ?? null
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  const normalizedTeams = Array.isArray(data.teams)
    ? data.teams
        .map((t) => ({
          id: String(t.id || ""),
          name: String(t.name || ""),
          color: String(t.color || ""),
          description: String(t.description || "")
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  const normalizedMeta = {
    title: String(data.meta?.title || ""),
    start: String(data.meta?.start || data.meta?.chartStart || ""),
    end: String(data.meta?.end || data.meta?.chartEnd || ""),
    defaultGapDays: Number(data.meta?.defaultGapDays ?? 2),
    scale: String(data.meta?.scale || "day"),
    calendar: data.meta?.calendar ?? null,
    useWorkingDays: Boolean(data.meta?.useWorkingDays),
    targetDate: data.meta?.targetDate ?? null,
    defaultResourceCapacity: data.meta?.defaultResourceCapacity ?? null,
    resourceCapacities: data.meta?.resourceCapacities ?? null
  };

  const payload = stableJson({
    meta: normalizedMeta,
    tasks: normalizedTasks,
    notes: normalizedNotes,
    people: normalizedPeople,
    teams: normalizedTeams,
    categories: data.categories || {},
    calendars: data.calendars || {}
  })!;

  // 64-bit FNV-1a Hash simulation with dual 32-bit words
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (code << 5) | (code >>> 27);
    h2 = Math.imul(h2, 0x5bd1e995);
  }

  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${p1}${p2}`;
}
