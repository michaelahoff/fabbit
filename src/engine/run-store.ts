/**
 * RunStore — the persistence seam the Fabbit engine checkpoints through.
 *
 * Materialized from [04 — Engine](https://github.com/michaelahoff/fabbit/issues/4):
 * "RunStore is a plain TS interface (not an Effect service — one adapter = a
 * hypothetical seam), keyed by `(runId, nodeId, pathId)`. `createRun` atomic;
 * sync-write-after-each-transition is the *engine's* policy, not the store's."
 *
 * The store persists; it does not decide *when* to persist (that's the engine)
 * and it does not validate the flow (that's the DAG schema + registry). The
 * `flow` argument to `createRun` is an opaque, already-validated snapshot the
 * store writes byte-identical to `flow.json`; `getFlow` hands it back as-is.
 *
 * Every mutator MUST be durable on resolve: a crash after the promise settles
 * must not lose the write or corrupt `state.json` (atomic-rename or fsync). A
 * crash *during* `createRun` must never expose a partial `runs/<id>/` to a
 * `listRuns()` / recover scan.
 */

// Node statuses. `NodeRunResult` only ever returns `complete`/`paused`; the
// engine additionally records `running`, `aborted`, and `skipped` here.
// `failed` is flow-level only (a gate routes on it; the node itself completes).
export type NodeStatus =
  | "pending"
  | "running"
  | "complete"
  | "paused"
  | "aborted"
  | "skipped";

// Flow-level status. `failed` is flow-level ONLY — a node never "fails", a
// gate selects on-failure and the flow continues via feedback.
export type FlowStatus =
  | "running"
  | "complete"
  | "paused"
  | "aborted"
  | "failed";

/**
 * The persisted shape of one node within a run, keyed by `(nodeId, pathId)`.
 * `pathId` is load-bearing in the key: a feedback re-entry is the same
 * `nodeId` on a new `pathId`. Mirrors `NodeRunResult` plus the engine-only
 * statuses (`running`/`aborted`/`skipped`).
 */
export type NodeRecord = {
  nodeId: string;
  pathId: string;
  status: NodeStatus;
  /** Selected output port — `out` for action/merge, the chosen port for branch. */
  port?: string;
  /** What flows along outgoing edges — NOT metrics. */
  output?: Record<string, unknown>;
  /** Persisted mid-run by non-idempotent runners (via `ctx.setResumeToken`). */
  resumeToken?: string;
  /** Recorded *about* the run (sessionId, usage, duration) — distinct from output. */
  metrics?: Record<string, unknown>;
};

/** The whole run at a point in time — what `Engine` reads to drive/finish a run. */
export type RunSnapshot = {
  runId: string;
  flowId: string;
  status: FlowStatus;
  startedAt: string;
  /** The opaque root input the run was kicked off with. */
  input: unknown;
  nodes: NodeRecord[];
  abortReason?: unknown;
  metrics?: Record<string, unknown>;
};

/** A low-cost row for the recover scan; `Engine.recover()` enumerates these. */
export type RunSummary = {
  runId: string;
  flowId: string;
  status: FlowStatus;
  startedAt: string;
};

export interface RunStore {
  /**
   * Atomically create a run directory holding the immutable `flow.json`
   * snapshot and the initial `state.json` (status `running`). MUST be
   * crash-atomic: a partial `runs/<id>/` is never visible to `listRuns()`.
   * Rejects if `<runId>` already exists.
   */
  createRun(runId: string, flow: unknown, input: unknown): Promise<void>;

  /** The immutable flow snapshot written by `createRun`. Opaque to the store. */
  getFlow(runId: string): Promise<unknown>;

  /** Full mutable state: run-level status plus every persisted node record. */
  getSnapshot(runId: string): Promise<RunSnapshot>;

  /** Set the flow-level status. `abortReason` pairs with `aborted`. Durable. */
  setFlowStatus(
    runId: string,
    status: FlowStatus,
    abortReason?: unknown,
  ): Promise<void>;

  /** Granular node-status transition (engine flips pending→running→complete…). Durable. */
  setNodeStatus(
    runId: string,
    nodeId: string,
    pathId: string,
    status: NodeStatus,
  ): Promise<void>;

  /** Upsert a full node record (status + port + output + metrics). Durable. */
  setNodeRecord(runId: string, record: NodeRecord): Promise<void>;

  /** Read one node record, keyed by `(nodeId, pathId)`. `undefined` if absent. */
  getNodeRecord(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<NodeRecord | undefined>;

  /** Persist a resume token for `(nodeId, pathId)` mid-run. Durable. */
  setResumeToken(
    runId: string,
    nodeId: string,
    pathId: string,
    token: string,
  ): Promise<void>;

  /** Read the resume token for `(nodeId, pathId)` — used on crash-recovery. */
  getResumeToken(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<string | undefined>;

  /** Append a chunk to the node's streamed-output log (append-only). Durable. */
  appendOutput(
    runId: string,
    nodeId: string,
    pathId: string,
    chunk: string,
  ): Promise<void>;

  /** Read the full streamed-output log for `(nodeId, pathId)`. */
  getOutput(runId: string, nodeId: string, pathId: string): Promise<string>;

  /** Enumerate every run directory for the recover scan. Skips crashed temp dirs. */
  listRuns(): Promise<RunSummary[]>;

  /** Remove a run directory entirely. */
  deleteRun(runId: string): Promise<void>;
}
