/**
 * PROTOTYPE — throwaway. Canonical Flow/Node/Edge transport types, lifted from
 * docs/dag-schema.md but trimmed to what the MVP slice exercises. Not the
 * production schema module; contract gaps surfaced here graduate into tickets.
 */

export type Flow = {
  meta: { id: string; revision: number; schema: string };
  graph: { nodes: Node[]; edges: Edge[] };
};

export type NodeCls = "action" | "branch" | "merge";

export type Node = {
  id: string;
  name: string;
  kind: string;
  version: string;
  cls: NodeCls;
  params: Record<string, unknown>;
};

export type Edge = {
  id: string;
  from: { node: string; port: string };
  to?: { node: string };
  binding?: Record<string, string>;
  kind: "forward" | "feedback";
};

// ── Engine dispatch + run types (from docs/engine.md) ──

export type PauseKind = "human" | "crash-recovery";

export type NodeRunResult =
  | {
      status: "complete";
      port: string;
      output: Record<string, unknown>;
      resumeToken?: string;
      metrics?: Record<string, unknown>;
    }
  | {
      status: "paused";
      pauseKind: PauseKind;
      resumeToken?: string;
      payload: unknown;
      metrics?: Record<string, unknown>;
    };

export type StreamChunk = {
  nodeId: string;
  pathId: string;
  text: string;
};

export type RunCtx = {
  nodeId: string;
  pathId: string;
  // RESOLVED (ticket #9): params rides ctx as the secondary in-channel
  // (per-instance static config); the real contract types this as
  // RunCtx<P = unknown> with ctx.params: P (the paramSchema output type).
  // The throwaway prototype keeps Record<string, unknown> here -- no
  // Standard Schema inference in this branch; the typed view lands in the
  // real engine module, not here.
  params: Record<string, unknown>;
  sandbox?: unknown;
  env: Record<string, string>;
  secrets: ReadonlyMap<string, string>;
  log: (...args: unknown[]) => void;
  stream: (text: string) => void;
  signal: AbortSignal;
  resumeToken?: string;
  resumeInput?: unknown;
  setResumeToken?: (token: string) => Promise<void>;
};

export type ActionRunFn = (
  input: Record<string, unknown>,
  ctx: RunCtx,
) => Promise<NodeRunResult>;
export type BranchRunFn = (
  input: Record<string, unknown>,
  ctx: RunCtx,
) => Promise<NodeRunResult>;

export type FlowStatus =
  | "running"
  | "complete"
  | "paused"
  | "aborted"
  | "failed";

export type NodeOutcome = {
  nodeId: string;
  pathId: string;
  status: "complete" | "paused" | "skipped" | "aborted";
  port?: string;
  output?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
};

export type FlowRunResult = {
  runId: string;
  status: FlowStatus;
  nodes: NodeOutcome[];
  metrics: Record<string, unknown>;
  abortReason?: unknown;
};
