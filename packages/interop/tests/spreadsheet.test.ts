import { describe, it, expect } from "vitest";
import { exportSpreadsheetCsv, importSpreadsheetCsv } from "../src/spreadsheet.js";
import { detectOverAllocations } from "@jantt/core";
import type { JanttData } from "@jantt/core";

describe("Spreadsheet CSV Interoperability", () => {
  it("does not turn one percent progress into a completed task", () => {
    const plan: JanttData = { tasks: [{ id: "a", start: "2026-11-02", end: "2026-11-02", progress: 0.01 }] };
    expect(importSpreadsheetCsv(exportSpreadsheetCsv(plan)).tasks[0].progress).toBe(0.01);
    expect(importSpreadsheetCsv("ID,Start,End,Progress\na,2026-11-02,2026-11-02,0.5%").tasks[0].progress).toBe(0.005);
  });
  it("ignores malformed structured dependency fields instead of splitting them", () => {
    const parsed = importSpreadsheetCsv("ID,Start,End,DependsOn\na,2026-11-02,2026-11-03,\nb,2026-11-04,2026-11-05,json:[{bad");
    expect(parsed.tasks[1].dependsOn).toBeUndefined();
  });
  it("preserves assignees and allocation units for resource overload detection", () => {
    const original: JanttData = { tasks: [
      { id: "a", start: "2026-11-02", end: "2026-11-02", assignee: "alice", owner: "manager", allocation: 0.6 },
      { id: "b", start: "2026-11-02", end: "2026-11-02", assignee: "alice", allocation: 0.6 }
    ] };
    const result = importSpreadsheetCsv(exportSpreadsheetCsv(original));
    expect(result.tasks[0]).toMatchObject({ owner: "manager", assignee: "alice", allocation: 0.6 });
    expect(result.tasks[1]).toMatchObject({ assignee: "alice", allocation: 0.6 });
    expect(detectOverAllocations(result.tasks)).toHaveLength(1);
  });
  const plan: JanttData = {
    tasks: [
      { id: "A1", label: "Market Research, Phase 1", start: "2026-11-01", end: "2026-11-04", progress: 1, owner: "Sarah", category: "marketing" },
      { id: "A2", label: "UI Concept \"V2\"", start: "2026-11-05", end: "2026-11-10", progress: 0.45, owner: "Leo", category: "design", dependsOn: "A1:FS+1d", priority: "urgent" }
    ]
  };

  it("exports CSV with quotes, formulas and metadata", () => {
    const csv = exportSpreadsheetCsv(plan);

    expect(csv).toContain("ID,Label,Start,End,Progress,Category,Owner,DependsOn,Priority");
    expect(csv).toContain("\"Market Research, Phase 1\"");
    expect(csv).toContain("\"UI Concept \"\"V2\"\"\"");
    expect(csv).toContain("100%");
    expect(csv).toContain("45%");
    expect(csv).toContain("urgent");
  });

  it("imports CSV back into Jantt tasks cleanly", () => {
    const csv = exportSpreadsheetCsv(plan);
    const parsed = importSpreadsheetCsv(csv);

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].id).toBe("A1");
    expect(parsed.tasks[0].label).toBe("Market Research, Phase 1");
    expect(parsed.tasks[0].owner).toBe("Sarah");
    expect(parsed.tasks[0].progress).toBe(1);

    expect(parsed.tasks[1].id).toBe("A2");
    expect(parsed.tasks[1].label).toBe("UI Concept \"V2\"");
    expect(parsed.tasks[1].priority).toBe("urgent");
    expect(parsed.tasks[1].progress).toBe(0.45);
    expect(parsed.tasks[1].dependsOn).toBe("A1:FS+1d");
  });
});
