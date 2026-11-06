import { IGestureStrategy, DragState, GestureContext } from "../contracts";
import { addDays, diffDays } from "../../date-math";
import { resolveSchedule, resolveDependencySubgraph, getScheduleContext } from "../../resolver";
import { resolvePersonById } from "../../team-resolver";
import { addWorkingDays, diffWorkingDays, getNextWorkingDay, resolveTaskCalendar } from "../../calendar";
import type { Task } from "../../types";

export class MoveGestureStrategy implements IGestureStrategy {
  public readonly mode = "move" as const;

  public onMove(e: PointerEvent, state: DragState, ctx: GestureContext): void {
    const deltaX = e.clientX - state.startX;
    const deltaDays = Math.round(deltaX / ctx.dayWidth);
    const task = ctx.data.tasks.find((t) => t.id === state.taskId);
    if (!task) return;
    const shift = (target: Task, start: string, end: string) => {
      const person = resolvePersonById(ctx.data.people, target.assignee);
      const hasCalendar = Boolean(ctx.data.meta?.useWorkingDays || ctx.data.meta?.calendar || target.calendar || target.calendarId || person?.calendar || person?.calendarId);
      if (!hasCalendar) {
        const newStart = addDays(start, deltaDays);
        return { start: newStart, end: addDays(newStart, Math.max(diffDays(start, end), 0)) };
      }
      const calendar = resolveTaskCalendar(target, { people: ctx.data.people, calendars: ctx.data.calendars, defaultCalendar: ctx.data.meta?.calendar });
      const newStart = getNextWorkingDay(addDays(start, deltaDays), calendar);
      const duration = Math.max(diffWorkingDays(start, end, calendar), 0);
      return { start: newStart, end: addWorkingDays(newStart, duration, calendar) };
    };

    const selected = state.multiTasks && state.multiTasks.size > 1
      ? new Set(state.multiTasks.keys())
      : new Set([task.id]);
    if (selected.size > 1) {
      state.multiTasks!.forEach((orig, id) => {
        const target = ctx.data.tasks.find((t) => t.id === id);
        if (target) {
          Object.assign(target, shift(target, orig.start, orig.end));
        }
      });
    } else {
      Object.assign(task, shift(task, state.origStart!, state.origEnd!));
    }
    if (!ctx.autoCascade) {
      const subgraph = resolveDependencySubgraph(ctx.data.tasks, ctx.data.tasks.filter((item) => selected.has(item.id)));
      const resolved = resolveSchedule(
        subgraph.map((item) => ({ ...item, locked: !selected.has(item.id) })),
        ctx.defaultGapDays,
        getScheduleContext(ctx.data)
      );
      for (const id of selected) {
        const target = ctx.data.tasks.find((t) => t.id === id);
        const adjusted = resolved.find((item) => item.id === id);
        if (target && adjusted) {
          target.start = adjusted.start;
          target.end = adjusted.end;
        }
      }
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
