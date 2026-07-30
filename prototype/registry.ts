/**
 * PROTOTYPE — throwaway. Minimal registry + NodeRunner helpers, lifted from
 * docs/registry-builder-api.md but cut to the three MVP kinds. No StandardSchema
 * wiring, no paramSchema validation — params are stored as-is. The validated
 * version of this is a real `src/registry.ts` module, not this file.
 */
import type {
  ActionRunFn,
  BranchRunFn,
  NodeRunResult,
  RunCtx,
} from "./types.js";

export type NodeRunner = {
  kind: string;
  version: string;
  cls: "action" | "branch";
  outputPorts: Record<string, string[]>;
  inputFields: string[];
  idempotent: boolean;
  run: ActionRunFn | BranchRunFn;
};

export function defineActionRunner(r: {
  kind: string;
  version: string;
  outputPorts: Record<string, string[]>;
  inputFields: string[];
  idempotent?: boolean;
  run: ActionRunFn;
}): NodeRunner {
  return { ...r, cls: "action", idempotent: r.idempotent ?? false };
}

export function defineBranchRunner(r: {
  kind: string;
  version: string;
  outputPorts: Record<string, string[]>;
  inputFields: string[];
  idempotent?: boolean;
  run: BranchRunFn;
}): NodeRunner {
  return { ...r, cls: "branch", idempotent: r.idempotent ?? false };
}

export type Registry = {
  resolve(kind: string, version: string): NodeRunner;
};

export function createRegistry(initial: Record<string, NodeRunner>): Registry {
  const byKey = new Map<string, NodeRunner>();
  for (const runner of Object.values(initial)) {
    const key = `${runner.kind}@${runner.version}`;
    if (byKey.has(key)) throw new Error(`duplicate kind@version: ${key}`);
    byKey.set(key, runner);
  }
  return {
    resolve(kind, version) {
      const r = byKey.get(`${kind}@${version}`);
      if (!r) throw new Error(`unknown kind@version: ${kind}@${version}`);
      return r;
    },
  };
}
