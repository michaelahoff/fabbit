/**
 * PROTOTYPE — throwaway. One command: `npx tsx prototype/run.ts`.
 *
 * Builds the canonical ADW loop (implement → lint → gate; on-success dangles,
 * on-failure feeds back to implement), runs it under the engine against the
 * real FsRunStore, and prints the per-node outcomes + the runs/<id>/ log paths
 * so you can read the failure-routed re-prompt in the persisted log.
 */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const ROOT = resolve(process.cwd(), "prototype");

import { FsRunStore } from "../src/engine/fs-run-store.js";
import { createRegistry } from "./registry.js";
import { flow } from "./builder.js";
import { Engine } from "./engine.js";
import { runners } from "./runners.js";

async function main() {
  const reg = createRegistry(runners);
  const f = flow(reg);

  const implement = f.node(
    "opencode",
    { prompt: "Implement the feature in prototype/scratch/sample.ts" },
    { name: "implement" },
  );
  const lint = f.node(
    "code",
    { cmd: "prettier --check prototype/scratch/sample.ts" },
    { name: "lint" },
  );
  const gate = f.node("gate", { on: "exitCode" }, { name: "gate" });

  implement.to(lint);
  lint.to(gate);
  gate.on("on-success").dangle();
  gate.on("on-failure").to(implement, { kind: "feedback" });

  const flowJson = f.serialize();
  console.log("=== MVP flow ===");
  console.dir(flowJson, { depth: null });

  const store = new FsRunStore(ROOT);
  const engine = new Engine(reg, store);

  console.log("\n=== running ===");
  const result = await engine.run(flowJson, {});

  console.log("\n=== result ===");
  console.dir(result, { depth: null });

  // Surface the persisted streamed-output logs — the proof the feedback re-prompt
  // was routed: the gate's on-failure chunk and the opencode-resume chunk should
  // both appear in their node logs.
  console.log(`\n=== runs dir: ${resolve(ROOT, "runs", result.runId)} ===`);
  for (const outcome of result.nodes) {
    const log = await store.getOutput(
      result.runId,
      outcome.nodeId,
      outcome.pathId,
    );
    console.log(
      `\n--- ${outcome.nodeId} (${outcome.pathId}) port=${outcome.port} ---\n${log}`,
    );
  }
  // Dump state.json for visibility.
  const state = await readFile(
    resolve(ROOT, "runs", result.runId, "state.json"),
    "utf8",
  );
  console.log("\n=== state.json ===");
  console.log(state);

  process.exit(result.status === "complete" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
