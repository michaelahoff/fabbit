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
type MergeNode  = NodeBase & { cls: "merge" };
type Node = ActionNode | BranchNode | MergeNode;
// Uniform: `cls` is the only discriminator; no variant carries extra fields.
// `join` is a runner behavior, so it lives on the registry entry (kind-level), not the node.

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

## Registry entry contract

The DAG is *data, not code*: `node.kind` + `node.version` resolve to a **registry entry** that owns the typed/behavioral contract the transport schema deliberately leaves untyped. Tickets 03 (builder) and 04 (engine) both code against this. The entry is resolved at engine load; invariants #2, #3, #10 and identity-wiring validation all depend on it.

```ts
type RegistryEntry = {
  kind: string;                          // "gate" | "code" | "opencode" | "@fabbit/..." — matches node.kind
  version: string;                       // semver; matches node.version
  cls: "action" | "branch" | "merge";    // the node's cls must equal this (author can't lie)
  outputPorts: Record<string, string[]>; // port -> its field names; backs invariant #10 and binding upstreamField validation
  inputFields: string[];                 // the shape this node's single logical input must have; backs identity-wiring validation
                                         //   action/branch: the one incoming edge's payload fields
                                         //   merge: the common shape every incoming edge must project into (via binding)
  paramSchema: StandardSchema;           // validates node.params (invariant #3)
  runner: unknown;                       // opaque here; impl typed by ticket 04
  join?: "all" | "race";                 // present iff cls: "merge"; kind-level, not node-level
};
```

