import { describe, it, expect, vi } from "vitest";
import {
  MoveGestureStrategy,
  ResizeGestureStrategy,
  ProgressGestureStrategy,
  LinkGestureStrategy,
  SplitterGestureStrategy,
  MarqueeGestureStrategy
} from "../src/controller/index";
import { GestureContext, DragState } from "../src/controller/contracts";
import { JanttData, Task } from "../src/types";

function createMockContext(tasks: Task[], overrides?: Partial<GestureContext>): { ctx: GestureContext; commits: any[] } {
  const commits: any[] = [];
  const data: JanttData = { tasks };
  const ctx: GestureContext = {
    data,
    options: {
      onCommit: (d) => commits.push(d),
      onChange: vi.fn(),
      onError: vi.fn(),
      onLinkCreate: vi.fn()
    },
    dayWidth: 40,
    defaultGapDays: 2,
    autoCascade: true,
    selectedTaskIds: new Set(),
    openModalHandler: vi.fn(),
    onRenderRequest: vi.fn(),
    scheduleRender: vi.fn(),
    selectTask: vi.fn(),
    clearSelection: vi.fn(),
    setTasks: (t) => {
      data.tasks = t;
    },
    commitData: () => {
      commits.push(data);
    },
    ...overrides
  };
  return { ctx, commits };
}

