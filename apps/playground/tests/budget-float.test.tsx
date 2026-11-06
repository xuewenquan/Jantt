// @vitest-environment jsdom
import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { BudgetKpiView } from "../src/components/views/BudgetKpiView";

describe("budget view float", () => {
  it.each([["2026-08-30", "-4d (Bottleneck)"], ["2026-09-06", "3d (Bottleneck)"]])("shows actual float for target %s", (targetDate, expected) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const tasks = [{ id: "a", category: "dev", start: "2026-09-01", end: "2026-09-03" }];
    act(() => root.render(<BudgetKpiView parsedData={{ meta: { targetDate }, tasks }} summaryKpiTasks={tasks}
      summarySortConfig={{ column: "start", direction: "asc" }} setSummarySortConfig={vi.fn()} handleSummarySort={vi.fn()}
      sortedSummaryTasks={tasks} isTaskMatchingDateFilter={() => true} effectivePeople={[]} teams={[]} />));
    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain("Zero buffer (delaying these delays project)");
    act(() => root.unmount());
    container.remove();
  });
});
