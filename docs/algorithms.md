# Jantt Algorithms & Mathematical Specifications

This document outlines the core scheduling, graph traversal, and coordinate routing algorithms implemented in `@jantt/core`.

---

## 1. Schedule Cascade & Constraint Resolver

`resolveSchedule` moves tasks forward to satisfy all their dependency constraints while preserving their duration. For a predecessor P and successor S, the four relationships require the following, with the relationship's lag added to the predecessor date:

| Type | Constraint |
| --- | --- |
| FS | S.start ≥ P.finish + lag |
| SS | S.start ≥ P.start + lag |
| FF | S.finish ≥ P.finish + lag |
| SF | S.finish ≥ P.start + lag |

Each relationship has its own lag. An explicit zero lag remains zero; an omitted lag uses the successor's effective gap. Positive lag delays the successor and negative lag is a lead. With no working calendar, dates and durations use calendar days. When a calendar is active, task duration and float use the task's calendar and relationship lag uses the successor's calendar. Task starts are moved to the next working day. Task calendars take precedence over assignee calendars, which take precedence over the project calendar. Explicit holidays and calendar exceptions are respected. A zero-lag FS relationship permits the successor to start on the predecessor's finish date, subject to the successor calendar. Working-day differences count whole weeks arithmetically when the calendar has no holidays, exceptions, or region; calendars with date-specific exceptions scan at most 100,000 days, and `addWorkingDays` stops after 200,000 day steps, raising a `CalendarError` instead of returning a partial result.

An explicit calendar reference must name a built-in preset or a calendar in the project; unknown references produce a validation or calculation error rather than silently using another calendar. Calendar definitions are validated too: `workingDays` must be a non-empty array of weekday numbers from 0 to 6, and holidays and exceptions need valid ISO dates.

Locked tasks do not move. Pipeline diagnostics report locked tasks whose dependency constraints cannot be satisfied; a locked task that only starts on a non-working day is not treated as a dependency violation. Cyclic graphs are not cascaded and CPM returns an error rather than a calculated critical path. Missing dependencies are ignored by the resolver; the pipeline sanitizes them while preserving the remaining relationships.

## 2. Critical Path Analysis

`calculateCriticalPath` applies the same four relationship constraints and calendar rules in forward and backward passes. It treats each input start as a not-before date. The project early finish is the latest early finish of all tasks. The backward pass uses the target date when supplied, otherwise the early finish, and accounts for each successor constraint. Set `meta.targetDate` to use the same target in the chart, resource leveling, and project report. In mixed calendars the latest feasible predecessor date is found by inverting the actual date constraint, rather than assuming that adding and subtracting working days are reversible.

Critical task and dependency sets cover the whole graph. To prevent exponential memory and runtime growth in heavily branching graphs, at most 1,000 explicit paths are returned by default; `maxCriticalPaths` changes that limit and `criticalPathsTruncated` reports when additional paths exist.

For relationship-level highlighting, test `criticalRelationKeys` with `dependencyRelationKey(predecessorId, successorId, relation)`, where `relation` comes from `getTaskDependencyRelations`. The legacy `criticalDepKeys` uses `from->to` strings: it cannot distinguish parallel relationships and can collide when IDs contain `->`. `calculateCriticalPath` returns an empty `criticalRelationKeys` set for an empty graph or an error; check `errors` before interpreting the result.

Total float measures the difference between early and late starts in the task's working days, or calendar days when no calendar is active. Free float measures how far the task can move without delaying any successor or the project early finish; it is independent of a later contractual target. Critical and near-critical tasks and driving links are derived from these calculations.

Readiness indicators use recorded predecessor progress: FS requires a finished predecessor and SS requires a started predecessor; FF and SF constrain finishing rather than starting. Relationships with a negative lag are not treated as start blockers. These indicators do not determine whether a positive lag has elapsed because actual event dates are not recorded, so they are not a substitute for checking lag timing.

## Resource allocation and leveling

Allocation detection adds each assigned task's units on active dates and compares the sum with the resource capacity. Task endpoints are inclusive for allocation; non-working dates are excluded when the task has an active calendar. A person's own calendar sets their capacity to zero on non-working dates, even when a task uses a different calendar. A single task can exceed capacity. Known person IDs and names are grouped as one resource; lookup matches the ID exactly, then the trimmed name case-insensitively. The leveling heuristic delays lower-priority tasks, respects calendars and dependencies, and checks locked successors before accepting a move. For an individually assigned task on an unavailable resource, it searches up to 366 task-calendar days plus seven days for each explicit resource holiday or exception for an uninterrupted slot. Tasks are not split. Unresolved conflicts do not prevent the engine from attempting other conflicts; remaining overloads and reasons are returned. The heuristic does not guarantee finding a feasible schedule even when one exists, or finding an optimal schedule.

