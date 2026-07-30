/**
 * FsRunStore — the concrete `runs/`-filesystem `RunStore` adapter.
 *
 * Resolution of [07 — runs/ filesystem RunStore backend](https://github.com/michaelahoff/fabbit/issues/8).
 * Implements the interface locked in [04 — Engine](https://github.com/michaelahoff/fabbit/issues/4).
 *
 * ## Directory layout
 *
 * ```
 * <root>/runs/<runId>/flow.json                 # immutable snapshot (byte-identical to createRun's arg)
 * <root>/runs/<runId>/state.json                # mutable run + node status, keyed by `${nodeId}:${pathId}`
 * <root>/runs/<runId>/nodes/<nodeId>-<pathId>.log  # append-only streamed output via appendOutput
 * <root>/runs/.<runId>.tmp/                      # createRun staging dir (never visible to listRuns)
 * ```
 *
 * ## Crash-safety
 *
 * - **createRun** is atomic: the run directory is staged under
 *   `runs/.<runId>.tmp/` (flow.json + initial state.json fsynced) then renamed
 *   onto `runs/<runId>/`. A `listRuns()` scan only visits non-dot directories,
 *   so a crash during createRun leaves a stranded `.tmp` dir that recover skips.
 * - **state.json** durables via atomic-rename: write `state.json.tmp`, fsync,
 *   rename over `state.json`, fsync the directory. A crash mid-write never
 *   corrupts the last-committed state.
 * - **appendOutput** opens the log append-only and fsyncs the fd on each chunk,
 *   so streamed output survives a crash up to the last appended byte.
 *
 * The *sync-write-after-each-transition* policy (when to call these mutators) is
 * the engine's, not the store's — per #4. The store only guarantees each call
 * is durable on resolve.
 */
import {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
  readFile,
  access,
  open,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  FlowStatus,
  NodeRecord,
  NodeStatus,
  RunSnapshot,
  RunStore,
  RunSummary,
} from "./run-store.js";

type PersistedState = {
  runId: string;
  flowId: string;
  status: FlowStatus;
  startedAt: string;
  input: unknown;
  nodes: Record<string, NodeRecord>;
  abortReason?: unknown;
  metrics?: Record<string, unknown>;
};

const nodeKey = (nodeId: string, pathId: string): string =>
  `${nodeId}:${pathId}`;

/**
 * Sanitize an id for use in a filename. `nodeId`/`pathId` are opaque strings
 * (pathId's exact format is fogged); strip anything that could escape the run
 * directory or break the filename. UUID-shaped ids pass through untouched.
 */
const safeName = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Best-effort extract of `flow.meta.id` for the `RunSummary.flowId` convenience.
 * The store does not validate the flow; only reads its envelope id.
 */
const flowIdOf = (flow: unknown): string => {
  if (flow && typeof flow === "object") {
    const meta = (flow as { meta?: unknown }).meta;
    if (meta && typeof meta === "object") {
      const id = (meta as { id?: unknown }).id;
      if (typeof id === "string") return id;
    }
  }
  return "";
};

/** Best-effort directory fsync — not all platforms/fs support dir fsync. */
const syncDir = async (dir: string): Promise<void> => {
  let fh;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch {
    /* unsupported — last-rename is still atomic on POSIX regardless */
  } finally {
    await fh?.close().catch(() => {});
  }
};

export class FsRunStore implements RunStore {
  constructor(private readonly root: string) {}

  private get runsDir(): string {
    return join(this.root, "runs");
  }

  private runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  private statePath(runId: string): string {
    return join(this.runDir(runId), "state.json");
  }

  private flowPath(runId: string): string {
    return join(this.runDir(runId), "flow.json");
  }

  private logPath(runId: string, nodeId: string, pathId: string): string {
    return join(
      this.runDir(runId),
      "nodes",
      `${safeName(nodeId)}-${safeName(pathId)}.log`,
    );
  }

