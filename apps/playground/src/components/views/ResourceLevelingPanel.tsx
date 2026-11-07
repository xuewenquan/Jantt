import React from "react";
import { CalendarError, detectOverAllocations, getProjectFinish, getScheduleContext, levelResources, resolvePersonById, type JanttData, type LevelingResult } from "@jantt/core";

interface Props {
  data: JanttData;
  onCommit: (data: JanttData) => void;
  readOnly: boolean;
  onPromptFork?: () => void;
}

const formatPercent = (value: number): string => String(Math.round(value * 10000) / 100);

export const ResourceLevelingPanel: React.FC<Props> = ({ data, onCommit, readOnly, onPromptFork }) => {
  const [proposal, setProposal] = React.useState<LevelingResult | null>(null);
  const proposalSource = React.useRef<JanttData | null>(null);
  const [calculating, setCalculating] = React.useState(false);
  const [error, setError] = React.useState("");
  const [defaultPercent, setDefaultPercent] = React.useState("");
  const [capacityDraft, setCapacityDraft] = React.useState<Record<string, string>>({});
  const workerRef = React.useRef<Worker | null>(null);
  const options = React.useMemo(() => ({ ...getScheduleContext(data), defaultGapDays: data.meta?.defaultGapDays, targetDate: data.meta?.targetDate, defaultCapacity: data.meta?.defaultResourceCapacity, resourceCapacities: data.meta?.resourceCapacities }), [data]);
  const allocation = React.useMemo(() => {
    try { return { conflicts: detectOverAllocations(data.tasks, options), error: "" }; }
    catch (err) {
      if (!(err instanceof CalendarError)) throw err;
      return { conflicts: [], error: err.message };
    }
  }, [data.tasks, options]);
  const resources = React.useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const task of data.tasks) {
      if (task._deleted || !task.assignee) continue;
      const person = resolvePersonById(data.people, task.assignee);
      const id = person?.id || task.assignee;
      map.set(id, { id, name: person?.name || id });
    }
    return [...map.values()];
  }, [data]);
  React.useEffect(() => {
    setProposal(null);
    setError("");
    setCalculating(false);
    setDefaultPercent(data.meta?.defaultResourceCapacity === undefined ? "" : formatPercent(data.meta.defaultResourceCapacity));
    setCapacityDraft(Object.fromEntries(resources.map((resource) => {
      const capacity = data.meta?.resourceCapacities?.[resource.id] ?? data.meta?.resourceCapacities?.[resource.name];
      return [resource.id, capacity === undefined ? "" : formatPercent(capacity)];
    })));
    return () => { workerRef.current?.terminate(); workerRef.current = null; };
  }, [data, resources]);

  const saveCapacities = () => {
    if (readOnly) { onPromptFork?.(); return; }
    const values = [defaultPercent, ...Object.values(capacityDraft)];
    if (values.some((value) => value.trim() !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0))) {
      setError("Resource capacities must be non-negative numbers.");
      return;
    }
    const capacities = { ...data.meta?.resourceCapacities };
    for (const resource of resources) {
      delete capacities[resource.id];
      if (resource.name !== resource.id) delete capacities[resource.name];
      const value = capacityDraft[resource.id]?.trim();
      if (value) capacities[resource.id] = Number(value) / 100;
    }
    onCommit({ ...data, meta: { ...data.meta,
      defaultResourceCapacity: defaultPercent.trim() ? Number(defaultPercent) / 100 : undefined,
      resourceCapacities: Object.keys(capacities).length ? capacities : undefined
    } });
  };

  const preview = () => {
    setProposal(null);
    proposalSource.current = data;
    setError("");
    if (typeof Worker === "undefined") {
      try { setProposal(levelResources(data.tasks, options)); }
      catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      return;
    }
    try {
      const worker = new Worker(new URL("../../workers/resource-leveling.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      setCalculating(true);
      worker.onmessage = (event: MessageEvent<{ result?: LevelingResult; error?: string }>) => {
        if (workerRef.current !== worker) return;
        if (event.data.error) setError(event.data.error);
        else if (event.data.result) setProposal(event.data.result);
        setCalculating(false);
        worker.terminate();
        workerRef.current = null;
      };
      worker.onerror = (event) => {
        if (workerRef.current !== worker) return;
        setError(event.message || "Resource leveling could not be completed.");
        setCalculating(false);
        worker.terminate();
        workerRef.current = null;
      };
      worker.postMessage({ tasks: data.tasks, options });
    } catch (err) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setCalculating(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Invalidate during render, before the effect clears an old proposal or worker.
  const currentProposal = proposalSource.current === data ? proposal : null;
  const changes = currentProposal?.tasks.flatMap((task) => {
    const original = data.tasks.find((item) => item.id === task.id);
    return original && (original.start !== task.start || original.end !== task.end) ? [{ original, task }] : [];
  }) || [];
  const beforeFinish = getProjectFinish(data.tasks);
  const afterFinish = currentProposal ? getProjectFinish(currentProposal.tasks) : "";

  return (
    <section aria-label="Resource leveling" style={{ margin: "12px 0", padding: 16, border: "1px solid var(--jantt-border)", borderRadius: 8 }}>
      <strong>Resource leveling</strong>
      <p style={{ margin: "8px 0" }}>
        {!allocation.error && <>{allocation.conflicts.length} resource-day overload{allocation.conflicts.length === 1 ? "" : "s"} across the full project. </>}
        Default resource capacity: {formatPercent(options.defaultCapacity ?? 1)}% per person.
      </p>
      {allocation.error && <p role="alert">{allocation.error}</p>}
      <details style={{ marginBottom: 12 }}>
        <summary>Resource capacity settings</summary>
        <p>Enter percentages; leave an override blank to use the default.</p>
        <label>Default capacity (%) <input aria-label="Default capacity (%)" type="number" min="0" step="any" placeholder="100" value={defaultPercent} onChange={(event) => setDefaultPercent(event.target.value)} /></label>
        {resources.map((resource) => <div key={resource.id}>
          <label>{resource.name} capacity (%) <input aria-label={`${resource.name} capacity (%)`} type="number" min="0" step="any" placeholder={defaultPercent || "100"} value={capacityDraft[resource.id] || ""} onChange={(event) => setCapacityDraft((draft) => ({ ...draft, [resource.id]: event.target.value }))} /></label>
        </div>)}
        <button type="button" className="btn-nav" onClick={saveCapacities}>Save capacities</button>
      </details>
      <button type="button" className="btn-nav" onClick={preview} disabled={calculating || Boolean(allocation.error)}>
        {calculating ? "Calculating…" : "Preview leveling"}
      </button>
      {error && <p role="alert">{error}</p>}
      {currentProposal && (
        <div aria-live="polite" style={{ marginTop: 12 }}>
          <p><strong>{currentProposal.failed ? "Leveling failed" : currentProposal.remainingOverallocations.length ? "Overloads remain" : "No overloads remain"}</strong></p>
          {!currentProposal.failed && <><p>{currentProposal.adjustments.length} resource adjustment{currentProposal.adjustments.length === 1 ? "" : "s"}; {currentProposal.remainingOverallocations.length} resource-day overload{currentProposal.remainingOverallocations.length === 1 ? "" : "s"} remain. Project finish {currentProposal.daysAdded ? `extends by ${currentProposal.daysAdded} calendar day(s)` : "does not extend"}.</p>
          <p>Project finish: {beforeFinish || "-"} → {afterFinish || "-"}. {data.meta?.targetDate && <>Target: {data.meta.targetDate}. {afterFinish && (afterFinish > data.meta.targetDate ? "Preview exceeds the target date." : "Preview meets the target date.")}</>}</p></>}
          {currentProposal.failed && <p>This preview is invalid and cannot be applied.{changes.length > 0 && " The dates below are from dependency resolution."}</p>}
          {changes.length > 0 && (
            <ul>{changes.map(({ original, task }) => {
              const adjustments = currentProposal.adjustments.filter((adjustment) => adjustment.taskId === task.id);
              return <li key={task.id}>{task.label || task.id}: {original.start}–{original.end} → {task.start}–{task.end}
                {adjustments.length ? <ul>{adjustments.map((adjustment, index) => <li key={index}>Resource: {adjustment.resourceId}. {adjustment.reason} {adjustment.withinFloat ? "Within float at the time of adjustment." : "Outside float at the time of adjustment."}</li>)}</ul> : <> - Schedule change (dependency cascade or initial scheduling).</>}
              </li>;
            })}</ul>
          )}
          {currentProposal.remainingOverallocations.length > 0 && <div>
            <strong>Remaining overloads</strong>
            <ul>{currentProposal.remainingOverallocations.slice(0, 20).map((item) => {
              const diagnostic = currentProposal.conflictDiagnostics?.find((entry) => entry.resourceId === item.resourceId && entry.date === item.date);
              return <li key={`${item.resourceId}-${item.date}`}>{item.resourceId}, {item.date}: {formatPercent(item.totalUnits)}% allocated / {formatPercent(item.capacity)}% available ({item.tasks.join(", ")}){Boolean(diagnostic?.lockedTaskIds.length) && <>. Locked tasks: {diagnostic!.lockedTaskIds.join(", ")}.</>}{Boolean(diagnostic?.overCapacityTaskIds.length) && <> Tasks exceeding capacity individually: {diagnostic!.overCapacityTaskIds.join(", ")}.</>}{diagnostic?.status === "iteration_limit" && <> Leveling reached its iteration limit.</>}</li>;
            })}</ul>
            {currentProposal.remainingOverallocations.length > 20 && <p>And {currentProposal.remainingOverallocations.length - 20} more resource-days.</p>}
          </div>}
          {currentProposal.unresolvedReasons?.map((reason, index) => <p key={index} role="status">{reason}</p>)}
          {!currentProposal.failed && <p>The preview uses a heuristic and does not split tasks. Review remaining conflicts before applying.</p>}
          <button type="button" className="btn-nav is-primary" disabled={currentProposal.failed || changes.length === 0} onClick={() => {
            if (proposalSource.current !== data || currentProposal.failed) return;
            if (readOnly) { onPromptFork?.(); return; }
            onCommit({ ...data, tasks: currentProposal.tasks });
            setProposal(null);
          }}>Apply preview</button>
        </div>
      )}
    </section>
  );
};
