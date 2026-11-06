// @vitest-environment jsdom
import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTaskDetailSidebar } from "../src/hooks/useTaskDetailSidebar";

it("shows a calendar error without committing or closing when save or delete fails", () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const task = { id: "a", start: "2026-11-02", end: "2026-11-03" };
  const invalid = { id: "b", start: "2026-11-02", end: "2026-11-03", calendarId: "missing" };
  const commit = vi.fn();
  const theme = { id: "test", label: "Test", name: "Test", mode: "light" as const, className: "", description: "", vars: {} };
  function App() {
    const { openTaskDetailSidebar } = useTaskDetailSidebar({ parsedData: { tasks: [task, invalid] }, activeTheme: theme, activeView: "tasks", handleChartCommit: commit });
    return <button onClick={() => openTaskDetailSidebar(task)}>Open</button>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  act(() => root.render(<App />));
  act(() => container.querySelector("button")!.click());
  const sidebar = document.querySelector<HTMLElement>(".jantt-sidebar-drawer")!;
  act(() => sidebar.querySelector<HTMLButtonElement>("#jantt-sidebar-save")!.click());
  expect(sidebar.querySelector('[role="alert"]')?.textContent).toContain("Unknown calendar 'missing'");
  act(() => sidebar.querySelector<HTMLButtonElement>("#jantt-sidebar-delete")!.click());
  expect(sidebar.querySelector('[role="alert"]')?.textContent).toContain("Unknown calendar 'missing'");
  expect(commit).not.toHaveBeenCalled();
  expect(sidebar.classList.contains("is-closing")).toBe(false);
  act(() => root.unmount());
  sidebar.closest(".jantt-sidebar-backdrop")?.remove();
  container.remove();
  confirm.mockRestore();
});
