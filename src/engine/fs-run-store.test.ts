import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsRunStore } from "./fs-run-store.js";
import type { FlowStatus, NodeStatus } from "./run-store.js";

/** The MVP flow instance from docs/dag-schema.md (three-node ADW loop). */
const sampleFlow = {
  meta: { id: "f1b2a3", revision: 1, schema: "1.0.0" },
  graph: {
    nodes: [
      {
        id: "n_implement",
        name: "implement",
        kind: "opencode",
        version: "1.0.0",
        cls: "action",
        params: {},
      },
      {
        id: "n_lint",
        name: "lint",
        kind: "code",
        version: "1.0.0",
        cls: "action",
        params: {},
      },
      {
        id: "n_gate",
        name: "gate",
        kind: "gate",
        version: "1.0.0",
        cls: "branch",
        params: {},
      },
    ],
    edges: [
      {
        id: "e1",
        from: { node: "n_implement", port: "out" },
        to: { node: "n_lint" },
        kind: "forward",
      },
      {
        id: "e2",
        from: { node: "n_lint", port: "out" },
        to: { node: "n_gate" },
        kind: "forward",
      },
      {
        id: "e3",
        from: { node: "n_gate", port: "on-success" },
        kind: "forward",
      },
      {
        id: "e4",
        from: { node: "n_gate", port: "on-failure" },
        to: { node: "n_implement" },
        kind: "feedback",
      },
    ],
  },
};

const RUN = "run-001";
const NODE = "n_implement";

