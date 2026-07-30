# Fabbit RunStore — `runs/` filesystem backend

Resolution of [07 — runs/ filesystem RunStore backend](https://github.com/michaelahoff/fabbit/issues/8). Implements the `RunStore` interface locked in [04 — Engine](https://github.com/michaelahoff/fabbit/issues/4).

The `RunStore` seam (`src/engine/run-store.ts`) is a plain TypeScript interface — deliberately **not** an Effect service — keyed by `(runId, nodeId, pathId)`. `pathId` is load-bearing in the key: a feedback re-entry is the same `nodeId` on a new `pathId`. The concrete adapter is `FsRunStore` (`src/engine/fs-run-store.ts`), scoped under a configurable `root` directory.

## Directory layout

```
<root>/runs/<runId>/flow.json                    # immutable snapshot (byte-identical to createRun's arg)
<root>/runs/<runId>/state.json                    # mutable run + node status, keyed by `${nodeId}:${pathId}`
<root>/runs/<runId>/nodes/<nodeId>-<pathId>.log   # append-only streamed output via appendOutput
<root>/runs/.<runId>.tmp-<rand>/                  # createRun staging dir (never visible to listRuns)
```

- **`flow.json`** is written once by `createRun` and never mutated for the run's lifetime. The store treats it as opaque — it does not validate the flow (that's the DAG schema's job) and round-trips it byte-identical through `getFlow`. `flowId` for `RunSummary` is best-effort-read from `flow.meta.id`.
- **`state.json`** holds run-level status (`running`/`complete`/`paused`/`aborted`/`failed`), the opaque root `input`, `abortReason`, `metrics`, and a `nodes` map keyed by `${nodeId}:${pathId}` → `NodeRecord` (`status`, `port`, `output`, `resumeToken`, `metrics`).
- **`<nodeId>-<pathId>.log`** is the append-only streamed output for one node on one path. `nodeId`/`pathId` are sanitized for the filename (path separators → `_`); the `state.json` key keeps the raw ids. UUID-shaped ids pass through untouched.

## Crash-safety

| Operation                                                              | Strategy                                                                                             | Guarantee                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `createRun`                                                            | Stage under `runs/.<runId>.tmp-<rand>/`, fsync, `rename` → `runs/<runId>/`, fsync dir                | A `listRuns()`/recover scan never sees a half-built run; a crash leaves a stranded dot-prefixed staging dir that is skipped. |
| `setNodeStatus` / `setNodeRecord` / `setResumeToken` / `setFlowStatus` | Read-modify-write `state.json` via atomic-rename: write `state.json.tmp`, fsync, `rename`, fsync dir | A crash mid-write never corrupts `state.json`; the last-committed state is always intact.                                    |
| `appendOutput`                                                         | Open log `"a"`, write chunk, fsync fd                                                                | Streamed output survives a crash up to the last appended byte.                                                               |

The **sync-write-after-each-transition** policy — _when_ to call these mutators — is the engine's, not the store's (per #4). The store only guarantees each call is durable on resolve.

## Recover scan

`listRuns()` enumerates `<root>/runs/*/state.json` and returns a `RunSummary[]` (`runId`, `flowId`, `status`, `startedAt`), skipping dot-prefixed staging dirs and any unparseable `state.json`. `Engine.recover()` (ticket 04, deferred fog) uses this to decide per-non-terminal run whether to resume (`resumeToken` present, non-idempotent), re-invoke cold (idempotent), or mark `crash-recovery-required` (human). That decision logic is engine policy; the store only surfaces consistent state.

## Interface

```ts
export interface RunStore {
  createRun(runId: string, flow: unknown, input: unknown): Promise<void>;
  getFlow(runId: string): Promise<unknown>;
  getSnapshot(runId: string): Promise<RunSnapshot>;
  setFlowStatus(
    runId: string,
    status: FlowStatus,
    abortReason?: unknown,
  ): Promise<void>;
  setNodeStatus(
    runId: string,
    nodeId: string,
    pathId: string,
    status: NodeStatus,
  ): Promise<void>;
  setNodeRecord(runId: string, record: NodeRecord): Promise<void>;
  getNodeRecord(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<NodeRecord | undefined>;
  setResumeToken(
    runId: string,
    nodeId: string,
    pathId: string,
    token: string,
  ): Promise<void>;
  getResumeToken(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<string | undefined>;
  appendOutput(
    runId: string,
    nodeId: string,
    pathId: string,
    chunk: string,
  ): Promise<void>;
  getOutput(runId: string, nodeId: string, pathId: string): Promise<string>;
  listRuns(): Promise<RunSummary[]>;
  deleteRun(runId: string): Promise<void>;
}
```

Full type definitions: `src/engine/run-store.ts`.

## Reuse from sandcastle

- `node:fs/promises` (`mkdir`/`rename`/`writeFile`/`open`) — same fs style as `src/syncOut.ts`, `src/Display.ts`.
- No sandcastle atomic-write helper existed; the `atomicWriteJson` / `syncDir` helpers here are local and shallow by design (the adapter stays a thin, deep-only-in-crash-safety module; per #8's "the adapter is shallow by design — keep it that way").
- Fabbit's `runs/` is its own namespace, distinct from sandcastle's `.sandcastle/logs/` and `~/.claude/projects/…` agent-session storage — no path reuse, deliberately.