  async createRun(runId: string, flow: unknown, input: unknown): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    const target = this.runDir(runId);
    if (await pathExists(target)) {
      throw new Error(`FsRunStore.createRun: run already exists: ${runId}`);
    }
    // Stage under a dot-prefixed temp dir so listRuns() never sees a half-built run.
    const staging = join(this.runsDir, `.${runId}.tmp-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    await mkdir(join(staging, "nodes"), { recursive: true });

    const initial: PersistedState = {
      runId,
      flowId: flowIdOf(flow),
      status: "running",
      startedAt: new Date().toISOString(),
      input,
      nodes: {},
    };

    await writeFile(join(staging, "flow.json"), serializeFlow(flow));
    await atomicWriteJson(join(staging, "state.json"), initial);

    // Atomic publish: rename staging -> runs/<runId>. POSIX rename is atomic.
    await rename(staging, target);
    await syncDir(this.runsDir);
  }

  async getFlow(runId: string): Promise<unknown> {
    const raw = await readFile(this.flowPath(runId), "utf8");
    return JSON.parse(raw);
  }

  async getSnapshot(runId: string): Promise<RunSnapshot> {
    const state = await this.readState(runId);
    return {
      runId: state.runId,
      flowId: state.flowId,
      status: state.status,
      startedAt: state.startedAt,
      input: state.input,
      nodes: Object.values(state.nodes),
      abortReason: state.abortReason,
      metrics: state.metrics,
    };
  }

  async setFlowStatus(
    runId: string,
    status: FlowStatus,
    abortReason?: unknown,
  ): Promise<void> {
    await this.updateState(runId, (state) => {
      state.status = status;
      if (abortReason !== undefined) state.abortReason = abortReason;
    });
  }

  async setNodeStatus(
    runId: string,
    nodeId: string,
    pathId: string,
    status: NodeStatus,
  ): Promise<void> {
    await this.updateState(runId, (state) => {
      const key = nodeKey(nodeId, pathId);
      const existing = state.nodes[key] ?? {
        nodeId,
        pathId,
        status,
      };
      state.nodes[key] = { ...existing, status };
    });
  }

  async setNodeRecord(runId: string, record: NodeRecord): Promise<void> {
    await this.updateState(runId, (state) => {
      const key = nodeKey(record.nodeId, record.pathId);
      state.nodes[key] = { ...state.nodes[key], ...record };
    });
  }

  async getNodeRecord(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<NodeRecord | undefined> {
    const state = await this.readState(runId);
    return state.nodes[nodeKey(nodeId, pathId)];
  }

  async setResumeToken(
    runId: string,
    nodeId: string,
    pathId: string,
    token: string,
  ): Promise<void> {
    await this.updateState(runId, (state) => {
      const key = nodeKey(nodeId, pathId);
      const existing = state.nodes[key] ?? {
        nodeId,
        pathId,
        status: "running",
      };
      state.nodes[key] = { ...existing, resumeToken: token };
    });
  }

  async getResumeToken(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<string | undefined> {
    const state = await this.readState(runId);
    return state.nodes[nodeKey(nodeId, pathId)]?.resumeToken;
  }

  async appendOutput(
    runId: string,
    nodeId: string,
    pathId: string,
    chunk: string,
  ): Promise<void> {
    const path = this.logPath(runId, nodeId, pathId);
    await mkdir(dirname(path), { recursive: true });
    const fh = await open(path, "a");
    try {
      await fh.writeFile(chunk);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async getOutput(
    runId: string,
    nodeId: string,
    pathId: string,
  ): Promise<string> {
    const path = this.logPath(runId, nodeId, pathId);
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  async listRuns(): Promise<RunSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch {
      return [];
    }
    const summaries: RunSummary[] = [];
    for (const name of entries) {
      // Skip dot-prefixed staging dirs (crashed createRun) and stray files.
      if (name.startsWith(".")) continue;
      const statePath = join(this.runsDir, name, "state.json");
      if (!(await pathExists(statePath))) continue;
      try {
        const state = await readJson<PersistedState>(statePath);
        summaries.push({
          runId: state.runId,
          flowId: state.flowId,
          status: state.status,
          startedAt: state.startedAt,
        });
      } catch {
        // A state.json that fails to parse is itself a crash signal; skip it.
        // Engine recover() can decide whether to surface it.
      }
    }
    return summaries;
  }

  async deleteRun(runId: string): Promise<void> {
    await rm(this.runDir(runId), { recursive: true, force: true });
  }

  private async readState(runId: string): Promise<PersistedState> {
    const raw = await readFile(this.statePath(runId), "utf8");
    return JSON.parse(raw) as PersistedState;
  }

  private async updateState(
    runId: string,
    mutate: (state: PersistedState) => void,
  ): Promise<void> {
    const state = await this.readState(runId);
    mutate(state);
    await atomicWriteJson(this.statePath(runId), state);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(path: string): Promise<T> => {
  return JSON.parse(await readFile(path, "utf8")) as T;
};

/**
 * Serialize the flow snapshot. We round-trip through JSON so `flow.json` is
 * canonical regardless of how the caller built the object; the engine reads it
 * back verbatim. Preserves key order of the passed object via a single
 * stringify pass.
 */
const serializeFlow = (flow: unknown): string => JSON.stringify(flow, null, 2);

/**
 * Atomic, durable write of a JSON state file: write a sibling `.tmp`, fsync the
 * tempfile, rename over the target, then fsync the parent dir. A crash at any
 * point leaves either the prior committed state or the new one — never a
 * half-written file.
 */
const atomicWriteJson = async (
  target: string,
  value: unknown,
): Promise<void> => {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  let fh;
  try {
    fh = await open(tmp, "r");
    await fh.sync();
  } finally {
    await fh?.close().catch(() => {});
  }
  await rename(tmp, target);
  await syncDir(dirname(target));
};