describe("FsRunStore", () => {
  let root: string;
  let store: FsRunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fsrunstore-"));
    store = new FsRunStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("createRun", () => {
    it("atomically creates flow.json + state.json", async () => {
      await store.createRun(RUN, sampleFlow, { repo: "fabbit" });

      expect(await store.getFlow(RUN)).toEqual(sampleFlow);
      const snap = await store.getSnapshot(RUN);
      expect(snap.runId).toBe(RUN);
      expect(snap.flowId).toBe("f1b2a3");
      expect(snap.status).toBe("running");
      expect(snap.input).toEqual({ repo: "fabbit" });
      expect(snap.nodes).toEqual([]);
    });

    it("rejects a duplicate runId", async () => {
      await store.createRun(RUN, sampleFlow, {});
      await expect(store.createRun(RUN, sampleFlow, {})).rejects.toThrow(
        /already exists/,
      );
    });

    it("records an empty flowId when the flow envelope has no meta.id", async () => {
      await store.createRun("r2", { graph: { nodes: [], edges: [] } }, {});
      const snap = await store.getSnapshot("r2");
      expect(snap.flowId).toBe("");
    });
  });

  describe("node records (keyed by runId,nodeId,pathId)", () => {
    beforeEach(async () => {
      await store.createRun(RUN, sampleFlow, {});
    });

    it("setNodeStatus + getNodeRecord persist a status transition", async () => {
      await store.setNodeStatus(RUN, NODE, "P0", "running");
      let rec = await store.getNodeRecord(RUN, NODE, "P0");
      expect(rec?.status).toBe("running");

      await store.setNodeStatus(RUN, NODE, "P0", "complete");
      rec = await store.getNodeRecord(RUN, NODE, "P0");
      expect(rec?.status).toBe("complete");
      expect(rec?.nodeId).toBe(NODE);
      expect(rec?.pathId).toBe("P0");
    });

    it("keeps distinct records for the same nodeId on different pathIds (feedback re-entry)", async () => {
      await store.setNodeStatus(RUN, NODE, "P0", "complete");
      await store.setNodeStatus(RUN, NODE, "P1", "running");
      expect((await store.getNodeRecord(RUN, NODE, "P0"))?.status).toBe(
        "complete",
      );
      expect((await store.getNodeRecord(RUN, NODE, "P1"))?.status).toBe(
        "running",
      );
    });

    it("setNodeRecord upserts port + output + metrics without clobbering resumeToken", async () => {
      await store.setResumeToken(RUN, NODE, "P0", "sess-123");
      await store.setNodeRecord(RUN, {
        nodeId: NODE,
        pathId: "P0",
        status: "complete",
        port: "on-success",
        output: { files: ["a.ts"] },
        metrics: { duration: 42 },
      });
      const rec = await store.getNodeRecord(RUN, NODE, "P0");
      expect(rec).toMatchObject({
        status: "complete",
        port: "on-success",
        output: { files: ["a.ts"] },
        metrics: { duration: 42 },
        resumeToken: "sess-123",
      });
    });
  });

  describe("resume tokens", () => {
    beforeEach(async () => {
      await store.createRun(RUN, sampleFlow, {});
    });

    it("persists and reads a resume token", async () => {
      await store.setResumeToken(RUN, NODE, "P0", "sess-abc");
      expect(await store.getResumeToken(RUN, NODE, "P0")).toBe("sess-abc");
      expect(await store.getResumeToken(RUN, NODE, "P1")).toBeUndefined();
    });
  });

  describe("appendOutput", () => {
    beforeEach(async () => {
      await store.createRun(RUN, sampleFlow, {});
    });

    it("appends chunks to a per-node log and reads them back", async () => {
      await store.appendOutput(RUN, NODE, "P0", "line one\n");
      await store.appendOutput(RUN, NODE, "P0", "line two\n");
      expect(await store.getOutput(RUN, NODE, "P0")).toBe(
        "line one\nline two\n",
      );
    });

    it("returns empty string for a node that never streamed", async () => {
      expect(await store.getOutput(RUN, "n_lint", "P0")).toBe("");
    });

    it("sanitizes a pathId containing path separators into the log filename", async () => {
      await store.appendOutput(RUN, NODE, "P0/1", "chunk");
      // The state key still uses the raw pathId…
      await store.setNodeStatus(RUN, NODE, "P0/1", "running");
      expect(await store.getOutput(RUN, NODE, "P0/1")).toBe("chunk");
      expect((await store.getNodeRecord(RUN, NODE, "P0/1"))?.pathId).toBe(
        "P0/1",
      );
    });
  });

  describe("setFlowStatus", () => {
    beforeEach(async () => {
      await store.createRun(RUN, sampleFlow, {});
    });

    it("sets the flow-level status and pairs abortReason with aborted", async () => {
      await store.setFlowStatus(RUN, "aborted", { reason: "caller-cancel" });
      const snap = await store.getSnapshot(RUN);
      expect(snap.status).toBe("aborted");
      expect(snap.abortReason).toEqual({ reason: "caller-cancel" });
    });
  });

  describe("recover scan (listRuns)", () => {
    it("lists committed runs and skips dot-prefixed staging dirs", async () => {
      await store.createRun("r-a", sampleFlow, {});
      await store.setFlowStatus("r-a", "complete");

      // Simulate a crashed createRun: a stranded staging dir.
      mkdirSync(join(root, "runs", ".crashed.tmp-xyz", "nodes"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "runs", ".crashed.tmp-xyz", "state.json"),
        '{"status":"running"}',
      );

      const runs = await store.listRuns();
      expect(runs.map((r) => r.runId)).toEqual(["r-a"]);
      expect(runs[0]?.status).toBe("complete");
    });

    it("returns an empty list when no runs directory exists", async () => {
      expect(await new FsRunStore(join(root, "missing")).listRuns()).toEqual(
        [],
      );
    });
  });

  describe("crash-resume: a restarted process reads consistent state", () => {
    it("a fresh FsRunStore at the same root sees the last durable write", async () => {
      // First "process" writes the run through several transitions, then "dies"
      // (we simply stop using this instance — nothing is cached across instances;
      // all state is on disk and re-read on demand).
      await store.createRun(RUN, sampleFlow, { seed: 1 });
      await store.setNodeStatus(RUN, NODE, "P0", "running");
      await store.setResumeToken(RUN, NODE, "P0", "sess-resume");
      await store.appendOutput(RUN, NODE, "P0", "streamed output\n");
      await store.setNodeRecord(RUN, {
        nodeId: NODE,
        pathId: "P0",
        status: "complete",
        port: "out",
        output: { ok: true },
        metrics: { tokens: 900 },
      });
      // The engine would call setFlowStatus("paused") before a human pause.
      await store.setFlowStatus(RUN, "paused");

      // New process, same root — simulates a crash + restart.
      const restarted = new FsRunStore(root);

      const runs = await restarted.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.runId).toBe(RUN);
      expect(runs[0]?.status).toBe("paused");

      const snap = await restarted.getSnapshot(RUN);
      expect(snap.status).toBe("paused");
      expect(snap.nodes).toHaveLength(1);
      const rec = snap.nodes[0];
      expect(rec).toMatchObject({
        nodeId: NODE,
        pathId: "P0",
        status: "complete",
        port: "out",
        resumeToken: "sess-resume",
      });
      expect(rec?.output).toEqual({ ok: true });
      expect(rec?.metrics).toEqual({ tokens: 900 });
      expect(await restarted.getResumeToken(RUN, NODE, "P0")).toBe(
        "sess-resume",
      );
      expect(await restarted.getOutput(RUN, NODE, "P0")).toBe(
        "streamed output\n",
      );
    });
  });

  describe("deleteRun", () => {
    it("removes the run directory", async () => {
      await store.createRun(RUN, sampleFlow, {});
      await store.deleteRun(RUN);
      expect(await store.listRuns()).toEqual([]);
    });
  });

  describe("status type round-trip", () => {
    it("persists every NodeStatus value", async () => {
      await store.createRun(RUN, sampleFlow, {});
      const statuses: NodeStatus[] = [
        "pending",
        "running",
        "complete",
        "paused",
        "aborted",
        "skipped",
      ];
      for (const [i, s] of statuses.entries()) {
        await store.setNodeStatus(RUN, `n${i}`, "P0", s);
      }
      const snap = await store.getSnapshot(RUN);
      expect(snap.nodes.map((n) => n.status)).toEqual(statuses);
    });

    it("persists every FlowStatus value", async () => {
      await store.createRun(RUN, sampleFlow, {});
      const statuses: FlowStatus[] = [
        "running",
        "complete",
        "paused",
        "aborted",
        "failed",
      ];
      for (const s of statuses) {
        await store.setFlowStatus(RUN, s);
        expect((await store.getSnapshot(RUN)).status).toBe(s);
      }
    });
  });
});
