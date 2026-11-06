import { IGestureStrategy, DragState, GestureContext } from "../contracts";
import { addDays, diffDays } from "../../date-math";
import { resolveSchedule, getScheduleContext } from "../../resolver";
import { addWorkingDays, getNextWorkingDay, getPreviousWorkingDay, resolveTaskCalendar } from "../../calendar";
import { getTaskDependencyRelations, getRelationLag } from "../../dependencies";
import { resolvePersonById } from "../../team-resolver";

export class ResizeGestureStrategy implements IGestureStrategy {
  public readonly mode = "resize" as const;

  public onMove(e: PointerEvent, state: DragState, ctx: GestureContext): void {
    const deltaX = e.clientX - state.startX;
    const deltaDays = Math.round(deltaX / ctx.dayWidth);
    const task = ctx.data.tasks.find((t) => t.id === state.taskId);
    if (!task) return;

    const person = resolvePersonById(ctx.data.people, task.assignee);
    const useCalendar = Boolean(ctx.data.meta?.useWorkingDays || ctx.data.meta?.calendar || task.calendar || task.calendarId || person?.calendar || person?.calendarId);
    const calendar = useCalendar ? resolveTaskCalendar(task, { people: ctx.data.people, calendars: ctx.data.calendars, defaultCalendar: ctx.data.meta?.calendar }) : undefined;
    let newEnd = addDays(state.origEnd!, deltaDays);
    if (calendar) newEnd = deltaDays < 0 ? getPreviousWorkingDay(newEnd, calendar) : getNextWorkingDay(newEnd, calendar);
    if (!ctx.autoCascade) {
      for (const rel of getTaskDependencyRelations(task)) {
        if (rel.type !== "FF" && rel.type !== "SF") continue;
        const predecessor = ctx.data.tasks.find((item) => !item._deleted && item.id === rel.id);
        if (!predecessor) continue;
        const anchor = rel.type === "FF" ? predecessor.end : predecessor.start;
        const lag = getRelationLag(rel, task, ctx.defaultGapDays);
        const minimum = calendar ? addWorkingDays(anchor, lag, calendar) : addDays(anchor, lag);
        if (newEnd < minimum) newEnd = minimum;
      }
    }
    if (diffDays(state.origStart!, newEnd) >= (task.milestone ? 0 : 1)) {
      task.end = newEnd;
    }
    if (ctx.autoCascade) {
      ctx.data.tasks = resolveSchedule(ctx.data.tasks, ctx.defaultGapDays, getScheduleContext(ctx.data));
    }
  }

  public onUp(_e: PointerEvent, state: DragState, ctx: GestureContext): void {
    const task = ctx.data.tasks.find((t) => t.id === state.taskId);
    if (!task) return;

    if (!state.moved) {
      ctx.options.onTaskClick?.(task);
      ctx.openModalHandler(task);
    } else {
      if (ctx.autoCascade) {
        ctx.data.tasks = resolveSchedule(ctx.data.tasks, ctx.defaultGapDays, getScheduleContext(ctx.data));
      }
      ctx.onRenderRequest();
      ctx.commitData();
    }
  }
}