Use `task.allocation` for demand and `meta.defaultResourceCapacity` or `meta.resourceCapacities` (keyed by person ID or name) for capacity. The unit `1` means 100%. The resource preview and worker client read these settings from project JSON; explicit worker options override them.

For overlapping tasks, the leveler searches forward for a resource-capacity slot before cascading successors. It can use non-working dates within an overlapping task's calendar instead of always waiting for that task to finish. A move that recreates the same two-task conflict through cascading is rejected. When future bookings prevent a constrained task from moving without violating a locked successor, the leveler tries moving one or two bookings after it and rechecks all locked dependencies; at most 256 pairs are attempted. The default pass limit is twice the task count, bounded between 50 and 1,000; callers can set `maxIterations`, and any unresolved overloads are returned.
A move that introduces a new conflict with a locked booking is accepted only when the conflicting flexible task can be shifted past that booking into a schedule that still satisfies every locked dependency; otherwise another candidate is tried. Repeated conflicts favor a different movable task to reduce cascading loops. These rules remain heuristic and can themselves rule out a feasible sequence of moves.

Project JSON retains calendar definitions and holiday exceptions. The current Microsoft Project XML, Primavera XER, and CSV converters preserve effective dependency types and lags but do not transfer calendars or holiday definitions; use JSON when those settings must survive export and import. Microsoft Project XML import assigns new task IDs from XML UIDs and reconnects dependencies to those IDs.

CSV uses ordinary dependency expressions for IDs without commas or semicolons. If an ID contains either delimiter, its dependency field uses a `json:`-prefixed JSON array so Jantt can restore it without splitting the ID; other CSV consumers may need to handle this representation explicitly.
CSV also retains each task's assignee and allocation units in separate columns. Resource capacity settings and people records are not transferred; use JSON to retain them.

---

## 3. 90-Degree Orthogonal Step Line Router

Dependency connector paths are generated using crisp 90-degree orthogonal step lines:

```
Case A: Forward Flow (toX >= fromX + 28px)

 (fromX, fromY) ─────────┐ (midX, fromY)
                         │
                         │ (midX, toY)
                         └────────► (toX, toY)

 Path: M fromX fromY L midX fromY L midX toY L toX toY
```

```
Case B: Reverse / Lane Bypass Flow (toX < fromX + 28px)

 (fromX, fromY) ────┐ (fromX + 14, fromY)
                    │
 (toX - 14, midY) ┌─┘ (fromX + 14, midY)
                  │
                  └───────► (toX, toY)

 Path: M fromX fromY L (fromX+14) fromY L (fromX+14) midY L (toX-14) midY L (toX-14) toY L toX toY
```

---

## 4. Cursor-Anchored Zoom Transformation

When expanding or contracting the timeline (via Ctrl+Wheel, zoom slider, or column header drag), Jantt guarantees that the exact calendar date or column beneath the mouse pointer remains stationary:

1. **Mouse Content Coordinate**:
   $$X_{\text{mouse}} = \text{clientX} - \text{bodyRect.left}$$
   $$X_{\text{content}} = X_{\text{mouse}} + \text{bodyWrap.scrollLeft}$$

2. **Scale Ratio Calculation**:
   $$\text{ratio} = \frac{\text{newDayWidth}}{\text{prevDayWidth}}$$

3. **New Scroll Anchor**:
   $$\text{newScrollLeft} = \max\left(0, X_{\text{content}} \times \text{ratio} - X_{\text{mouse}}\right)$$

This mathematical transform completely eliminates visual jumping and orientation loss during zooming.

---

## 5. Assignee & Owner Auto-Discovery Engine

To support zero-friction import of raw schedule plans (e.g. from AI models, spreadsheets, or student pipelines), Jantt implements an automated entity inference engine:

1. **Scanning**:
   - Extract primary candidate/lead from `data.meta.person` $\to$ default role `"Project Lead / Owner"`.
   - Extract all unique non-empty string values from `data.tasks[].assignee`.
   - Extract all unique non-empty string values from `data.documents[].owner`.

2. **Deduplication & Slug Generation**:
   - Normalize names case-insensitively.
   - Generate URL-safe kebab slugs: $\text{slug} = \text{toLowerCase}(name) \to \text{regex replace } [^a-z0-9]+ \to -$.
   - Cross-check against explicit entries in `data.people[]`.

3. **Avatar & Metadata Assignment**:
   - Discovered members not in `data.people[]` are tagged `isInferred: true`.
   - Stable deterministic color assignment from the curated 8-color palette:
     $$\text{color} = \text{PALETTE}[\text{index} \pmod 8]$$
   - Discovered members immediately populate member filters, Kanban squad cards, and the People Manager modal with 1-click JSON persistence.