Design decisions pinned here (grilling session for issue #7):
- **`cls` is validated against the entry**, not a free authorial assertion. `kind: "gate", cls: "action"` is a load-time reject.
- **Ports declare field-name lists, not full schemas** (`outputPorts: Record<string, string[]>`). Binding `upstreamField` typos are caught at load; field *types* stay runtime-validated by the downstream `paramSchema`. Upgradable to full per-port schemas later without breaking the slot.
- **Identity wiring is load-validated**: an edge with no `binding` requires the upstream port's field list to equal the downstream entry's `inputFields`. This is why the entry declares `inputFields`.
- **Merge is a homogeneous join.** One `inputFields` list; heterogeneous upstreams project into the common shape via explicit `binding`s. The edge schema is unchanged (no `to.port`); semantic input roles for merge, if a real flow needs them, graduate from fog as a later slice.
- **`join` lives on the entry, not the node.** A race-join and an all-join are different runner code paths — closer to two kinds sharing a `cls` than one kind with a knob. This makes the node union uniform (`cls` is the only discriminator; no variant carries extra fields). A flow that wants the same logical merge with both policies uses two kinds (e.g. `@fabbit/join-all`, `@fabbit/join-race`).

## Node classes

Three classes, distinguished by edge fan, *not* by determinism or IO (pure compute is an action whose runner happens to be deterministic — runner-implementation concerns belong on the runner, not the class):

| class   | in         | out            | notes                                  |
|---------|------------|----------------|----------------------------------------|
| action  | exactly 1  | exactly 1      | default; one typed input, one output   |
| branch  | exactly 1  | ≥1, select one | runner picks which output port fires   |
| merge   | ≥1 (join)  | exactly 1      | join policy is kind-level (on the entry): `"all"` (wait all) \| `"race"` (first wins, abort rest) |

## Entry points

Inferred, not flagged: **a node is an entry point iff it has zero incoming `kind: "forward"` edges.** Feedback edges don't count toward "is this a start" — they re-enter a node that's already been started. Multiple entries = parallel kickoff; MVP has one.

## Flow termination

A flow with no merge node terminates when **all forward branches dangle** (a forward edge with no `to`). Dangling is expressed by omitting `to` on the edge. A degenerate single-action flow (zero edges) runs once and finishes — no edge requirement.

## Invariants (Zod-enforced)

1. `node.id` unique within `graph.nodes`; builder rejects duplicate before serialize.
2. `node.kind` + `node.version` resolves in the registry on engine load (else reject: "unknown kind/version"). The node's `cls` must equal the resolved entry's `cls` (author can't lie about structure).
3. `node.params` parsed/validated by the resolved entry's `paramSchema` on load.
4. `join` lives on the entry, not the node: the resolved entry has `join` iff its `cls` is `"merge"`; the node record carries no `join` field.
5. `action` node: exactly one incoming forward edge, exactly one outgoing.
6. `branch` node: exactly one incoming forward edge; ≥1 outgoing, each with a distinct `from.port`.
7. `merge` node: ≥1 incoming forward edge; exactly one outgoing.
8. `edge.from.node` / `edge.to.node` reference existing `node.id`s.
9. `edge.kind: "feedback"` — its `from.node` is downstream of `to.node` in the forward skeleton (else it's not a back-edge).
10. `edge.from.port` matches a key in the upstream entry's `outputPorts`; each `binding` `upstreamField` is in that port's field-name list.
11. **Identity wiring**: an edge with no `binding` requires the upstream port's field list (`entry.outputPorts[port]`) to equal the downstream node's `entry.inputFields`. A `binding` is required whenever they differ.
12. **Forward edges form a DAG** (acyclic). Feedback edges are excluded from the acyclicity check — that's their purpose. A cycle with no entry (every node has an incoming forward edge) is rejected.
13. A flow has ≥1 node. A degenerate flow with one node and zero edges is valid (single-action run).

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

This grilling revised six locked decisions, surfaced and pinned during schema work before any code was written (cheapest moment, per the "pin contracts cheaply now when the retrofit would be expensive" preference):

1. **Node classes: two → three.** "Routing" was conflating two opposite behaviors; split into `branch` (one-in, select-one-out, no join) and `merge` (many-in join, one-out). The `gate` node is a `branch`; the `merge` node is a `merge`.
2. **MVP node set: four → three.** The MVP flow has no merge node (it terminates via a dangling forward edge), so `merge` is not exercised by ticket 05. MVP demos `opencode`, `code`, `gate` only.
3. **Feedback edges made explicit.** "DAG" is a misnomer — the graph is acyclic in its forward edges and carries loops as explicit `kind: "feedback"` edges. "Flow" is the strict term for what the engine walks; "DAG" stays as loose vocabulary for the forward skeleton.
4. **Registry entry contract pinned.** The original schema assumed a registry ("resolves via registry") but never specified the entry's shape. Added the `RegistryEntry` contract (`kind`, `version`, `cls`, `outputPorts`, `inputFields`, `paramSchema`, `runner`, `join?`) — the typed counterpart the transport schema delegates to. Tickets 03/04 depend on it.
5. **`join` relocated: node record → registry entry.** A race-join and an all-join are different runner code paths, so `join` is kind-level, not per-instance. The node union becomes uniform: `cls` is the only discriminator, no variant carries extra fields.
6. **Identity wiring made load-validatable.** The entry declares `inputFields`; an edge with no `binding` requires the upstream port's field list to equal the downstream entry's `inputFields`. Closes the gap where "absent = identity" was convention-only.

## Deferred to fog

- **`merge` first real exercise.** Now that the MVP doesn't use it, the first flow that needs fan-in graduates `merge` from "Not yet specified" as its own ticket.
- **`scatter` (fan-out-all) class.** "1 input -> ALL N outputs fire simultaneously" is a fourth structural class, not expressible by any existing class (`action` has exactly one output edge; `branch` selects one of N). It is deferred *alongside merge* — scatter without a join to rejoin is a half-feature, and the first real flow that needs fan-out-all will need fan-in-all too. The schema does not obstruct it: a future `cls: "scatter"` slots into the extensible node union and entry contract without touching the envelope or edge shape.
- **Compound/sub-flow nodes.** The schema does not obstruct them (a `kind: "@fabbit/compound"` could wrap a sub-flow as `params`), but nothing is specified — remains fog per the map.
- **Switch/filter branch kinds.** The port-naming *mechanism* is resolved: each branch kind declares its `outputPorts` on its registry entry, validated by invariant #10. Only the *content* (which port names specific future kinds use) is TBD — and that's a per-kind authorial decision, not a schema question. Graduates as branch kinds beyond `gate` are registered.
- **Merge semantic input roles.** Merge is homogeneous (one `inputFields`; heterogeneous upstreams project via `binding`). If a real flow needs the merge to treat inputs as semantically distinct *roles* (not just differently-shaped data), that escalates to named input slots (`to.port` on the edge + `inputSlots` on the entry) as a later slice.