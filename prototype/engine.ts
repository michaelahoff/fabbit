/**
 * PROTOTYPE — throwaway. One engine: walks the canonical flow, dispatches to
 * NodeRunners, threads RunCtx, persists transitions to RunStore, and bounds
 * feedback re-entry. Lifted from docs/engine.md; cut to what the MVP exercises.
 *
 * What's INTENTIONALLY cut (graduates into tickets / fog when the prototype
 * surfaces it): merge/join + race-abort, pause/resume, crash recover(), the
 * composite path-signal for race aborts, Effect internals, async-concurrent
 * scheduler (the MVP chain is sequential — Promise.all over a queue that holds
 * exactly one node at a time degenerates to sequential, the spec's point).
 */
import { randomUUID } from "node:crypto";

import type { Registry } from "./registry.js";
import type { RunStore, NodeRecord } from "../src/engine/run-store.js";
import type {
  Flow,
  Edge,
  FlowRunResult,
  FlowStatus,
  Node,
  NodeOutcome,
  NodeRunResult,
  NodeCls,
  RunCtx,
} from "./types.js";

const MAX_LOOPS = 3;

type RunOpts = { signal?: AbortSignal };

type QueueItem = {
  node: Node;
  pathId: string;
  input: Record<string, unknown>;
  resumeToken?: string;
  resumeInput?: unknown;
};

export class Engine {
  constructor(
    private readonly reg: Registry,
    private readonly store: RunStore,
  ) {}

  async run(
    flow: Flow,
    input: unknown,
    opts: RunOpts = {},
  ): Promise<FlowRunResult> {
    const runId = randomUUID();
    await this.store.createRun(runId, flow, input);
    await this.store.setFlowStatus(runId, "running");

    const byId = new Map<string, Node>();
    for (const n of flow.graph.nodes) byId.set(n.id, n);
    const outgoingByNode: Record<string, Edge[]> = {};
    for (const e of flow.graph.edges) {
      (outgoingByNode[e.from.node] ??= []).push(e);
    }
    const incomingForward = new Map<string, number>();
    for (const n of flow.graph.nodes) incomingForward.set(n.id, 0);
    for (const e of flow.graph.edges) {
      if (e.kind === "forward" && e.to) {
        incomingForward.set(
          e.to.node,
          (incomingForward.get(e.to.node) ?? 0) + 1,
        );
      }
    }

    const entries = flow.graph.nodes.filter(
      (n) => (incomingForward.get(n.id) ?? 0) === 0,
    );

    let pathCounter = 0;
    const nextPath = () => `P${pathCounter++}`;
    const startPath = nextPath();

    const outcomes: NodeOutcome[] = [];
    // Per-node last resumeToken (prototype-only: keying by pathId is a contract
    // gap surfaced by the slice — see resolution).
    const lastToken = new Map<string, string>();
    const loopCount = new Map<string, number>();

    const queue: QueueItem[] = entries.map((n) => ({
      node: n,
      pathId: startPath,
      input: (input as Record<string, unknown>) ?? {},
    }));

    let flowStatus: FlowStatus = "running";
    let abortReason: unknown;

    const runOne = async (item: QueueItem): Promise<void> => {
      const { node, pathId } = item;
      const runner = this.reg.resolve(node.kind, node.version);
      await this.store.setNodeStatus(runId, node.id, pathId, "running");

      const ctx: RunCtx = {
        nodeId: node.id,
        pathId,
        params: node.params,
        env: process.env as Record<string, string>,
        secrets: new Map(),
        log: (...a) => console.log(`[${node.name}/${pathId}]`, ...a),
        stream: (text) => {
          const chunk = { nodeId: node.id, pathId, text };
          void this.store.appendOutput(runId, node.id, pathId, chunk.text);
        },
        signal: opts.signal ?? new AbortController().signal,
        resumeToken: item.resumeToken,
        resumeInput: item.resumeInput,
        setResumeToken: async (token: string) => {
          await this.store.setResumeToken(runId, node.id, pathId, token);
          lastToken.set(node.id, token);
        },
      };

      const result = (await runner.run(item.input, ctx)) as NodeRunResult;

      if (result.status !== "complete") {
        throw new Error(
          `prototype engine: paused results unsupported (node ${node.name})`,
        );
      }

      if (result.resumeToken) lastToken.set(node.id, result.resumeToken);

      const record: NodeRecord = {
        nodeId: node.id,
        pathId,
        status: "complete",
        port: result.port,
        output: result.output,
        metrics: result.metrics,
        resumeToken: result.resumeToken,
      };
      await this.store.setNodeRecord(runId, record);
      outcomes.push({
        nodeId: node.id,
        pathId,
        status: "complete",
        port: result.port,
        output: result.output,
        metrics: result.metrics,
      });

      // Resolve outgoing edges for the fired port.
      const fired = (outgoingByNode[node.id] ?? []).filter(
        (e) => e.from.port === result.port,
      );
      for (const edge of fired) {
        if (edge.kind === "forward" && !edge.to) {
          // Dangling forward → this path terminates. (Nothing to do.)
          continue;
        }
        if (edge.kind === "forward" && edge.to) {
          const downstream = byId.get(edge.to.node)!;
          const downRunner = this.reg.resolve(
            downstream.kind,
            downstream.version,
          );
          const childPath = opensNewPath(downRunner.cls) ? nextPath() : pathId;
          const dInput = applyBinding(result.output, edge.binding);
          queue.push({
            node: downstream,
            pathId: childPath,
            input: dInput,
          });
          continue;
        }
        if (edge.kind === "feedback" && edge.to) {
          const target = byId.get(edge.to.node)!;
          const n = (loopCount.get(edge.id) ?? 0) + 1;
          loopCount.set(edge.id, n);
          if (n > MAX_LOOPS) {
            flowStatus = "failed";
            await this.store.setFlowStatus(runId, "failed");
            console.error(
              `[engine] feedback loop ${edge.id} exceeded max-loops (${MAX_LOOPS}); flow failed`,
            );
            return;
          }
          const childPath = nextPath();
          const dInput = applyBinding(result.output, edge.binding);
          queue.push({
            node: target,
            pathId: childPath,
            input: dInput,
            resumeToken: lastToken.get(target.id),
            resumeInput: dInput,
          });
          continue;
        }
        if (edge.kind === "feedback" && !edge.to) {
          // A dangling feedback edge makes no sense; ignore for the prototype.
          continue;
        }
      }
    };

    while (queue.length > 0 && flowStatus === "running") {
      const batch = queue.splice(0, queue.length);
      try {
        await Promise.all(batch.map(runOne));
      } catch (err) {
        flowStatus = "failed";
        abortReason = err;
        await this.store.setFlowStatus(runId, "failed", abortReason);
        console.error("[engine] node run threw:", err);
        break;
      }
    }

    if (flowStatus === "running") {
      flowStatus = "complete";
      await this.store.setFlowStatus(runId, "complete");
    }

    return {
      runId,
      status: flowStatus,
      nodes: outcomes,
      metrics: {},
      abortReason,
    };
  }
}

function opensNewPath(cls: NodeCls): boolean {
  // A branch's selected port opens a new pathId; action continues its parent's.
  return cls === "branch";
}

function applyBinding(
  output: Record<string, unknown>,
  binding?: Record<string, string>,
): Record<string, unknown> {
  if (!binding) return { ...output };
  const out: Record<string, unknown> = {};
  for (const [downField, upField] of Object.entries(binding)) {
    out[downField] = output[upField];
  }
  return out;
}
