/**
 * PROTOTYPE — throwaway. The three MVP NodeRunners. `code` and `gate` are real;
 * `opencode` is a STUB that simulates an agent session incl. resume semantics
 * (no agent tokens). Honors ctx.resumeToken to exercise the feedback→resume
 * contract the engine is proving. A real `sandcastle.run({agent})` integration
 * is a follow-on ticket.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { defineActionRunner, defineBranchRunner } from "./registry.js";
import type { NodeRunResult, RunCtx } from "./types.js";

const exec = promisify(execFile);
const SCRATCH = resolve(process.cwd(), "prototype", "scratch", "sample.ts");

// Deliberately unformatted source the `code` node's prettier --check will fail on.
const BROKEN = `const x=1;function   foo(  a ,b){return a+b;}`;

const opencodeRunner = defineActionRunner({
  kind: "opencode",
  version: "1.0.0",
  outputPorts: { out: ["summary"] },
  inputFields: [],
  idempotent: false,
  run: async (
    _input: Record<string, unknown>,
    ctx: RunCtx,
  ): Promise<NodeRunResult> => {
    if (ctx.resumeToken) {
      // Feedback re-entry: the gate routed on-failure back here. Simulate the
      // agent "reading" the lint failure and fixing the scratch file.
      const failure = (ctx.resumeInput as Record<string, unknown>) ?? {};
      ctx.stream(
        `[opencode] resuming session ${ctx.resumeToken} with gate failure:\n${String(failure.stdout ?? "")}`,
      );
      ctx.stream("[opencode] agent is reformatting the offending file…\n");
      await mkdir(dirname(SCRATCH), { recursive: true });
      // Apply prettier --write to "fix" (the agent's action, simulated).
      const { stdout, exitCode } = await runPrettier(true);
      if (exitCode !== 0) {
        ctx.stream(`[opencode] prettier --write failed: ${stdout}\n`);
      } else {
        ctx.stream("[opencode] file reformatted; loop resumes\n");
      }
      return {
        status: "complete",
        port: "out",
        output: { summary: "fixed-by-agent" },
        resumeToken: ctx.resumeToken,
      };
    }

    // Cold start: the agent "implements" by writing a deliberately broken file
    // (this is what the lint gate will catch, exercising the feedback loop).
    const sessionId = `stub-session-${randomUUID().slice(0, 8)}`;
    ctx.stream("[opencode] agent session starting (cold invoke)\n");
    await mkdir(dirname(SCRATCH), { recursive: true });
    await rm(SCRATCH, { force: true });
    await writeFile(SCRATCH, BROKEN, "utf8");
    ctx.stream(
      `[opencode] wrote scratch file (misformatted) — session ${sessionId}\n`,
    );
    if (ctx.setResumeToken) await ctx.setResumeToken(sessionId);
    return {
      status: "complete",
      port: "out",
      output: { summary: "implemented-v1" },
      resumeToken: sessionId,
    };
  },
});

const codeRunner = defineActionRunner({
  kind: "code",
  version: "1.0.0",
  outputPorts: { out: ["exitCode", "stdout"] },
  inputFields: ["summary"],
  idempotent: true,
  run: async (
    _input: Record<string, unknown>,
    ctx: RunCtx,
  ): Promise<NodeRunResult> => {
    ctx.stream("[code] running prettier --check against scratch file\n");
    const { exitCode, stdout } = await runPrettier(false);
    ctx.stream(`[code] exit=${exitCode}\n${stdout}\n`);
    return {
      status: "complete",
      port: "out",
      output: { exitCode, stdout },
    };
  },
});

const gateRunner = defineBranchRunner({
  kind: "gate",
  version: "1.0.0",
  outputPorts: { "on-success": [], "on-failure": [] },
  inputFields: ["exitCode", "stdout"],
  idempotent: true,
  run: async (
    input: Record<string, unknown>,
    ctx: RunCtx,
  ): Promise<NodeRunResult> => {
    const on = String(ctx.params.on ?? "exitCode");
    const value = Number(input[on] ?? 1);
    const port = value === 0 ? "on-success" : "on-failure";
    ctx.stream(
      `[gate] ${on}=${value} → routing to ${port}${port === "on-failure" ? " (feedback → implement)" : " (dangle → done)"}\n`,
    );
    return { status: "complete", port, output: {} };
  },
});

// ── helper: run prettier against the scratch file ──
async function runPrettier(
  write: boolean,
): Promise<{ exitCode: number; stdout: string }> {
  const args = [write ? "--write" : "--check", SCRATCH];
  try {
    const { stdout } = await exec("npx", ["prettier", ...args], {
      maxBuffer: 1 << 20,
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.code ?? 1,
      stdout: e.stdout ?? e.stderr ?? String(err),
    };
  }
}

export const runners = {
  opencode: opencodeRunner,
  code: codeRunner,
  gate: gateRunner,
};
