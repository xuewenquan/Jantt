// @vitest-environment jsdom
import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TasksView } from "../src/components/views/TasksView";
import { useTaskActions } from "../src/hooks/useTaskActions";

it.each(["cards", "todo"] as const)("reports calendar errors when adding or deleting from %s view", (mode) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const data = { tasks: [
    { id: "a", label: "Task A", start: "2026-11-02", end: "2026-11-03" },
    { id: "b", label: "Task B", start: "2026-11-02", end: "2026-11-03", calendarId: "missing" }
  ] };
  const commit = vi.fn();
  const toast = vi.fn();
  const update = vi.fn();
  function App() {
    const actions = useTaskActions({ parsedData: data, setParsedData: update, setJsonText: update, setValidationResult: update,
      dateFilterMode: "all", dateFilterBehavior: "dim", isTaskMatchingDateFilter: () => true,
      effectivePeople: [], teams: [], initialKanbanSort: [], handleChartCommit: commit, showToast: toast });
    return <TasksView parsedData={data} dateFilterMode="all" dateFilterBehavior="dim" isTaskMatchingDateFilter={() => true}
      tasksSearchQuery="" setTasksSearchQuery={update} tasksViewMode={mode} setTasksViewMode={update}
      selectedPersonFilter="all" setSelectedPersonFilter={update} teams={[]} effectivePeople={[]}
      handleAddNewTask={actions.handleAddNewTask} onScheduleError={actions.handleScheduleError} setDateFilterMode={update}
      openTaskDetailSidebar={update} handleChartCommit={commit} />;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<App />));
  const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Task"));
  expect(add).toBeDefined();
  act(() => add!.click());
  expect(toast).toHaveBeenLastCalledWith(expect.stringContaining("Unknown calendar 'missing'"), true);
  const deletes = container.querySelectorAll<HTMLButtonElement>('button[title="Delete task"]');
  expect(deletes).toHaveLength(2);
  act(() => deletes[0].click());
  expect(toast).toHaveBeenCalledTimes(2);
  expect(toast).toHaveBeenLastCalledWith(expect.stringContaining("Unknown calendar 'missing'"), true);
  expect(commit).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  act(() => deletes[1].click());
  expect(commit).toHaveBeenCalledOnce();
  expect(commit.mock.calls[0][0].tasks.map((task: { id: string }) => task.id)).toEqual(["a"]);
  expect(toast).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
  container.remove();
});
