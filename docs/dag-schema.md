# Fabbit DAG Model — Canonical Flow Schema (v1.0.0)

The contract's persistence layer. Every flow file on disk, every `runs/<id>/flow.json` snapshot, every editor payload is an instance of this schema. The builder API (ticket 03) serializes to it; the engine (ticket 04) walks it.

Resolution of [02 — DAG model: node, edge, port binding JSON schema](https://github.com/michaelahoff/fabbit/issues/7).

## Schema

```ts
// ── Envelope ──
type Flow = {
  meta: {
    id: string;        // UUID — the flow's stable identity, survives edits
    revision: number;  // integer, bumps on every save (file revision; NOT semver)
    schema: string;    // DAG-schema semver, e.g. "1.0.0" — checked before parse so the engine can reject migrations
  };
  graph: { nodes: Node[]; edges: Edge[] };
};

// ── Nodes (discriminated union on `cls`) ──
type NodeBase = {
  id: string;          // UUID, stable across edits; the key edges & snapshots reference
  name: string;        // human-readable display name; what the builder/editor shows; rename touches only this
  kind: string;        // namespaced ("@fabbit/code") or bare builtin; resolves via registry
  version: string;     // node-kind contract semver (per-node; independent of meta.revision & meta.schema)
  params: unknown;     // validated by the registry's Zod schema for kind+version on engine load — DAG is data, not code
};
type ActionNode = NodeBase & { cls: "action" };
type BranchNode = NodeBase & { cls: "branch" };
type MergeNode  = NodeBase & { cls: "merge"; join: "all" | "race" };
type Node = ActionNode | BranchNode | MergeNode;

// ── Edges ──
type Edge = {
  id: string;          // UUID, stable
  from: {
    node: string;      // upstream node id
    port: string;      // named output on the upstream node-kind; "out" for action, "on-success"|"on-failure"|... for branch
  };
  to?: {
    node: string;      // downstream node id; OMITTED on a dangling forward edge (flow terminates when a branch's selected output has no `to`)
  };
  binding?: Record<string, string>;  // {downstreamField: upstreamField}; absent = identity (downstream input shape == upstream output shape)
  kind: "forward" | "feedback";      // feedback marks a re-entry (resume the agent, don't re-invoke cold); engine bounds iteration per feedback edge
};
```

## Node classes

Three classes, distinguished by edge fan, *not* by determinism or IO (pure compute is an action whose runner happens to be deterministic — runner-implementation concerns belong on the runner, not the class):

| class   | in         | out            | notes                                  |
|---------|------------|----------------|----------------------------------------|
| action  | exactly 1  | exactly 1      | default; one typed input, one output   |
| branch  | exactly 1  | ≥1, select one | runner picks which output port fires   |
| merge   | ≥1 (join)  | exactly 1      | `join: "all"` (wait all) \| `"race"` (first wins, abort rest) |

## Entry points

Inferred, not flagged: **a node is an entry point iff it has zero incoming `kind: "forward"` edges.** Feedback edges don't count toward "is this a start" — they re-enter a node that's already been started. Multiple entries = parallel kickoff; MVP has one.

## Flow termination

A flow with no merge node terminates when **all forward branches dangle** (a forward edge with no `to`). Dangling is expressed by omitting `to` on the edge. A degenerate single-action flow (zero edges) runs once and finishes — no edge requirement.

## Invariants (Zod-enforced)

1. `node.id` unique within `graph.nodes`; builder rejects duplicate before serialize.
2. `node.kind` + `node.version` resolves in the registry on engine load (else reject: "unknown kind/version").
3. `node.params` parsed/validated by the registry's Zod schema for `kind+version` on load.
4. `merge.join` required; `action`/`branch` forbid `join`.
5. `action` node: exactly one incoming forward edge, exactly one outgoing.
6. `branch` node: exactly one incoming forward edge; ≥1 outgoing, each with a distinct `from.port`.
7. `merge` node: ≥1 incoming forward edge; exactly one outgoing.
8. `edge.from.node` / `edge.to.node` reference existing `node.id`s.
9. `edge.kind: "feedback"` — its `from.node` is downstream of `to.node` in the forward skeleton (else it's not a back-edge).
10. `edge.from.port` matches a declared output of the upstream node-kind.
11. **Forward edges form a DAG** (acyclic). Feedback edges are excluded from the acyclicity check — that's their purpose. A cycle with no entry (every node has an incoming forward edge) is rejected.
12. A flow has ≥1 node. A degenerate flow with one node and zero edges is valid (single-action run).

## MVP flow instance (the ADW loop: implement → lint → gate → resume-on-fail)

This is the canonical example the schema must express (ticket 05). Note: the original locked four-node MVP set is **three** — merge is not exercised by the MVP flow; it terminates via a dangling forward edge. Merge's first real exercise graduates from fog as a later slice.

```jsonc
{
  "meta": { "id": "f1b2…3a", "revision": 1, "schema": "1.0.0" },
  "graph": {
    "nodes": [
      { "id": "n_implement", "name": "implement", "kind": "opencode", "version": "1.0.0", "cls": "action",
        "params": { "prompt": "Implement the feature in src/foo.ts" } },
      { "id": "n_lint",      "name": "lint",      "kind": "code",     "version": "1.0.0", "cls": "action",
        "params": { "cmd": "npm run lint" } },
      { "id": "n_gate",      "name": "gate",      "kind": "gate",     "version": "1.0.0", "cls": "branch",
        "params": { "on": "exitCode" } }
    ],
    "edges": [
      { "id": "e1", "from": { "node": "n_implement", "port": "out" },       "to": { "node": "n_lint" },        "kind": "forward"  },
      { "id": "e2", "from": { "node": "n_lint",      "port": "out" },       "to": { "node": "n_gate" },        "kind": "forward"  },
      { "id": "e3", "from": { "node": "n_gate",      "port": "on-success" },                                    "kind": "forward"  },
      { "id": "e4", "from": { "node": "n_gate",      "port": "on-failure" }, "to": { "node": "n_implement" },   "kind": "feedback" }
    ]
  }
}
```

Reading: `implement` is the entry (zero forward-in). Flow runs implement → lint → gate. On-success → dangles, flow terminates. On-failure → feedback to `implement` (resume with the lint failure, bounded by max-loops).

## Changes to the v0.2 locked contract

This grilling revised three locked decisions, surfaced and pinned during schema work before any code was written (cheapest moment, per the "pin contracts cheaply now when the retrofit would be expensive" preference):

1. **Node classes: two → three.** "Routing" was conflating two opposite behaviors; split into `branch` (one-in, select-one-out, no join) and `merge` (many-in join, one-out). The `gate` node is a `branch`; the `merge` node is a `merge`.
2. **MVP node set: four → three.** The MVP flow has no merge node (it terminates via a dangling forward edge), so `merge` is not exercised by ticket 05. MVP demos `opencode`, `code`, `gate` only.
3. **Feedback edges made explicit.** "DAG" is a misnomer — the graph is acyclic in its forward edges and carries loops as explicit `kind: "feedback"` edges. "Flow" is the strict term for what the engine walks; "DAG" stays as loose vocabulary for the forward skeleton.

## Deferred to fog

- **`merge` first real exercise.** Now that the MVP doesn't use it, the first flow that needs fan-in graduates `merge` from "Not yet specified" as its own ticket.
- **Compound/sub-flow nodes.** The schema does not obstruct them (a `kind: "@fabbit/compound"` could wrap a sub-flow as `params`), but nothing is specified — remains fog per the map.
- **Branch port vocabulary.** `"on-success"` / `"on-failure"` work for the gate; other branch kinds (switch, filter) will discover their own port names. Graduates as branch kinds beyond `gate` arrive.