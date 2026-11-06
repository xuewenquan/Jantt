import { JanttData, Task, ValidationError, ValidationResult } from "./types";
import { isValidISODate, diffDays } from "./date-math";
import { getTaskDependencies } from "./resolver";
import { CALENDAR_PRESETS, type WorkingCalendar } from "./calendar";

/**
 * Validates a Jantt data object and returns an array of LLM-friendly diagnostic errors.
 *
 * Each error specifies the task ID (if applicable), the property path, a human-readable
 * self-correction message, and a suggested fix.
 */
export function validate(json: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!json || typeof json !== "object") {
    errors.push({
      path: "$",
      code: "SCHEMA_MISMATCH",
      message: "The provided Jantt data is not a valid JSON object.",
      suggestion: "Provide a JSON object containing at least a 'tasks' array."
    });
    return { valid: false, errors };
  }

  const data = json as Partial<JanttData>;

  if (!Array.isArray(data.tasks)) {
    errors.push({
      path: "tasks",
      code: "MISSING_TASKS",
      message: "Root object is missing the required 'tasks' array.",
      suggestion: "Add a 'tasks': [...] array to the top level of your JSON."
    });
    return { valid: false, errors };
  }

  const validateCalendarReference = (value: unknown, path: string, taskId?: string) => {
    if (typeof value !== "string" || !value) return;
    if (Object.prototype.hasOwnProperty.call(CALENDAR_PRESETS, value) || (data.calendars && Object.prototype.hasOwnProperty.call(data.calendars, value))) return;
    errors.push({ path, taskId, code: "SCHEMA_MISMATCH", message: `Unknown calendar '${value}'.`, suggestion: "Choose a built-in calendar or define it in the project calendars." });
  };
  validateCalendarReference(data.meta?.calendar, "meta.calendar");
  if (Array.isArray(data.people)) data.people.forEach((person, index) => {
    if (!person || typeof person !== "object") return;
    validateCalendarReference(person.calendar, `people[${index}].calendar`);
    validateCalendarReference(person.calendarId, `people[${index}].calendarId`);
  });

  const validateCalendarDefinition = (calendar: unknown, path: string) => {
    if (!calendar || typeof calendar !== "object" || Array.isArray(calendar)) return;
    const definition = calendar as WorkingCalendar;
    if (definition.workingDays !== undefined) {
      const days = definition.workingDays;
      if (!Array.isArray(days) || days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        errors.push({ path: `${path}.workingDays`, code: "SCHEMA_MISMATCH", message: "Calendar working days must be a non-empty array of weekday numbers from 0 (Sunday) to 6 (Saturday).", suggestion: "Example: [1, 2, 3, 4, 5]." });
      }
    }
    if (definition.holidays !== undefined) {
      const invalid = !Array.isArray(definition.holidays) || definition.holidays.some((holiday: any) => {
        const date = typeof holiday === "string" ? holiday : holiday && typeof holiday === "object" ? holiday.date : undefined;
        return typeof date !== "string" || !isValidISODate(date);
      });
      if (invalid) {
        errors.push({ path: `${path}.holidays`, code: "INVALID_DATE_FORMAT", message: "Calendar holidays must be valid ISO dates.", suggestion: "Use YYYY-MM-DD strings or { date: 'YYYY-MM-DD' } objects." });
      }
    }
    if (definition.exceptions !== undefined) {
      const invalid = !Array.isArray(definition.exceptions) || definition.exceptions.some((exception: any) =>
        !exception || typeof exception !== "object" || typeof exception.date !== "string" || !isValidISODate(exception.date) || typeof exception.isWorkingDay !== "boolean");
      if (invalid) {
        errors.push({ path: `${path}.exceptions`, code: "SCHEMA_MISMATCH", message: "Calendar exceptions need a valid date and a boolean 'isWorkingDay'.", suggestion: "Example: { date: '2026-11-02', isWorkingDay: true }." });
      }
    }
  };
  if (data.calendars && typeof data.calendars === "object" && !Array.isArray(data.calendars)) {
    for (const [id, calendar] of Object.entries(data.calendars)) validateCalendarDefinition(calendar, `calendars.${id}`);
  }

  const capacity = data.meta?.defaultResourceCapacity;
  if (data.meta?.targetDate !== undefined && !isValidISODate(data.meta.targetDate)) {
    errors.push({ path: "meta.targetDate", code: "INVALID_DATE_FORMAT", message: "Project target date must be a valid ISO date.", suggestion: "Use a date in YYYY-MM-DD format." });
  }
  if (capacity !== undefined && (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity < 0)) {
    errors.push({ path: "meta.defaultResourceCapacity", code: "SCHEMA_MISMATCH", message: "Default resource capacity must be a finite non-negative number.", suggestion: "Use allocation units where 1 means 100%." });
  }
  const capacities = data.meta?.resourceCapacities;
  if (capacities !== undefined) {
    if (!capacities || typeof capacities !== "object" || Array.isArray(capacities)) {
      errors.push({ path: "meta.resourceCapacities", code: "SCHEMA_MISMATCH", message: "Resource capacities must be an object keyed by resource ID.", suggestion: "Set each capacity to a finite non-negative number." });
    } else {
      for (const [id, value] of Object.entries(capacities)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          errors.push({ path: `meta.resourceCapacities.${id}`, code: "SCHEMA_MISMATCH", message: `Capacity for '${id}' must be a finite non-negative number.`, suggestion: "Use allocation units where 1 means 100%." });
        }
      }
    }
  }

  const definedCategories = new Set<string>();
  if (data.categories && typeof data.categories === "object") {
    Object.keys(data.categories).forEach((catKey) => definedCategories.add(catKey));
  }

  const taskIds = new Set<string>();
  const idToTaskMap = new Map<string, Task>();

  // First pass: validate task structure, IDs, categories, dates, and progress
  data.tasks.forEach((rawTask, index) => {
    const path = `tasks[${index}]`;

    if (!rawTask || typeof rawTask !== "object") {
      errors.push({
        path,
        code: "INVALID_TASK_OBJECT",
        message: `Task at index ${index} is not a valid object.`,
        suggestion: "Ensure each item in 'tasks' is an object with { id, category, start, end }."
      });
      return;
    }

    const task = rawTask as Task;
    if (task._deleted) return; // Skip soft-deleted tombstones defensively
    const taskId = task.id;
    validateCalendarReference(task.calendar, `${path}.calendar`, taskId);
    validateCalendarReference(task.calendarId, `${path}.calendarId`, taskId);
    if (task.allocation !== undefined && (typeof task.allocation !== "number" || !Number.isFinite(task.allocation) || task.allocation < 0)) {
      errors.push({ path: `${path}.allocation`, taskId, code: "SCHEMA_MISMATCH", message: `Task '${taskId}' allocation must be a finite non-negative number.`, suggestion: "Use allocation units where 1 means 100%." });
    }
    const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn];
    dependencies.forEach((dependency, dependencyIndex) => {
      if (!dependency || typeof dependency !== "object") return;
      for (const field of ["lag", "lagDays"] as const) {
        if (dependency[field] !== undefined && !Number.isSafeInteger(dependency[field])) {
          const dependencyPath = Array.isArray(task.dependsOn) ? `${path}.dependsOn[${dependencyIndex}]` : `${path}.dependsOn`;
          errors.push({ path: `${dependencyPath}.${field}`, taskId, code: "SCHEMA_MISMATCH", message: `Task '${taskId}' dependency ${field} must be an integer number of days.`, suggestion: "Use a whole number of days, including zero or a negative lead." });
        }
      }
    });

    if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
      errors.push({
        path: `${path}.id`,
        code: "MISSING_TASK_ID",
        message: `Task at index ${index} (label: "${task.label || task.name || "unnamed"}") is missing a required 'id' string.`,
        suggestion: "Add a unique string 'id' to this task (e.g. \"id\": \"task-name\")."
      });
    } else if (taskIds.has(taskId)) {
      errors.push({
        path: `${path}.id`,
        taskId,
        code: "DUPLICATE_TASK_ID",
        message: `Duplicate task id '${taskId}' found at tasks[${index}]. Every task id must be unique across the plan.`,
        suggestion: `Change the id '${taskId}' on tasks[${index}] to a distinct unique identifier.`
      });
    } else {
      taskIds.add(taskId);
      idToTaskMap.set(taskId, task);
    }

    // Category validation
    if (!task.category || typeof task.category !== "string") {
      errors.push({
        path: `${path}.category`,
        taskId,
        code: "MISSING_CATEGORY",
        message: `Task '${taskId || `index ${index}`}' is missing a required 'category' string.`,
        suggestion: "Add a 'category' matching a key in your 'categories' object."
      });
    } else if (definedCategories.size > 0 && !definedCategories.has(task.category)) {
      errors.push({
        path: `${path}.category`,
        taskId,
        code: "UNKNOWN_CATEGORY",
        message: `Task '${taskId || `index ${index}`}' references category '${task.category}', but '${task.category}' is not defined in the top-level 'categories' map (known: ${Array.from(definedCategories).join(", ")}).`,
        suggestion: `Define "${task.category}": { "label": "...", "color": "#hex" } in the 'categories' object or assign a defined category.`
      });
    }

    // Start Date validation
    const hasValidStart = isValidISODate(task.start);
    if (!task.start || typeof task.start !== "string") {
      errors.push({
        path: `${path}.start`,
        taskId,
        code: "INVALID_DATE_FORMAT",
        message: `Task '${taskId || `index ${index}`}' is missing a 'start' date.`,
        suggestion: "Set 'start' to an ISO date string formatted as 'YYYY-MM-DD'."
      });
    } else if (!hasValidStart) {
      errors.push({
        path: `${path}.start`,
        taskId,
        code: "INVALID_DATE_FORMAT",
        message: `Task '${taskId || `index ${index}`}' has invalid start date '${task.start}'. Dates must be valid calendar dates in 'YYYY-MM-DD' format.`,
        suggestion: "Format 'start' as 'YYYY-MM-DD' (e.g. '2026-09-01')."
      });
    }

    // End Date validation
    const hasValidEnd = isValidISODate(task.end);
    if (!task.end || typeof task.end !== "string") {
      errors.push({
        path: `${path}.end`,
        taskId,
        code: "INVALID_DATE_FORMAT",
        message: `Task '${taskId || `index ${index}`}' is missing an 'end' date.`,
        suggestion: "Set 'end' to an ISO date string formatted as 'YYYY-MM-DD'."
      });
    } else if (!hasValidEnd) {
      errors.push({
        path: `${path}.end`,
        taskId,
        code: "INVALID_DATE_FORMAT",
        message: `Task '${taskId || `index ${index}`}' has invalid end date '${task.end}'. Dates must be valid calendar dates in 'YYYY-MM-DD' format.`,
        suggestion: "Format 'end' as 'YYYY-MM-DD' (e.g. '2026-09-10')."
      });
    }

    // Date range validation
    if (hasValidStart && hasValidEnd) {
      const days = diffDays(task.start, task.end);
      if (days < 0) {
        errors.push({
          path: `${path}.end`,
          taskId,
          code: "INVALID_DATE_RANGE",
          message: `Task '${taskId || `index ${index}`}' has start: '${task.start}' and end: '${task.end}' (end date cannot be earlier than start date).`,
          suggestion: `Ensure 'end' is on or after 'start' (duration is currently ${days} days).`
        });
      }
    }

    // Progress validation
    if (task.progress !== undefined && task.progress !== null) {
      if (typeof task.progress !== "number" || task.progress < 0 || task.progress > 1) {
        errors.push({
          path: `${path}.progress`,
          taskId,
          code: "INVALID_PROGRESS",
          message: `Task '${taskId || `index ${index}`}' has invalid progress value ${task.progress}. Progress must be a number between 0.0 and 1.0 (or null).`,
          suggestion: "Set 'progress' to a decimal between 0.0 and 1.0 (e.g. 0.5 for 50%)."
        });
      }
    }

    // Baseline validation
    if (task.baseline) {
      const bStartValid = isValidISODate(task.baseline.start);
      const bEndValid = isValidISODate(task.baseline.end);
      if (!bStartValid || !bEndValid) {
        errors.push({
          path: `${path}.baseline`,
          taskId,
          code: "INVALID_BASELINE_DATE",
          message: `Task '${taskId || `index ${index}`}' has invalid baseline dates (start: '${task.baseline.start}', end: '${task.baseline.end}').`,
          suggestion: "Ensure baseline 'start' and 'end' are valid 'YYYY-MM-DD' calendar date strings."
        });
      } else if (diffDays(task.baseline.start, task.baseline.end) < 0) {
        errors.push({
          path: `${path}.baseline.end`,
          taskId,
          code: "INVALID_BASELINE_RANGE",
          message: `Task '${taskId || `index ${index}`}' has baseline end date earlier than baseline start date.`,
          suggestion: "Ensure baseline 'end' is on or after baseline 'start'."
        });
      }
    }
  });

  // Second pass: Dependency resolution, dangling check, and cycle detection
  data.tasks.forEach((task, index) => {
    if (!task || !task.id || task._deleted) return;

    const depIds = getTaskDependencies(task);
    depIds.forEach((depId) => {
      // 0. Self-dependency check
      if (depId === task.id) {
        errors.push({
          path: `tasks[${index}].dependsOn`,
          taskId: task.id,
          code: "CIRCULAR_DEPENDENCY",
          message: `Task '${task.id}' cannot depend on itself.`,
          suggestion: `Remove '${depId}' from '${task.id}.dependsOn'.`
        });
        return;
      }

      // 1. Dangling dependency check
      if (!idToTaskMap.has(depId)) {
        errors.push({
          path: `tasks[${index}].dependsOn`,
          taskId: task.id,
          code: "DANGLING_DEPENDENCY",
          message: `Task '${task.id}' has dependsOn: '${depId}' but no task with id '${depId}' exists in the plan.`,
          suggestion: `Either create a task with id '${depId}' or update '${task.id}.dependsOn' to match an existing task id.`
        });
      }
    });
  });

  // Check for circular dependencies across arbitrary multi-dependency graphs
  const state = new Map<string, 1 | 2>();
  const taskIndexes = new Map(data.tasks.map((task, index) => [task?.id, index]));
  for (const taskId of idToTaskMap.keys()) {
    if (state.has(taskId)) continue;
    const stack = [{ id: taskId, deps: getTaskDependencies(idToTaskMap.get(taskId)!), next: 0 }];
    state.set(taskId, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.deps.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const nextId = frame.deps[frame.next++];
      if (!idToTaskMap.has(nextId) || nextId === frame.id) continue;
      if (state.get(nextId) === 1) {
        const cycleStart = stack.findIndex((item) => item.id === nextId);
        const cycleStr = [...stack.slice(cycleStart).map((item) => item.id), nextId].join(" -> ");
        errors.push({
          path: `tasks[${taskIndexes.get(frame.id)}].dependsOn`, taskId: frame.id, code: "CIRCULAR_DEPENDENCY",
          message: `Circular dependency detected involving tasks: ${cycleStr}. A task cannot directly or indirectly depend on itself.`,
          suggestion: `Break the cycle by removing the dependsOn link between '${frame.id}' and '${nextId}'.`
        });
      } else if (!state.has(nextId)) {
        state.set(nextId, 1);
        stack.push({ id: nextId, deps: getTaskDependencies(idToTaskMap.get(nextId)!), next: 0 });
      }
    }
  }

  // Validate notes collection if present
  if (data.notes !== undefined) {
    if (!Array.isArray(data.notes)) {
      errors.push({
        path: "notes",
        code: "SCHEMA_MISMATCH",
        message: "The 'notes' property must be an array of note items.",
        suggestion: "Ensure 'notes' is formatted as [ { id, title, content } ]."
      });
    } else {
      const noteIds = new Set<string>();
      data.notes.forEach((note, nIdx) => {
        if (!note || typeof note !== "object") {
          errors.push({
            path: `notes[${nIdx}]`,
            code: "SCHEMA_MISMATCH",
            message: `Note at index ${nIdx} is not a valid object.`,
            suggestion: "Ensure each note object contains { id, title, content }."
          });
          return;
        }
        if (!note.id || typeof note.id !== "string" || note.id.trim() === "") {
          errors.push({
            path: `notes[${nIdx}].id`,
            code: "SCHEMA_MISMATCH",
            message: `Note at index ${nIdx} is missing a required string 'id'.`,
            suggestion: "Add a unique string id (e.g. \"note-1\")."
          });
        } else if (noteIds.has(note.id)) {
          errors.push({
            path: `notes[${nIdx}].id`,
            code: "SCHEMA_MISMATCH",
            message: `Duplicate note id '${note.id}' at index ${nIdx}.`,
            suggestion: "Ensure each note has a unique id."
          });
        } else {
          noteIds.add(note.id);
        }

        if (note.task_ids !== undefined) {
          if (!Array.isArray(note.task_ids) || !note.task_ids.every((tid) => typeof tid === "string")) {
            errors.push({
              path: `notes[${nIdx}].task_ids`,
              code: "SCHEMA_MISMATCH",
              message: `Note '${note.id || nIdx}' field 'task_ids' must be an array of string task IDs.`,
              suggestion: "Provide an array of task IDs like [\"T1\", \"T2\"]."
            });
          }
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
