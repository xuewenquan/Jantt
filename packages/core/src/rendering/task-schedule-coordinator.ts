import { JanttData, Task } from "../types";
import { getTodayISODate, addDays } from "../date-math";
import { getScheduleContext } from "../resolver";
import { filterDependencies, getTaskDependencyRelations, removeDependencyAt } from "../dependencies";
import { DEFAULT_GAP_DAYS } from "../constants";
import { SchedulePipeline } from "../pipeline";
import { CalendarError } from "../calendar";

const defaultPipeline = SchedulePipeline.createDefault();

function resolveTasks(tasks: Task[], data: JanttData, defaultGapDays: number): Task[] {
  const result = defaultPipeline.execute(tasks, { ...getScheduleContext(data), defaultGapDays });
  if (result.context.fatalError) throw new CalendarError(result.context.fatalError);
  return result.tasks;
}

export class TaskScheduleCoordinator {
  /**
   * Adds a new sequential task to the schedule and resolves dependency dates.
   */
  public static createTask(currentData: JanttData): { nextData: JanttData; newTask: Task } {
    const defaultGap = currentData.meta?.defaultGapDays ?? DEFAULT_GAP_DAYS;
    const today = getTodayISODate();
    let lastEnd = today;
    if (currentData.tasks.length > 0) {
      lastEnd = currentData.tasks[currentData.tasks.length - 1].end || today;
    }
    const catKeys = Object.keys(currentData.categories || {});
    const defaultCat = catKeys.length > 0 ? catKeys[0] : "general";
    const nextIdx = currentData.tasks.length + 1;
    const newTask: Task = {
      id: `task-${Date.now().toString(36)}`,
      wbs: `${nextIdx}.0`,
      label: `New Task ${nextIdx}`,
      category: defaultCat,
      start: lastEnd,
      end: addDays(lastEnd, 7),
      progress: 0,
      status: "not-started",
      dependsOn: currentData.tasks.length > 0 ? currentData.tasks[currentData.tasks.length - 1].id : null,
      gapDays: defaultGap
    };

    const nextTasks = [...currentData.tasks, newTask];
    const resolved = resolveTasks(nextTasks, currentData, defaultGap);
    return {
      nextData: { ...currentData, tasks: resolved },
      newTask
    };
  }

  /**
   * Updates an existing task and recalculates the cascade schedule.
   */
  public static updateTask(currentData: JanttData, updatedTask: Task): JanttData {
    const defaultGap = currentData.meta?.defaultGapDays ?? DEFAULT_GAP_DAYS;
    const nextTasks = currentData.tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
    const resolved = resolveTasks(nextTasks, currentData, defaultGap);
    return { ...currentData, tasks: resolved };
  }

  /**
   * Deletes a task by ID, cleans up any dangling dependency references in downstream tasks,
   * and recalculates the cascade schedule.
   */
  public static deleteTask(currentData: JanttData, taskId: string): JanttData {
    const defaultGap = currentData.meta?.defaultGapDays ?? DEFAULT_GAP_DAYS;
    const nextTasks = currentData.tasks.filter((t) => t.id !== taskId).map((t) => ({ ...t, dependsOn: filterDependencies(t.dependsOn, (id) => id !== taskId) }));
    const resolved = resolveTasks(nextTasks, currentData, defaultGap);
    return { ...currentData, tasks: resolved };
  }

  /**
   * Removes a single dependency edge between two tasks and cascades downstream dates.
   */
  public static removeDependency(currentData: JanttData, fromId: string, toId: string, relationshipIndex?: number): JanttData {
    const targetTask = currentData.tasks.find((t) => t.id === toId);
    if (!targetTask) return currentData;
    if (relationshipIndex !== undefined && getTaskDependencyRelations(targetTask)[relationshipIndex]?.id !== fromId) return currentData;

    const defaultGap = currentData.meta?.defaultGapDays ?? DEFAULT_GAP_DAYS;
    const updatedTask = {
      ...targetTask,
      dependsOn: relationshipIndex === undefined ? filterDependencies(targetTask.dependsOn, (id) => id !== fromId) : removeDependencyAt(targetTask.dependsOn, relationshipIndex)
    };
    const nextTasks = currentData.tasks.map((t) => (t.id === toId ? updatedTask : t));
    const resolved = resolveTasks(nextTasks, currentData, defaultGap);
    return { ...currentData, tasks: resolved };
  }
}