describe("Gesture Strategies", () => {
  it("does not create a dependency on a locked task", () => {
    const tasks: Task[] = [
      { id: "a", start: "2026-11-02", end: "2026-11-03" },
      { id: "b", start: "2026-11-04", end: "2026-11-05", locked: true }
    ];
    const { ctx, commits } = createMockContext(tasks);
    const target = document.createElement("div");
    target.dataset.taskId = "b";
    const original = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    try {
      new LinkGestureStrategy().onUp({ clientX: 0, clientY: 0 } as PointerEvent, {
        mode: "link", taskId: "a", linkFromTaskId: "a", startX: 0, startY: 0, origStart: tasks[0].start, origEnd: tasks[0].end, moved: true
      }, ctx);
      expect(tasks[1].dependsOn).toBeUndefined();
      expect(commits).toHaveLength(0);
    } finally {
      if (original) Object.defineProperty(document, "elementFromPoint", original);
      else delete (document as Partial<Document>).elementFromPoint;
    }
  });
  it("does not commit or report creation when a dragged link already exists", () => {
    const tasks: Task[] = [
      { id: "a", start: "2026-11-02", end: "2026-11-03" },
      { id: "b", start: "2026-11-04", end: "2026-11-05", dependsOn: "a:SS+1d" }
    ];
    const { ctx, commits } = createMockContext(tasks);
    const target = document.createElement("div");
    target.dataset.taskId = "b";
    const original = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    try {
      new LinkGestureStrategy().onUp({ clientX: 0, clientY: 0 } as PointerEvent, {
        mode: "link", taskId: "a", linkFromTaskId: "a", startX: 0, startY: 0, origStart: tasks[0].start, origEnd: tasks[0].end, moved: true
      }, ctx);
      expect(commits).toHaveLength(0);
      expect(ctx.options.onLinkCreate).not.toHaveBeenCalled();
      expect(tasks[1].dependsOn).toBe("a:SS+1d");
    } finally {
      if (original) Object.defineProperty(document, "elementFromPoint", original);
      else delete (document as Partial<Document>).elementFromPoint;
    }
  });
  describe("MoveGestureStrategy", () => {
    it("honors SS instead of FS when moving without cascading", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-12" },
        { id: "b", category: "dev", start: "2026-11-05", end: "2026-11-06", dependsOn: "a:SS+1d" }
      ];
      const { ctx } = createMockContext(tasks, { autoCascade: false });
      new MoveGestureStrategy().onMove({ clientX: -40, clientY: 0 } as PointerEvent, {
        mode: "move", taskId: "b", startX: 0, startY: 0, origStart: "2026-11-05", origEnd: "2026-11-06", moved: true
      }, ctx);
      expect(ctx.data.tasks[1].start).toBe("2026-11-04");
      expect(ctx.data.tasks[0].end).toBe("2026-11-12");
    });

    it("preserves working duration when moving a task across a weekend", () => {
      const tasks: Task[] = [{ id: "a", category: "dev", start: "2026-11-05", end: "2026-11-06" }];
      const { ctx } = createMockContext(tasks, { autoCascade: false });
      ctx.data.meta = { calendar: "standard" };
      new MoveGestureStrategy().onMove({ clientX: 40, clientY: 0 } as PointerEvent, {
        mode: "move", taskId: "a", startX: 0, startY: 0, origStart: "2026-11-05", origEnd: "2026-11-06", moved: true
      }, ctx);
      expect(ctx.data.tasks[0]).toMatchObject({ start: "2026-11-06", end: "2026-11-09" });
    });
    it("shifts single task by calculated delta days and cascades dependents", () => {
      const strategy = new MoveGestureStrategy();
      const tasks: Task[] = [
        { id: "t1", category: "dev", start: "2026-09-01", end: "2026-09-05" },
        { id: "t2", category: "dev", start: "2026-09-07", end: "2026-09-10", dependsOn: "t1", gapDays: 2 }
      ];
      const { ctx, commits } = createMockContext(tasks);
      const state: DragState = {
        mode: "move",
        taskId: "t1",
        startX: 100,
        startY: 100,
        origStart: "2026-09-01",
        origEnd: "2026-09-05",
        moved: true
      };

      // Drag 80px forward (80px / 40px/day = +2 days)
      const moveEvent = { clientX: 180, clientY: 100 } as PointerEvent;
      strategy.onMove(moveEvent, state, ctx);

      expect(ctx.data.tasks.find((t) => t.id === "t1")?.start).toBe("2026-09-03");
      expect(ctx.data.tasks.find((t) => t.id === "t1")?.end).toBe("2026-09-07");
      // Dependent t2 must cascade forward: t1 ends 09-07 + 2 gapDays -> starts 09-09
      expect(ctx.data.tasks.find((t) => t.id === "t2")?.start).toBe("2026-09-09");

      // Pointer up commits changes
      strategy.onUp({} as PointerEvent, state, ctx);
      expect(commits.length).toBe(1);
    });

    it("shifts multi-selected tasks together", () => {
      const strategy = new MoveGestureStrategy();
      const tasks: Task[] = [
        { id: "t1", category: "dev", start: "2026-09-01", end: "2026-09-05" },
        { id: "t2", category: "dev", start: "2026-09-05", end: "2026-09-10" }
      ];
      const { ctx } = createMockContext(tasks, { autoCascade: false });
      const multiTasks = new Map([
        ["t1", { start: "2026-09-01", end: "2026-09-05" }],
        ["t2", { start: "2026-09-05", end: "2026-09-10" }]
      ]);
      const state: DragState = {
        mode: "move",
        taskId: "t1",
        startX: 0,
        startY: 0,
        moved: true,
        multiTasks
      };

      // Move 40px right (+1 day)
      strategy.onMove({ clientX: 40, clientY: 0 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks.find((t) => t.id === "t1")?.start).toBe("2026-09-02");
      expect(ctx.data.tasks.find((t) => t.id === "t2")?.start).toBe("2026-09-06");
    });

    it("enforces dependencies for every multi-selected task without cascading", () => {
      const tasks: Task[] = [
        { id: "a", category: "dev", start: "2026-11-02", end: "2026-11-04" },
        { id: "b", category: "dev", start: "2026-11-05", end: "2026-11-06", dependsOn: "a:FS+0d" },
        { id: "c", category: "dev", start: "2026-11-07", end: "2026-11-08" }
      ];
      const { ctx } = createMockContext(tasks, { autoCascade: false });
      const multiTasks = new Map([
        ["b", { start: "2026-11-05", end: "2026-11-06" }],
        ["c", { start: "2026-11-07", end: "2026-11-08" }]
      ]);
      const state: DragState = { mode: "move", taskId: "b", startX: 0, startY: 0, moved: true, multiTasks };
      new MoveGestureStrategy().onMove({ clientX: -120, clientY: 0 } as PointerEvent, state, ctx);
      const byId = new Map(ctx.data.tasks.map((task) => [task.id, task]));
      expect(byId.get("b")!.start >= byId.get("a")!.end).toBe(true);
      expect(byId.get("c")!.start).toBe("2026-11-04");
    });
  });

  describe("ResizeGestureStrategy", () => {
    it.each(["FF", "SF"] as const)("keeps %s finish constraints when cascading is disabled", (type) => {
      const tasks: Task[] = [
        { id: "a", category: "dev", start: "2026-11-10", end: "2026-11-12" },
        { id: "b", category: "dev", start: "2026-11-02", end: "2026-11-15", dependsOn: [{ id: "a", type, lagDays: 0 }] }
      ];
      const { ctx } = createMockContext(tasks, { autoCascade: false });
      const state: DragState = { mode: "resize", taskId: "b", startX: 0, startY: 0, origStart: "2026-11-02", origEnd: "2026-11-15", moved: true };
      new ResizeGestureStrategy().onMove({ clientX: -280, clientY: 0 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks[1].end).toBe(type === "FF" ? "2026-11-12" : "2026-11-10");
      expect(ctx.data.tasks[1].start).toBe("2026-11-02");
    });

    it("snaps a resized finish to a working day", () => {
      const { ctx } = createMockContext([{ id: "a", category: "dev", start: "2026-11-04", end: "2026-11-06" }], { autoCascade: false });
      ctx.data.meta = { calendar: "standard" };
      const state: DragState = { mode: "resize", taskId: "a", startX: 0, startY: 0, origStart: "2026-11-04", origEnd: "2026-11-06", moved: true };
      new ResizeGestureStrategy().onMove({ clientX: 40, clientY: 0 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks[0].end).toBe("2026-11-09");
    });
    it("shrinks across a weekend to the previous working day", () => {
      const { ctx } = createMockContext([{ id: "a", category: "dev", start: "2026-11-04", end: "2026-11-09" }], { autoCascade: false });
      ctx.data.meta = { calendar: "standard" };
      const state: DragState = { mode: "resize", taskId: "a", startX: 0, startY: 0, origStart: "2026-11-04", origEnd: "2026-11-09", moved: true };
      new ResizeGestureStrategy().onMove({ clientX: -40, clientY: 0 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks[0].end).toBe("2026-11-06");
    });
    it("resizes task end date by delta days", () => {
      const strategy = new ResizeGestureStrategy();
      const tasks: Task[] = [
        { id: "t1", category: "dev", start: "2026-09-01", end: "2026-09-05" }
      ];
      const { ctx } = createMockContext(tasks);
      const state: DragState = {
        mode: "resize",
        taskId: "t1",
        startX: 100,
        startY: 100,
        origStart: "2026-09-01",
        origEnd: "2026-09-05",
        moved: true
      };

      // Drag right by 80px (+2 days)
      strategy.onMove({ clientX: 180, clientY: 100 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks[0].start).toBe("2026-09-01");
      expect(ctx.data.tasks[0].end).toBe("2026-09-07");
    });
  });

  describe("ProgressGestureStrategy", () => {
    it("updates progress percentage and syncs status", () => {
      const strategy = new ProgressGestureStrategy();
      const tasks: Task[] = [
        { id: "t1", category: "dev", start: "2026-09-01", end: "2026-09-11", progress: 0, status: "not-started" }
      ];
      const { ctx } = createMockContext(tasks);
      // Duration = 10 days * 40px/day = 400px bar width
      const state: DragState = {
        mode: "progress",
        taskId: "t1",
        startX: 100,
        startY: 100,
        origProgress: 0,
        moved: true
      };

      // Drag 200px (50% progress)
      strategy.onMove({ clientX: 300, clientY: 100 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks[0].progress).toBe(0.5);
      expect(ctx.data.tasks[0].status).toBe("in-progress");

      // Drag past bar width (100% progress)
      strategy.onMove({ clientX: 600, clientY: 100 } as PointerEvent, state, ctx);
      expect(ctx.data.tasks[0].progress).toBe(1);
      expect(ctx.data.tasks[0].status).toBe("completed");
    });
  });

  describe("SplitterGestureStrategy", () => {
    it("clamps new width between min and max bounds", () => {
      const strategy = new SplitterGestureStrategy();
      let reportedWidth = 0;
      const { ctx } = createMockContext([], {
        onSplitResize: (w) => {
          reportedWidth = w;
        }
      });
      const state: DragState = {
        mode: "split",
        startX: 300,
        startY: 100,
        origLabelWidth: 320,
        moved: true
      };

      strategy.onMove({ clientX: 350, clientY: 100 } as PointerEvent, state, ctx);
      expect(reportedWidth).toBe(370);

      // Clamp max 600
      strategy.onMove({ clientX: 1000, clientY: 100 } as PointerEvent, state, ctx);
      expect(reportedWidth).toBe(600);

      // Clamp min 180
      strategy.onMove({ clientX: -200, clientY: 100 } as PointerEvent, state, ctx);
      expect(reportedWidth).toBe(180);
    });
  });

  describe("MarqueeGestureStrategy", () => {
    it("clears selection when click does not drag (not moved)", () => {
      const strategy = new MarqueeGestureStrategy();
      let cleared = false;
      const { ctx } = createMockContext([], {
        clearSelection: () => {
          cleared = true;
        }
      });
      const state: DragState = {
        mode: "marquee",
        startX: 10,
        startY: 10,
        moved: false
      };

      strategy.onUp({} as PointerEvent, state, ctx);
      expect(cleared).toBe(true);
    });
  });
});
