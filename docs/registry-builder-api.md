# Fabbit Node-Type Registry & Builder API

The two TS surfaces over the canonical DAG: (a) the **registry** that node-type authors register `NodeRunner`s into and that the engine/editor read from, and (b) the **builder API** that serializes to canonical `Flow` JSON. The builder is a _serializer_ — it produces the schema from [dag-schema.md](./dag-schema.md); it does not reinvent the model.

Resolution of [03 — Node-type registry and builder API](https://github.com/michaelahoff/fabbit/issues/3).

## NodeRunner — self-describing, is the registry entry

The runner carries its own contract metadata as static properties, alongside its `run` logic. The runner _is_ the entry — `RegistryEntry` from the DAG schema is the TS interface the runner implements, not a separate runtime wrapper.

```ts
import type { StandardSchema } from "@standard-schema/spec";

interface NodeRunner<P = unknown> {
  kind: string; // namespaced ("@fabbit/code") or bare builtin ("code")
  version: string; // node-kind contract semver
  cls: "action" | "branch" | "merge"; // structural class; pinned by the helper, not a free assertion
  outputPorts: Record<string, string[]>; // port -> field names (invariant #10, binding upstreamField check)
  inputFields: string[]; // the node's input shape (identity-wiring validation, invariant #11)
  paramSchema: StandardSchema; // validates node.params; its output type is the builder's param type AND the runner's ctx.params type (P)
  run: NodeRunFn<P>; // execution — typed by 04 (engine); P (paramSchema output) threads onto ctx.params
  join?: "all" | "race"; // present iff cls: "merge" (kind-level, not node-level)
}

// Typed by 04 (engine); see docs/engine.md. `P` is this runner's paramSchema output
// type — inferred by the defineXRunner helper from `paramSchema` and threaded onto
// `ctx.params` (RunCtx<P>). The engine supplies the validated `node.params`, erased
// at the engine boundary; the runner's typed view is a boundary assertion (same
// mechanism `input` uses — engine passes Record<string,unknown>, runner sees
// Record<inputFields[number],unknown>). Refined by ticket 08: `params` rides ctx,
// fully typed as P (one primary data arg `input`; all secondary in-channels ride ctx).
type ActionRunFn<P = unknown> = (
  input: Record<inputFields[number], unknown>,
  ctx: RunCtx<P>,
) => Promise<NodeRunResult>;
type BranchRunFn<P = unknown> = (
  input: Record<inputFields[number], unknown>,
  ctx: RunCtx<P>,
) => Promise<NodeRunResult>;
type MergeRunFn<P = unknown> = (
  inputs: Record<inputFields[number], unknown>[],
  ctx: RunCtx<P>,
) => Promise<NodeRunResult>;
type NodeRunFn<P = unknown> = ActionRunFn<P> | BranchRunFn<P> | MergeRunFn<P>;
```

The param type the builder type-checks against is extracted from any Standard Schema validator via `paramSchema["~standard"]["types"]["output"]` (Zod, Valibot, etc. — the codebase uses Zod).

## Author helpers — three, fixed (one per class)

```ts
const codeRunner = defineActionRunner({
  kind: "code",
  version: "1.0.0",
  paramSchema: z.object({ cmd: z.string() }),
  outputPorts: { out: ["exitCode", "stdout"] },
  inputFields: ["prompt"],
  run: async (input, ctx) => {
    /* ticket 04 types this */
  },
});

const gateRunner = defineBranchRunner({
  kind: "gate",
  version: "1.0.0",
  paramSchema: z.object({ on: z.string() }),
  outputPorts: { "on-success": [], "on-failure": [] },
  inputFields: ["exitCode", "stdout"],
  run: async (input, ctx) => {
    /* selects an output port */
  },
});

const joinAllRunner = defineMergeRunner({
  kind: "@fabbit/join-all",
  version: "1.0.0",
  join: "all",
  paramSchema: z.object({}),
  outputPorts: { out: [] },
  inputFields: [],
  run: async (inputs, ctx) => {
    /* ticket 04 */
  },
});
```

Each helper **pins `cls`** (you can't call `defineActionRunner` and lie that it's a merge — the helper sets it), **infers the param type** from `paramSchema`, and returns a typed `NodeRunner`. Three helpers, fixed — the interface grows with classes (3, fixed), not kinds (unbounded).

## Registry — one static declaration, two surfaces

```ts
const reg = createRegistry({
  opencode: opencodeRunner,
  code: codeRunner,
  gate: gateRunner,
});
```

`createRegistry(initial)` takes a static object literal mapping kind → runner. **One declaration site** feeds both:

- **Runtime**: `reg.resolve(kind, version)` — exact-match lookup, returns the `NodeRunner`, throws on miss (a miss is always a load-time error, per invariant #2). Keyed by `kind`+`version`; `reg.register(runner)` rejects duplicate `kind`+`version` pairs (multiple versions coexist — "versioning + migrates"; migration is the engine's job, not the registry's).
- **Compile-time**: `typeof reg.kinds` is the kind→runner type map the builder reads for param/ports/cls type-checking.

`reg.register(runner)` exists for runtime plugin registration (kinds not statically known — dynamically typed, runtime-validated only).

```ts
interface Registry {
  register(runner: NodeRunner): void; // rejects duplicate kind+version
  resolve(kind: string, version: string): NodeRunner; // throws on miss
}
function createRegistry<K extends Record<string, NodeRunner>>(
  initial: K,
): Registry & { kinds: K };
```

The engine (ticket 04) receives the registry as a dependency (instance, not global — testable). Whether the engine wraps it in an Effect service is ticket 04's call; the interface above is runtime-neutral.

## Builder — fluent, typed from the registry

```ts
const f = flow(reg); // meta auto-generated; or flow(reg, { meta }) to round-trip an existing flow
```

`flow(reg)` reads `typeof reg.kinds` at compile time. The builder uses `reg` at runtime only for serialize-time validation (params via `paramSchema`).

### Node construction — one generic method, cls-typed handle

```ts
const implement = f.node(
  "opencode",
  { prompt: "Implement the feature" },
  { name: "implement" },
); // ActionHandle
const lint = f.node("code", { cmd: "npm run lint" }, { name: "lint" }); // ActionHandle
const gate = f.node("gate", { on: "exitCode" }, { name: "gate" }); // BranchHandle
```

`f.node(kind, params, opts?)` — `kind` is a literal key into the KindMap (autocomplete + type-checked); `params` is typed from `KindMap[kind].paramSchema`'s output type. `opts = { name?, id? }` — `name` defaults to `kind`, `id` auto-generated (`crypto.randomUUID()`). Returns a **cls-typed handle**. One method — the interface doesn't grow with kinds.

### Edge wiring — the handle is the seam

```ts
implement.to(lint); // forward, implicit "out" port
lint.to(gate); // forward
gate.on("on-success").dangle(); // dangling forward (terminates)
gate.on("on-failure").to(implement, { kind: "feedback" }); // feedback edge
```

- `ActionHandle.to(target, opts?)` — implicit `"out"` port (action has exactly one).
- `BranchHandle.on(port).to(target, opts?)` / `.dangle()` — `port` is compile-time checked against the branch's `outputPorts` keys (a typo won't compile).
- `MergeHandle.to(target, opts?)` — implicit `"out"`; merge **accepts** multiple incoming.
- `opts = { kind?: "forward" | "feedback", binding?: Record<string, string> }`; default `kind: "forward"`. `binding` is `{ downstreamField: upstreamField }`; absent = identity.

**Build-time single-input enforcement:** the handle tracks incoming _forward_ edges. A second forward `.to(actionHandle)` or `.to(branchHandle)` **throws at the call site**. Feedback edges don't count (re-entries, not new inputs — a node can have one forward + N feedback). Merge handles allow ≥1 incoming. This validates the canonical DAG's own invariants (#5/#6), not a new model — the builder is still a serializer.

### Serialize — guaranteed-valid output

```ts
const flowJson: Flow = f.serialize();
```

`serialize()` runs build-time validation before emitting: single-input (above), port existence (#10), forward-edge acyclicity (#12), feedback back-edge check (#9), and params parsed by the registry's `paramSchema` (#3). The returned `Flow` is guaranteed-valid; the engine re-checks at load as defense-in-depth. Binding field-name checking (identity wiring, #11) is runtime-validated at serialize; compile-time binding field checking is a deferred refinement.

## MVP flow — the ADW loop

```ts
import { z } from "zod";
import {
  createRegistry,
  flow,
  defineActionRunner,
  defineBranchRunner,
} from "fabbit";

const opencodeRunner = defineActionRunner({
  kind: "opencode",
  version: "1.0.0",
  paramSchema: z.object({ prompt: z.string() }),
  outputPorts: { out: ["result"] },
  inputFields: ["prompt"],
  run: async (input, ctx) => {
    /* ticket 04 */
  },
});

const codeRunner = defineActionRunner({
  kind: "code",
  version: "1.0.0",
  paramSchema: z.object({ cmd: z.string() }),
  outputPorts: { out: ["exitCode", "stdout"] },
  inputFields: ["prompt"],
  run: async (input, ctx) => {
    /* ticket 04 */
  },
});

const gateRunner = defineBranchRunner({
  kind: "gate",
  version: "1.0.0",
  paramSchema: z.object({ on: z.string() }),
  outputPorts: { "on-success": [], "on-failure": [] },
  inputFields: ["exitCode", "stdout"],
  run: async (input, ctx) => {
    /* selects on-success | on-failure */
  },
});

const reg = createRegistry({
  opencode: opencodeRunner,
  code: codeRunner,
  gate: gateRunner,
});

const f = flow(reg);
const implement = f.node(
  "opencode",
  { prompt: "Implement the feature in src/foo.ts" },
  { name: "implement" },
);
const lint = f.node("code", { cmd: "npm run lint" }, { name: "lint" });
const gate = f.node("gate", { on: "exitCode" }, { name: "gate" });

implement.to(lint);
lint.to(gate);
gate.on("on-success").dangle();
gate.on("on-failure").to(implement, { kind: "feedback" });

const flowJson: Flow = f.serialize();
```

Serializes to the canonical MVP instance from [dag-schema.md](./dag-schema.md) (implement → lint → gate; on-success dangles, on-failure feedback to implement).

## Key decisions

1. **Self-describing NodeRunner is the entry.** The runner carries its metadata (kind/version/cls/outputPorts/inputFields/paramSchema/join?) + run. `RegistryEntry` from the schema is the TS interface the runner implements, not a runtime wrapper. One author-facing object.
2. **`resolve(kind, version): NodeRunner`, throws on miss.** Exact-match; a miss is always a load-time error (invariant #2). Runtime-neutral — the engine (ticket 04) can wrap the throw in Effect if it chooses.
3. **`kind`+`version` keying.** `register` rejects duplicate `kind`+`version` pairs; multiple versions coexist ("versioning + migrates"). Migration is the engine's job, not the registry's.
4. **One static `createRegistry({...})` declaration.** Feeds both the runtime registry (`resolve`) and the builder's compile-time kind→runner type map (`flow(reg)` reads `typeof reg.kinds`). No drift. `register` covers runtime plugins (dynamically typed).
5. **Generic `.node(kind, params)` → cls-typed handle.** One method; `kind` is a literal key (autocomplete + type-checked), `params` typed from `paramSchema`'s output type. Interface doesn't grow with kinds.
6. **Typed cls-handles for edges.** `ActionHandle.to()`, `BranchHandle.on(port).to()/.dangle()`, `MergeHandle.to()`. The handle is the edge seam — ports compile-time checked; wiring reads in data-flow order.
7. **Build-time single-input enforcement.** A second forward edge into an action/branch handle throws at the call site. Feedback edges don't count (re-entries). Validates the canonical DAG's own invariants, not a new model.
8. **Three `defineXRunner` helpers, fixed.** Pin `cls` (can't lie), infer param types. Interface grows with classes (3, fixed), not kinds.
9. **Auto-defaults + validated `serialize()`.** `name` defaults to kind, `id` auto-UUID, `meta` auto-generated (overridable to round-trip). `serialize(): Flow` is guaranteed-valid.

## Deferred

- ~~**`NodeRunner.run` signature** — typed by ticket 04 (engine). The `defineXRunner` helpers take `run` as a placeholder slot.~~ **Resolved by 04 + 08:** `run` is `NodeRunFn<P>` (action: `(input, ctx: RunCtx<P>) => NodeRunResult`; branch: same; merge: `(inputs[], ctx: RunCtx<P>)`); `P` is the `paramSchema` output type, inferred by the helpers and threaded onto `ctx.params`. See `docs/engine.md`.
- **Compile-time binding field-name checking** (identity wiring, invariant #11) — runtime-validated at serialize for now; compile-time checking is a later refinement.
- **Registry as Effect service vs plain object** — the `Registry` interface is runtime-neutral; ticket 04 decides the engine's runtime model and whether to wrap it.

## Unblocks

- #4 (engine) — `resolve(kind, version)` gives the engine the runner to dispatch to; the `NodeRunner` metadata (cls, outputPorts, inputFields, join) backs the engine's load-time invariant checks.
- #5 (MVP slice) — the builder serializes the MVP flow the slice runs.
