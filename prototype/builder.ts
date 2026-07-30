/**
 * PROTOTYPE — throwaway. Fluent builder that serializes to canonical Flow JSON,
 * cut from docs/registry-builder-api.md. One generic `.node(kind, params)`
 * method, cls-typed handles, build-time single-input enforcement, serialize().
 * Untyped where the real builder uses conditional types from the registry —
 * the prototype's job is to feel the contract, not carry its type system.
 */
import { randomUUID } from "node:crypto";

import type { Flow, Node, Edge } from "./types.js";
import type { Registry, NodeRunner } from "./registry.js";

type Handle = {
  id: string;
  cls: "action" | "branch" | "merge";
  incomingForward: number;
};

export function flow(reg: Registry) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const handles = new Map<string, Handle>();

  const resolveRunner = (kind: string, version: string): NodeRunner =>
    reg.resolve(kind, version);

  function node(
    kind: string,
    params: Record<string, unknown>,
    opts?: { name?: string; id?: string; version?: string },
  ) {
    const version = opts?.version ?? "1.0.0";
    const runner = resolveRunner(kind, version);
    const id = opts?.id ?? randomUUID();
    const name = opts?.name ?? kind;
    nodes.push({ id, name, kind, version, cls: runner.cls, params });
    const h: Handle = { id, cls: runner.cls, incomingForward: 0 };
    handles.set(id, h);
    return makeHandle(h);
  }

  function makeHandle(h: Handle): any {
    const api: any = {
      id: h.id,
      to(
        target: any,
        opts?: {
          kind?: "forward" | "feedback";
          binding?: Record<string, string>;
        },
      ) {
        wireEdge(h, target._h, "out", "forward-in", opts);
        return target;
      },
      _h: h,
    };
    if (h.cls === "branch") {
      api.on = (port: string) => ({
        to(
          target: any,
          opts?: {
            kind?: "forward" | "feedback";
            binding?: Record<string, string>;
          },
        ) {
          wireEdge(h, target._h, port, "forward-in", opts);
          return target;
        },
        dangle(opts?: {
          kind?: "forward" | "feedback";
          binding?: Record<string, string>;
        }) {
          wireEdge(h, undefined, port, "dangle", opts);
          return api;
        },
      });
    }
    return api;
  }

  function wireEdge(
    from: Handle,
    to: Handle | undefined,
    fromPort: string,
    _slot: string,
    opts?: { kind?: "forward" | "feedback"; binding?: Record<string, string> },
  ) {
    const kind = opts?.kind ?? "forward";
    if (kind === "forward" && to) {
      to.incomingForward += 1;
      if (to.cls !== "merge" && to.incomingForward > 1) {
        throw new Error(
          `node '${to.id}' already has one forward incoming edge (single-input)`,
        );
      }
    }
    edges.push({
      id: randomUUID(),
      from: { node: from.id, port: fromPort },
      to: to ? { node: to.id } : undefined,
      binding: opts?.binding,
      kind,
    });
  }

  function serialize(): Flow {
    // minimal validity check: ports exist on the resolved runner
    for (const e of edges) {
      const fromNode = nodes.find((n) => n.id === e.from.node)!;
      const runner = resolveRunner(fromNode.kind, fromNode.version);
      if (!(e.from.port in runner.outputPorts)) {
        throw new Error(
          `edge ${e.id}: port '${e.from.port}' not on ${fromNode.kind}`,
        );
      }
    }
    return {
      meta: { id: randomUUID(), revision: 1, schema: "1.0.0" },
      graph: { nodes, edges },
    };
  }

  return { node, serialize };
}
