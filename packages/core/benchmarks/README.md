# Resource leveling benchmark

Build the core package, then run the benchmark from the repository root:

```sh
npm run build --workspace=@jantt/core
node packages/core/benchmarks/resource-leveling.mjs
```

Optional arguments select individual scenarios, for example:

```sh
node packages/core/benchmarks/resource-leveling.mjs 1000:50 1000:50:calendar 100:0:crowded
```

Arguments are `task-count:conflicting-pairs[:mode]`. In the default `plain` mode,
each pair shares a resource and starts on the same day; all other tasks have
separate resources. `calendar` uses the same fixture with a Monday–Friday
calendar and a holiday immediately after the initial task date. In `crowded`
mode all tasks share one resource; the pair count must be zero. Tasks have
one-day duration and no dependencies or locked tasks. The benchmark checks
that all expected conflicts are resolved and reports the median, minimum and
maximum of three runs after a small warmup. Times cover the leveling call only.

Example baseline on Apple M5 Pro, macOS arm64, Node 24.22.1 (milliseconds;
the larger scenarios were measured in a separate invocation):

| Tasks | Conflicting pairs | Mode | Median | Min–max |
| ---: | ---: | --- | ---: | ---: |
| 100 | 0 | plain | 1.2 | 1.2–1.5 |
| 100 | 25 | plain | 31.4 | 30.3–32.3 |
| 500 | 5 | plain | 33.6 | 33.4–35.9 |
| 1,000 | 5 | plain | 67.7 | 66.7–74.3 |
| 1,000 | 50 | plain | 583.9 | 573.7–616.1 |
| 500 | 5 | calendar | 110.6 | 110.5–115.4 |
| 1,000 | 50 | calendar | 2,049.2 | 2,044.7–2,087.8 |
| 100 | — | crowded | 156.9 | 156.3–160.0 |

These synthetic cases isolate a few dimensions; they do not measure browser
worker startup, rendering, dependencies, locked tasks, long durations or all
calendar combinations. Do not use these numbers as a universal latency
guarantee. A CPU sample of the 1,000-task calendar case and the crowded case
showed date validation and parsing among the largest self-time contributors;
sampling does not by itself establish the best optimization.

After replacing UTC `Date` construction in ISO date validation with Gregorian
month-length arithmetic, a separate run on the same machine produced:

| Tasks | Conflicting pairs | Mode | Before median | After median |
| ---: | ---: | --- | ---: | ---: |
| 1,000 | 0 | plain | 9.3 ms | 9.1 ms |
| 1,000 | 5 | plain | 67.7 ms | 62.8 ms |
| 1,000 | 50 | plain | 583.9 ms | 489.6 ms |
| 1,000 | 50 | calendar | 2,049.2 ms | 1,587.4 ms |
| 100 | — | crowded | 156.9 ms | 129.3 ms |

These are separate runs rather than controlled paired measurements; treat the
differences as indicative, not precise performance guarantees.

An experimental change reused the resource grouping from each conflict detection
pass when searching for a slot. On the same machine, separate runs before and
after that change gave these medians (three measurements per scenario):

| Tasks | Conflicting pairs | Mode | Before median | After median |
| ---: | ---: | --- | ---: | ---: |
| 1,000 | 50 | plain | 519.4 ms | 518.1 ms |
| 1,000 | 50 | calendar | 1,606.9 ms | 1,655.4 ms |
| 100 | — | crowded | 131.4 ms | 131.3 ms |

The change was not retained: these scenarios showed no clear benefit, and the
separate runs do not establish a meaningful calendar regression either. Other
workloads, including large people lists, have not been evaluated.

Reusing the CPM result of each accepted leveling trial produced the following
medians on the same machine, with three runs before and after the change:

| Tasks | Conflicting pairs | Mode | Before median | After median |
| ---: | ---: | --- | ---: | ---: |
| 1,000 | 50 | plain | 488.8 ms | 300.4 ms |
| 1,000 | 50 | calendar | 1,588.0 ms | 891.1 ms |
| 100 | — | crowded | 129.6 ms | 85.0 ms |

The runs were sequential, not paired; these results describe the synthetic
scenarios above and are not a guarantee for projects with dependencies or locks.
