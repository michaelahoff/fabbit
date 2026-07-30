# Fabbit Engine — DAG Walk, Dispatch, Checkpoint, Crash-Resume & Abort

The runtime that walks a canonical **flow**, dispatches each node to its `NodeRunner`, threads `RunCtx` through, persists transitions to `RunStore`, and crash-resumes. One engine, invoked by both the programmatic API and the CLI. Input: a `Flow` (from [dag-schema.md](./dag-schema.md)) + run inputs. Output: a `FlowRunResult` with per-node outcomes + flow-level status.

Resolution of [04 — Engine: walk the DAG, dispatch to runners, checkpoint via RunStore](https://github.com/michaelahoff/fabbit/issues/4).

## Engine module

```ts
class Engine {
  constructor(reg: Registry, store: RunStore); // deps injected — testable
  run(flow: Flow, input: unknown, opts?: RunOpts): Promise<FlowRunResult>; // start a new run
  resume(
    runId: string,
    resumeInput: unknown,
    opts?: RunOpts,
  ): Promise<FlowRunResult>; // re-enter a paused run
  recover(): Promise<RecoverResult>; // crash-resume — scan runs/ on startup
}

type RunOpts = { signal?: AbortSignal; streams?: StreamSink[] };

type FlowRunResult = {
  runId: string;
  status: FlowStatus;
  nodes: NodeOutcome[]; // per-node outcomes; flattened (pathId on each — no separate paths[] dimension)
  metrics: FlowRunMetrics;
  abortReason?: unknown; // present iff status === "aborted"; signal.reason verbatim (no Fabbit wrapping)
};

type FlowStatus = "complete" | "paused" | "aborted" | "failed";
// "failed" is flow-level ONLY — a gate selecting on-failure is data (flow continues via feedback), not failure.
// "paused" at flow level means at least one path is paused (others may have completed).

type NodeOutcome = {
  nodeId: string;
  pathId: string;
  status: NodeOutcomeStatus;
  port?: string; // the output port the node completed on
  output?: Record<string, unknown>;
  metrics?: NodeRunMetrics;
  pauseKind?: PauseKind; // present iff status === "paused"
};

type NodeOutcomeStatus =
  | "complete"
  | "paused"
  | "skipped"
  | "running"
  | "aborted";
// "aborted" — killed mid-execution (caller-abort or race-abort); distinct from "skipped" (never ran).

type FlowRunMetrics = { totalDurationMs?: number }; // per-node metrics live on each NodeOutcome.metrics
```

`resume` is a separate top-level method (not an overload of `run`): a resume re-enters an existing run-id at a paused node, `run` starts a new run. Different semantics, different inputs — two methods, each deep.

`recover()` is a top-level method called explicitly at startup (not auto-run in the constructor, which stays side-effect-free). It scans `RunStore.listRuns()` for `running`/`paused` runs and acts per the crash-resume rules below, using `resume` under the hood for `paused` runs. The shape of `RecoverResult` ("list of run-ids + the action taken per run") is deferred until the CLI surfaces what it needs to display.

## Dispatch contract — `NodeRunResult` & `NodeRunFn`

The engine dispatches to `NodeRunner.run`; the runner returns one of two statuses. **Uniform-out, polymorphic-in:** the result shape is identical across all three node classes (one `port` + `output`); the input shape is class-specific.

```ts
type NodeRunResult =
  | {
      status: "complete";
      port: string;
      output: Record<string, unknown>;
      resumeToken?: string;
      metrics?: NodeRunMetrics;
    }
  | {
      status: "paused";
      pauseKind: PauseKind;
      resumeToken?: string;
      payload: unknown;
      metrics?: NodeRunMetrics;
    };

type NodeRunMetrics = {
  sessionId?: string;
  usage?: IterationUsage;
  durationMs?: number;
}; // extensible

type PauseKind = "human" | "crash-recovery"; // extensible — timeout/error/agent-split graduate from fog
```

- **`port` unifies all three classes.** action → `"out"`; branch → the selected port (`"on-success"` / `"on-failure"` / …); merge → `"out"`. The engine reads `port` to find the outgoing edge(s) to fire — one dispatch shape, no per-class return variant.
- **`output`** is that port's field payload (matches `entry.outputPorts[port]` field names; engine runtime-validates as defense-in-depth).
- **`resumeToken` on `complete`** (optional): a non-idempotent node hands the engine a token (e.g. the `opencode` runner stores sandcastle's `IterationResult.sessionId`) so it can be resumed later — on a feedback re-entry or crash-recovery — rather than re-invoked cold. Idempotent nodes omit it → engine re-invokes cold.
- **`status: "paused"`** — the runner yields control deliberately (runner-initiated). `payload` is kind-dependent (human: the diff/question; crash-recovery: the last state), typed per-kind later via a discriminated union when the vocabulary grows; `unknown` now avoids pre-slicing. `resumeToken` optional here too — a stateless pause (e.g. `human-review`) is resumable via cold re-invocation + `ctx.resumeInput`; a stateful pause (paused agent mid-session) carries a token.
- **No `status: "failed"`** — flow-level failure is _data_ (`complete` with `exitCode: 1` → a `gate` routes), per the MVP pattern. Engine-level defects are thrown and caught at the flow boundary. A `failed` status would muddy "failure is data."
- **No `status: "aborted"`** — abort is a thrown `AbortReason`, caught and re-thrown to the caller (see Abort propagation).

```ts
type ActionRunFn<P = unknown> = (
  input: Record<inputFields[number], unknown>,
  ctx: RunCtx<P>,
) => Promise<NodeRunResult>;
type BranchRunFn<P = unknown> = (
  input: Record<inputFields[number], unknown>,
  ctx: RunCtx<P>,
) => Promise<NodeRunResult>;
type MergeRunFn<P = unknown> = (
  inputs: Record<inputFields[number], unknown>[],
  ctx: RunCtx<P>,
) => Promise<NodeRunResult>;
type NodeRunFn<P = unknown> = ActionRunFn<P> | BranchRunFn<P> | MergeRunFn<P>; // the interface field; helpers pin the concrete fn and thread `P` onto `ctx.params`
```

- **Three class-specific run-fn types, each pinned by its `defineXRunner` helper.** The author writes the signature that matches their class — no runtime `switch` on `cls` inside the runner (the helper already pinned it). Mirrors the 03 pattern (helpers pin `cls`, infer `params`). Input keys typed from the runner's own declared `inputFields` (values stay `unknown` — field-name lists carry no value types, consistent with the input-typing rule: each channel typed as far as its own contract slot reaches; `inputFields` is a name list, so values are `unknown`).
- **`ctx.params` is fully typed as `P`** (the `paramSchema` output type), the most strongly-typed input the runner sees. See [`RunCtx`](#runctx) below — `RunCtx` carries `params: P` as a generic type param. The asymmetry vs `input` (full `P` vs keys-only) is the contract's, not a judgment call: `paramSchema` is a full validator that already mints the typed value; `inputFields` is a bare string list (a full `inputSchema` slot was a deliberate cut in 02/03). Each channel typed _as far as its own contract slot reaches_. Leaving `ctx.params` at `unknown` would be the one place in the dispatch contract where an available, cheap, constantly-read type is thrown away.
- **Merge always sees an array.** `join: "all"` → `[a,b,c]`; `join: "race"` → engine aborts siblings and calls the runner with `[winner]`. The **engine** owns race-vs-all _timing and abort_ (structural); the runner always sees the same array shape. Uniform signature across join policies.
- **No upstream-source attribution on merge inputs** — plain array, not keyed by upstream node id. Merge is homogeneous (one `inputFields`); semantic input roles are fogged (graduates later).

## `RunCtx`

```ts
type RunCtx<P = unknown> = {
  nodeId: string;
  pathId: string;
  params: P; // the node's validated per-instance static config (paramSchema output type); engine populates from node.params
  sandbox: SandboxProvider; // CONFIG, not a live handle — runner calls sandcastle.run({sandbox})
  env: Record<string, string>;
  secrets: ReadonlyMap<string, string>; // provisioned for THIS node's declared capabilities only
  log: Logger;
  stream: (chunk: StreamChunk) => void; // engine stamps nodeId/pathId before forwarding
  signal: AbortSignal; // composite — runners MUST forward into sandcastle.run({signal})/exec({signal})
  resumeToken?: string; // present iff THIS invocation is a resume (feedback re-entry, crash-recovery, or pause-resume)
  resumeInput?: unknown; // the human's answer (paused resume) or prior state (feedback re-entry)
  setResumeToken?: (token: string) => Promise<void>; // optional — non-idempotent runners call mid-run for crash-resume (see below)
  parent?: unknown; // compound sub-flow — fogged, slot exists, shape TBD
  scope?: unknown; // compound sub-flow — fogged, slot exists, shape TBD
};
```

- **`params: P` — the node's per-instance static config.** `params` is a **secondary in-channel** (per-instance, set at flow-build time on the `Node` record, validated by `paramSchema`, static across re-entries) — as opposed to `input`, the **primary** in-channel (per-invocation, engine-supplied from the upstream edge binding). The dispatch contract carries exactly one primary channel as a distinct arg (`input`); every secondary in-channel rides `ctx` — `params` here, `resumeInput` below. This is the ruling rule of the seam: _one primary data arg; all secondary in-channels ride `ctx`_. `resumeInput` set the precedent (also engine-supplied "in"-data, also a distinct concept, rides `ctx`); `params` follows it.
- **`P` is fully typed.** `RunCtx` is generic over the `paramSchema` output type; the `defineXRunner` helpers (03) already infer `P` from `paramSchema` and thread it onto `ctx.params`. The engine constructs the per-node `RunCtx` with the validated `node.params` (erased type at the engine boundary); the runner's typed view is a **boundary assertion at the dispatch seam** — the same mechanism `input` already uses (engine passes `Record<string,unknown>`; runner sees `Record<inputFields[number],unknown>`). The non-generic default `RunCtx<unknown>` covers shared/type-check contexts that don't care about `P`.
- **`sandbox: SandboxProvider`, not a live `Sandbox` handle.** Reuse-first: sandcastle's `run()` takes a _provider_ and manages sandbox lifecycle internally (`src/run.ts:490`, `factory.withSandbox`). The `opencode` runner does `sandcastle.run({ sandbox: ctx.sandbox, agent, prompt, signal: ctx.signal })` — full lifecycle reuse; the engine never touches sandbox creation/teardown. One provider threaded through the whole run; each node gets a fresh sandbox/worktree from head (so sequential nodes see prior commits). **The engine is a scheduler + state machine + persistence layer — it does not manage sandbox lifecycle at all.** That's sandcastle's job.
- **`secrets` is per-node-provisioned.** Only the capabilities a node declared at registration are provisioned into its `ctx.secrets`; lower-trust nodes in the same run never see higher-trust secrets (contract #3).
- **`stream` is the streaming seam.** Every node-streamed chunk goes through `ctx.stream`; the engine stamps `nodeId`/`pathId` before forwarding to `RunOpts.streams` / `RunStore.appendOutput` (contract #2).
- **`pauseForHuman` is NOT on `RunCtx` (amends v0.2).** Pause is purely a return status — see "Pause model" below.
- **`parent`/`scope` typed `unknown`.** The map fogs "Compound/sub-flow parameter passing & secret narrowing" — can't type until a concrete nested-flow need. The slots exist (contract names them), the shape is fog.

### `setResumeToken` — mid-run persistence for crash-resume (optional)

`resumeToken` on the _completion_ result is produced too late for crash-resume: a non-idempotent node that crashes _mid-run_ never completed → has no token. Without `setResumeToken`, every crashed non-idempotent node loses its work (surfaced as `crash-recovery-required`, human must recover manually).

`ctx.setResumeToken(token)` lets a non-idempotent runner persist a token _mid-execution_ — the `opencode` runner calls it as soon as sandcastle returns a `sessionId`, before the agent finishes. The engine writes it to `RunStore` synchronously. On crash-recovery, a `running`+non-idempotent node _with_ a stored token → resume (not `crash-recovery-required`); _without_ a token → `crash-recovery-required`. Opt-in per runner: an idempotent `code` runner never calls it; a non-idempotent node that doesn't call it gets the human-in-the-loop fallback. This is the mechanism that makes the contract's "Non-idempotent nodes must produce a resumeToken" actually hold for the mid-run crash case.

## Pause model (amends v0.2: drops `pauseForHuman`)

Pause is a **return status**, not a `RunCtx` call. The runner returns `{ status: "paused", pauseKind, ... }`; the engine persists it to `RunStore` and halts that path until a `resume` call re-enters with `ctx.resumeToken`/`ctx.resumeInput`.

**Why return-status, not `await ctx.pauseForHuman(...)`:** a blocking promise lives in memory — a crash evaporates it, and crash-resume of a paused node is impossible. Returning `paused` + `resumeToken` lets the engine _persist_ the pause in `RunStore` and re-enter after a crash. The runner's entry-check (`if (ctx.resumeToken)`) is the same code path for feedback re-entry, crash-recovery, and pause-resume — one mechanism, three uses.

### `pauseKind` — classifying pauses (the thing `reason: string` hid)

Pauses come from two places, both writing the same `pauseKind` to `RunStore`:

| source               | who initiates                      | kinds                                                      | runner return?                                          |
| -------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| **runner-initiated** | runner yields deliberately         | `human` (future: agent-self, self-timeout)                 | yes — `{status:"paused", pauseKind, ...}`               |
| **engine-initiated** | engine synthesizes mid/post-flight | `crash-recovery` (future: hard-timeout, recoverable-error) | no — engine writes state directly (runner killed/threw) |

`NodeRunResult`'s `paused` variant carries only **runner-initiated** kinds; engine kinds live in the store state. One vocabulary, two writers. Pinned now: `"human"` (the only kind the v0.2 `pauseForHuman` call ever expressed) + `"crash-recovery"` (contractually named). Fogged: `timeout`, `error`, and the agent-pause-vs-human-pause split — they graduate when a real flow exercises them (post-MVP, with `human-review`). The slot is extensible, so graduating later is non-breaking.

## Walk algorithm

A **work-queue that advances the frontier concurrently** — one model unifying parallel kickoff, race joins, sequential flows, and feedback re-entry.

```
init:   push all entry nodes (zero incoming forward edges) into the queue, each on pathId P0
loop:   pop ALL currently-runnable nodes, run them concurrently (Promise.all)
        for each that completes on port P:
          find outgoing edges where from.port == P
          for each edge:
            if kind == "forward" && no `to` → that path terminates (dangle)
            if kind == "forward" && has `to` → apply binding, mark the downstream's "this upstream fired" on this path
            if kind == "feedback" → re-enter the upstream (resume if resumeToken, cold if idempotent), bound by max-loops
          when a downstream's required upstreams are all fired → it becomes runnable, push it
        repeat until queue empty (all paths dangled) or a path pauses/fails
```

- **Concurrent-pop, not one-at-a-time.** Parallel entries need it (multiple entries = parallel kickoff); race joins need siblings running _concurrently_; sequential flows degenerate to sequential _automatically_ (only one node runnable at a time, e.g. the MVP chain implement→lint→gate). One mechanism handles all three.
- **`pathId` assignment — a branch's selected port opens a new path.** An `action` node _continues_ its parent's pathId (no split); a `branch` completing on port X opens a _new_ `pathId` for the outgoing edge(s) from X (correlates streamed chunks to a branch's chosen route, scopes aborts to a path). For the MVP, the gate's on-failure feedback to `implement` opens a new pathId per loop iteration — each retry is a distinct, traceable path. **The exact `pathId` format/derivation is fogged** (UUID? hierarchical? counter?) — it's an opaque string the engine mints; pin "a branch opens a new pathId; action continues" as the rule.
- **Feedback re-entry — resume vs. cold, bounded.** If the upstream's prior completion carried a `resumeToken` (non-idempotent) → re-invoke with `ctx.resumeToken` + the new input (binding applied) — the `opencode` runner resumes the agent session. If idempotent (no token) → re-invoke cold. **Bound:** per-feedback-edge max-loops (a counter in `RunStore`; default configurable, e.g. 3). On hitting the bound without the gate's success-port firing, the flow _fails_ (a stuck loop is a defect, not a pause). A progress check ("did the output change?") is a richer bound but premature — max-loops is the cheap, sufficient bound for the MVP.
- **Race abort — engine kills siblings via `signal`.** When a `merge: "race"`'s first upstream completes, the engine aborts still-running siblings by aborting their `ctx.signal`. The siblings' runners forward the abort into `sandbox.run({signal})`, so sandcastle hard-kills the in-flight agent. The merge runner is then invoked with `[winner]`. The engine owns race timing and abort; the runner always sees the array.

## `RunStore` interface

The seam the engine calls, so the `runs/` filesystem backend can be swapped later. A **plain TS interface** (not an Effect service) — the engine's Effect internals, if any, wrap it, but the seam stays plain. One adapter (fs backend) means a hypothetical seam; graduate to a service if a second backend or Effect-layering forces it.

```ts
interface RunStore {
  // ── run lifecycle ──
  createRun(runId: string, flow: Flow): Promise<void>; // atomic: writes runs/<id>/flow.json snapshot + initial state.json
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>; // for recover() to scan
  setFlowStatus(runId: string, status: FlowStatus): Promise<void>;

  // ── per-node state ──
  setNodeStatus(
    runId: string,
    nodeId: string,
    pathId: string,
    status: NodeStatus,
    detail?: NodeStatusDetail,
  ): Promise<void>;
  appendOutput(
    runId: string,
    nodeId: string,
    pathId: string,
    chunk: StreamChunk,
  ): Promise<void>;
  getNode(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<NodeRecord | undefined>;

  // ── resume tokens (crash-resume reads these) ──
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
}

type RunRecord = {
  runId: string;
  flowId: string;
  status: FlowStatus;
  startedAt: number;
  updatedAt: number;
};
type NodeStatus =
  | "pending"
  | "running"
  | "complete"
  | "paused"
  | "skipped"
  | "aborted";
type NodeStatusDetail = {
  port?: string;
  pauseKind?: PauseKind;
  error?: string;
};
type NodeRecord = {
  status: NodeStatus;
  output?: Record<string, unknown>;
  metrics?: NodeRunMetrics;
  resumeToken?: string;
  detail?: NodeStatusDetail;
};
```

- **Keyed by `(runId, nodeId, pathId)` — `pathId` is load-bearing in the key, not decoration.** A node can be visited on multiple paths (feedback re-entry = same `nodeId`, new `pathId`; or a future `merge`). Without `pathId` in the key, a feedback re-entry overwrites the prior run's record — losing the history crash-resume needs and clobbering a concurrent path. This is the engine's identity model made explicit at the store seam.
- **`createRun` is atomic.** `runs/<id>/flow.json` (the flow the engine loaded — pinned for the run's lifetime, immune to later edits) + `state.json` (mutable node/flow status). The run is either fully created or absent; a partial `runs/<id>/` is never visible to `recover()`.
- **Sync write after each transition is the _engine's_ policy, not the store's.** The engine awaits `setNodeStatus` before firing the next node. The store interface is just `async` methods; a backend may buffer/batch internally as long as the engine's await resolves. Keeping sync as the engine's invariant (not the store's) keeps the interface shallow.
- **`appendOutput` is the streaming seam.** `ctx.stream(chunk)` → engine stamps `nodeId`/`pathId` → `store.appendOutput(...)`. No batch/flush method — a backend that wants batching buffers internally behind the same call. One method, deep.

## Crash-resume spec

On `recover()` at engine startup, scan `RunStore.listRuns()` for runs with status `running` or `paused`. Per node:

| node state | idempotent? | has stored resumeToken?        | action                                                           |
| ---------- | ----------- | ------------------------------ | ---------------------------------------------------------------- |
| `running`  | yes         | —                              | re-invoke cold (idempotent → safe to redo)                       |
| `running`  | no          | yes (via `ctx.setResumeToken`) | resume with the stored token                                     |
| `running`  | no          | no                             | surface as `paused: "crash-recovery-required"` (human re-offers) |
| `paused`   | —           | —                              | re-offer the resume token via `resume()`                         |

- **`crash-recovery-required` is the fallback for non-idempotent nodes that don't call `setResumeToken`.** Safe but lossy: the human decides whether to re-invoke cold (risk duplicate side effects) or abandon. The session JSONL may still exist on disk (sandcastle persists it) — the engine just doesn't automate recovery without a token.
- **Re-invocation is the single mechanism.** The runner's entry-check (`if (ctx.resumeToken)`) is the same code path for feedback re-entry, crash-recovery, and pause-resume.

## Abort propagation spec

Two abort sources, same mechanism, **must not be conflated**:

| source           | who                                             | scope                               | flow outcome                            |
| ---------------- | ----------------------------------------------- | ----------------------------------- | --------------------------------------- |
| **caller abort** | caller aborts `RunOpts.signal`                  | the whole run — all in-flight nodes | flow `aborted` (terminal)               |
| **race abort**   | engine, when a `merge: "race"` winner completes | sibling paths of that merge only    | flow _continues_ — winner path proceeds |

- **`ctx.signal` is a composite.** Each node's signal is the race of the caller's run-level signal and a per-path abort signal (engine mints the per-path one for race aborts). The engine reuses sandcastle's `raceAbortSignal` (`src/raceAbortSignal.ts`) — no new abstraction: `ctx.signal = raceAbortSignal(callerSignal, pathSignal)`.
- **Runners forward the signal into `sandbox.run({signal})` / `exec({signal})`** (contract). Sandcastle hard-kills and rejects with `signal.reason` (`src/run.ts:497`, `signal.throwIfAborted()`, no wrapping) → node's promise rejects → engine catches and records.
- **Node-level status for a killed node: `"aborted"`, not `"skipped"`.** A node killed mid-execution is not "skipped" (never ran). Caller-abort → all in-flight nodes `"aborted"`, flow `"aborted"` (terminal). Race-abort → sibling nodes `"aborted"`, flow _continues_ (winner's path proceeds; flow status stays `running`→`complete`). The _flow-level_ status distinguishes the two sources — a node `"aborted"` doesn't imply the flow is.
- **`FlowRunResult.abortReason` carries `signal.reason` verbatim** (present iff `status === "aborted"`). No Fabbit wrapping — the caller's abort reason is the caller's. Race-abort never sets `abortReason` (the flow isn't aborted).
- **Paused nodes on a caller-aborted run → `"aborted"`.** A paused node isn't running (nothing to kill), but an aborted run is terminal — you don't resume into it. Resume tokens stay in `RunStore` but the run won't resume; manual recovery from an aborted run is fogged.

## Changes to the locked contract (cross-ticket amendments)

This grilling amends the v0.2/v0.3 contract in four places; the earlier specs (`docs/dag-schema.md`, `docs/registry-builder-api.md`) carry the pre-amendment text.

1. **`idempotent: boolean` added to `NodeRunner` / `RegistryEntry`.** The crash-resume rules branch on idempotency, but the 03 contract's `RegistryEntry` has no `idempotent` field. Added as a static, load-time property (like `cls`/`join`) — lives on the entry, not on `NodeRunResult`. The `defineXRunner` helpers gain an `idempotent` slot.
2. **`pauseForHuman` dropped from `RunCtx` (was in v0.2).** Pause is a return status (`status: "paused"` + `pauseKind`), not a `RunCtx` call. The call never classified pause kinds; the discriminator does. One mechanism (re-invocation with `ctx.resumeToken`/`ctx.resumeInput`) covers feedback re-entry, crash-recovery, and pause-resume.
3. **`NodeRunner.run` signature typed (was a placeholder in 03).** Three class-specific run-fn types pinned by the helpers; `NodeRunResult` is the uniform return (complete with `port`/`output`/optional `resumeToken`/`metrics`, or paused with `pauseKind`/optional `resumeToken`/`payload`/`metrics`). `setResumeToken` added to `RunCtx` as an optional mid-run persistence point.
4. **`params` added to `RunCtx`; `RunCtx` made generic over `P` (ticket 08).** The 03/04 contracts typed `NodeRunFn` as `(input, ctx) => …` with no path from a node's validated `node.params` to the runner. A per-instance runner needs its `params` at runtime (the MVP `gate` reads `params.on`). Decision (ticket 08): `params` rides `ctx` (Option 1), fully typed as `P` — _one primary data arg (`input`); all secondary in-channels (`params`, `resumeInput`) ride `ctx`_. `RunCtx` becomes `RunCtx<P = unknown>` with `params: P`; the helpers thread their inferred `P` onto `ctx.params`; the engine populates it from validated `node.params` (boundary-asserted, same mechanism as `input`). Amends `docs/registry-builder-api.md`'s `NodeRunFn` placeholder.

## Deferred to fog

- **`runs/` filesystem `RunStore` backend.** Graduates as its own task-ticket — the interface is locked here; the fs implementation (directory layout, `state.json` shape, atomic-write strategy, append-only logs) is a separate slice. Unblocks the MVP slice running end-to-end.
- **`pathId` format/derivation.** The rule (branch opens a new pathId; action continues) is pinned; the exact format (UUID / hierarchical / counter) is an opaque-string detail that doesn't affect the interface. Graduates when the streaming-correlation or editor-attach use-case forces a concrete shape.
- **`pauseKind` vocabulary beyond `human` / `crash-recovery`.** `timeout`, `error`, and the agent-pause-vs-human-pause split graduate when a real flow exercises them (post-MVP, with `human-review`). The slot is extensible, so graduating is non-breaking.
- **Race-abort sibling cleanup detail.** Whether a race-aborted sibling's partial output is kept or discarded in `RunStore`, and whether its worktree is preserved (sandcastle preserves worktrees on abort) — a backend/detail question for the `runs/` fs task-ticket, not the interface.
- **`RecoverResult` shape.** "list of run-ids + the action taken per run" — deferred until the CLI surfaces what it needs to display.
- **Engine internal runtime model (Effect vs plain async).** The interfaces here are runtime-neutral; whether the engine's internals are Effect-based (consistent with sandcastle's `orchestrate`) or plain async is an implementation choice that doesn't affect the seams. Fogged until the `runs/` backend ticket forces it.
