---
"@ai-hero/sandcastle": minor
---

Add the Fabbit `RunStore` persistence seam and the concrete `runs/` filesystem
backend (`FsRunStore`). Materializes the interface locked in ticket 04: a plain
TS interface keyed by `(runId, nodeId, pathId)` with atomic `createRun`,
durable per-transition `state.json` writes (atomic-rename + fsync), append-only
streamed output logs, and recover-scan `listRuns()`. Exposed from the package
entry as `FsRunStore` + the `RunStore`/`NodeStatus`/`FlowStatus`/`NodeRecord`/
`RunSnapshot`/`RunSummary` types. Spec documented in `docs/run-store.md`. This
unblocks the MVP slice (ticket 05).