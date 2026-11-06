import { describe, expect, it } from "vitest";
import { getTaskDependencyRelations } from "@jantt/core";
import type { JanttData } from "@jantt/core";
import { exportMsProjectXml, importMsProjectXml } from "../src/ms-project.js";
import { exportPrimaveraXer, importPrimaveraXer } from "../src/primavera.js";
import { exportSpreadsheetCsv, importSpreadsheetCsv } from "../src/spreadsheet.js";

const plan: JanttData = {
  meta: { defaultGapDays: 3 },
  tasks: [
    { id: "t1", start: "2026-11-02", end: "2026-11-03" },
    { id: "t2", start: "2026-11-02", end: "2026-11-03" },
    { id: "t3", start: "2026-11-02", end: "2026-11-03", dependsOn: ["t1", { id: "t2", type: "SS", lag: 0 }] },
    { id: "t4", start: "2026-11-02", end: "2026-11-03", dependsOn: "t1:FF-1d,t2:SF+2d" }
  ]
};

describe("dependency interchange", () => {
  it.each([
    ["Microsoft Project", (p: JanttData) => importMsProjectXml(exportMsProjectXml(p))],
    ["Primavera", (p: JanttData) => importPrimaveraXer(exportPrimaveraXer(p))],
    ["CSV", (p: JanttData) => importSpreadsheetCsv(exportSpreadsheetCsv(p))]
  ] as const)("preserves parallel relationship types and lags in %s", (_name, roundTrip) => {
    const input: JanttData = { tasks: [
      { id: "t1", start: "2026-11-02", end: "2026-11-03" },
      { id: "t2", start: "2026-11-02", end: "2026-11-03", dependsOn: [
        { id: "t1", type: "FS", lag: -1 }, { id: "t1", type: "SS", lag: 0 },
        { id: "t1", type: "FF", lag: 2 }, { id: "t1", type: "SF", lag: 3 }
      ] }
    ] };
    const result = roundTrip(input);
    expect(getTaskDependencyRelations(result.tasks[1]).map(({ id, type, lagDays }) => ({ id, type, lagDays }))).toEqual([
      { id: "t1", type: "FS", lagDays: -1 }, { id: "t1", type: "SS", lagDays: 0 },
      { id: "t1", type: "FF", lagDays: 2 }, { id: "t1", type: "SF", lagDays: 3 }
    ]);
  });
  it("preserves a typed CSV dependency whose predecessor ID contains an arrow", () => {
    const data: JanttData = { tasks: [
      { id: "a->b", start: "2026-11-02", end: "2026-11-03" },
      { id: "c", start: "2026-11-02", end: "2026-11-03", dependsOn: [{ id: "a->b", type: "SS", lag: -1 }] }
    ] };
    const result = importSpreadsheetCsv(exportSpreadsheetCsv(data));
    expect(getTaskDependencyRelations(result.tasks.find((task) => task.id === "c")!)).toEqual([{ id: "a->b", type: "SS", lagDays: -1 }]);
  });
  it("preserves CSV dependencies whose IDs contain list delimiters", () => {
    const data: JanttData = { tasks: [
      { id: "a,b", start: "2026-11-02", end: "2026-11-03" },
      { id: "c;d", start: "2026-11-02", end: "2026-11-03" },
      { id: "e", start: "2026-11-02", end: "2026-11-03", dependsOn: [{ id: "a,b", type: "FF", lag: -1 }, { id: "c;d", type: "SS", lag: 0 }] }
    ] };
    const result = importSpreadsheetCsv(exportSpreadsheetCsv(data));
    expect(getTaskDependencyRelations(result.tasks.find((task) => task.id === "e")!)).toEqual([
      { id: "a,b", type: "FF", lagDays: -1 }, { id: "c;d", type: "SS", lagDays: 0, explicitZeroLag: true }
    ]);
  });
  it.each([
    ["Microsoft Project", (p: JanttData) => importMsProjectXml(exportMsProjectXml(p))],
    ["Primavera", (p: JanttData) => importPrimaveraXer(exportPrimaveraXer(p))],
    ["CSV", (p: JanttData) => importSpreadsheetCsv(exportSpreadsheetCsv(p))]
  ] as const)("preserves effective per-link lags in %s", (_name, roundTrip) => {
    const result = roundTrip(plan);
    const relations = (id: string) => getTaskDependencyRelations(result.tasks.find((t) => t.id === id)!)
      .map(({ id: predecessor, type, lagDays }) => ({ id: predecessor, type, lagDays }));
    expect(relations("t3")).toEqual([{ id: "t1", type: "FS", lagDays: 3 }, { id: "t2", type: "SS", lagDays: 0 }]);
    expect(relations("t4")).toEqual([{ id: "t1", type: "FF", lagDays: -1 }, { id: "t2", type: "SF", lagDays: 2 }]);
    expect(getTaskDependencyRelations(result.tasks.find((t) => t.id === "t3")!)[1].explicitZeroLag).toBe(true);
  });
});
