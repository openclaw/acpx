---
title: acpx Flows Architecture
description: Execution model, runtime boundary, and design principles for acpx flows.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-03-25
---

# acpx Flows Architecture

## Why this document exists

`acpx` flows add a small workflow layer on top of the existing ACP runtime.

That workflow layer exists to make multi-step ACP work practical without
turning one long agent conversation into the workflow engine.

This document describes the shape that `acpx` flows use:

- flows are TypeScript modules
- the runtime owns graph execution and liveness
- ACP steps are used for model-shaped work
- deterministic mechanics can run as runtime actions
- conversations stay in the existing `~/.acpx/sessions/*.json` store

## Core position

`acpx` should stay a small ACP client with composable primitives.

Flows fit that goal when they keep the boundary clear:

- the runtime owns execution, persistence, routing, and liveness
- ACP workers own reasoning, judgment, summarization, and code changes

The worker is not the workflow engine.

## Goals

- Make multi-step ACP workflows first-class in `acpx`
- Keep flow definitions readable and inspectable
- Keep branching deterministic outside the worker
- Reuse the existing session runtime and session store
- Support both pure ACP workflows and hybrid workflows when deterministic steps
  are better supervised by the runtime

## Non-goals

- No ACP protocol redesign
- No large custom DSL
- No built-in GitHub or PR-specific workflow language in core
- No duplicate transcript store for flow conversations
- No visual builder

## Flow model

Flows are normal `.ts` modules that import helpers from `acpx/flows` and
export a graph definition through `defineFlow(...)`.

They are not a special DSL file type and they are not meant to be importless
"magic" files.

`defineFlow(...)` is the supported authoring entrypoint. Source-tree examples
and external flow files should use that same public import surface instead of
reaching into `src/flows`.

How the CLI resolves that import at runtime is loader plumbing, not the
author-facing design contract.

The topology should read like data:

- `name`
- `startAt`
- `nodes`
- `edges`
- declarative routing

Node-local behavior can still be code.

That split is deliberate:

- keep the top-level workflow shape structured and inspectable
- allow code inside nodes for prompts, deterministic actions, and local
  transforms
- do not turn the whole flow into an arbitrary program that owns traversal,
  retries, or liveness itself

Typical authoring shape:

```ts
import { defineFlow, acp, action, compute, checkpoint } from "acpx/flows";

export default defineFlow({
  name: "example",
  startAt: "analyze",
  nodes: {
    analyze: acp({ ... }),
    route: compute({ ... }),
    run_check: action({ ... }),
    wait: checkpoint(),
  },
  edges: [
    { from: "analyze", to: "route" },
    {
      from: "route",
      switch: {
        on: "$.next",
        cases: {
          run_check: "run_check",
          wait: "wait",
        },
      },
    },
  ],
});
```

## Authoring API direction

The current design should stay structured.

That means:

- keep flow definitions as exported graph objects
- keep node-local callbacks for the parts that actually benefit from code
- keep orchestration responsibilities in the runtime

The flow author should describe the workflow.

The runtime should still own:

- step execution
- routing
- retries
- persistence
- timeouts
- heartbeats

`acpx` should not move toward a fully functional whole-flow API where user code
manually decides every next step or reimplements the scheduler.

If the authoring API becomes more ergonomic, prefer small helpers that preserve
the visible graph shape, for example:

- clearer output-contract helpers
- clearer routing helpers
- better names for the existing structured fields

Do not trade away inspectability just to make the surface feel clever.

## Schema validation direction

The next implementation step should add runtime schema validation for the
existing flow definition model.

Use `zod` for that validation layer.

This is a validation change, not an authoring-model rewrite.

Keep the current public field names:

- `name`
- `startAt`
- `nodes`
- `edges`

Do not bundle API renames such as `start`, `steps`, or other new top-level
names into the first `zod` pass.

The core model should stay plain data:

- a flow definition is still a plain object after `defineFlow(...)` brands it internally
- each node is a plain tagged object
- edges are plain data connecting node ids

Do not replace that with class instances or a builder-only runtime model.

### What the schemas should cover

The schema layer should describe the current flow graph directly:

- one flow-definition schema
- one discriminated union for node definitions keyed by `nodeType`
- one edge schema that covers both direct edges and `switch` edges
- shared validation for common node fields such as timeouts and heartbeat

Function-valued fields are still allowed where the current API allows them, for
example:

- `prompt`
- `parse`
- `run`
- `exec`
- dynamic `cwd`

In `zod`, those should be validated as functions, not serialized or re-shaped
into something more magical.

### Validation layers

There are two different kinds of validation and the implementation should keep
them conceptually separate:

1. shape validation
2. graph semantics validation

Shape validation answers questions like:

- is `name` a non-empty string
- is `startAt` a string
- is `nodes` a record of valid node definitions
- is `edges` an array of valid edge objects
- does a given node have the required callbacks for its `nodeType`

Graph semantics validation answers questions like:

- does `startAt` reference an existing node
- does every edge reference real node ids
- does each node have at most one outgoing edge
- does every `switch` case point to a real target

It is fine for the first implementation to keep some semantic checks in the
existing graph validator as long as the runtime boundary stays clear.

### Where validation should run

`defineFlow(...)` should validate the immediate definition shape before
returning it.

The object returned by `defineFlow(...)` should also carry the internal marker
the loader uses to distinguish an intentional flow definition from an arbitrary
exported object.

Full graph validation must still run after module evaluation in the loader or
runtime.

That still supports staged module assembly patterns such as:

- create `nodes` or `edges`
- call `defineFlow(...)`
- finish populating the graph before export evaluation completes
- export that defined flow object

The authoring contract should stay strict:

- user code imports helpers from `acpx/flows`
- user code exports `defineFlow(...)` or a variable returned by `defineFlow(...)`
- `defineFlow(...)` validates the current shape and marks the definition as intentional
- the loader or runtime validates the completed graph
- the runtime executes the validated graph

The loader should reject plain exported objects that were not created through
`defineFlow(...)`.

Node helpers such as `acp(...)`, `action(...)`, `compute(...)`, and
`checkpoint(...)` may also validate node-local shape, but they should still
return plain node-definition objects.

### What should not change in the first PR

The first `zod` implementation should not also try to solve unrelated API
questions.

Keep all of these unchanged:

- the `defineFlow({ name, startAt, nodes, edges })` surface
- string-keyed node ids
- explicit `edges`
- the existing node kinds
- the current flow snapshot naming used in persisted run bundles

Do not bundle these into the same PR:

- renaming `nodes` to `steps`
- renaming `startAt` to `start`
- moving routing into a new top-level API
- changing how the loader resolves `acpx/flows`
- redesigning JSON output parsing at the same time

### Follow-on work after definition schemas

Once definition validation lands, later work may add optional validation for
node outputs.

That is a separate step.

For example, an `acp` node may later support a dedicated output schema, but
that should come after the base flow-definition schemas are in place.

## Step kinds

Keep the primitive set small:

- `acp`
- `action`
- `compute`
- `checkpoint`

### `acp`

Use `acp` for model-shaped work:

- extract intent
- judge solution shape
- classify bug vs feature
- decide whether refactor is needed
- summarize findings
- write human-facing output
- make code changes when the work is genuinely model-driven

### `action`

Use `action` for deterministic work supervised by the runtime:

- prepare an isolated workspace
- run shell commands
- call `gh api`
- run tests
- run local `codex review`
  Local `codex review` can legitimately take up to 30 minutes. Do not treat it
  as stuck before that timeout unless some stronger signal shows it is wedged.
- post a comment
- close a PR

`shell(...)` is just a convenience form of `action(...)`.

### `compute`

Use `compute` for pure local transforms:

- normalize earlier outputs
- derive the next route
- reduce multiple signals into one decision key

### `checkpoint`

Use `checkpoint` when the flow must pause for something outside the runtime:

- a human decision
- an external event
- a later resume

## Routing

Routing must stay deterministic outside the worker.

Workers produce outputs.

The runtime decides:

- the next node
- whether to retry
- whether to wait
- whether to fork or join

Do not route on prose alone.

Prefer:

- structured ACP outputs
- declarative `switch` edges
- `compute` nodes for custom routing logic

## Node outcomes

Timeouts should be treated as routable node outcomes, not only as fatal run
errors.

The clean model is small:

- `ok`
- `timed_out`
- `failed`
- `cancelled`

That outcome is control-plane state, separate from the business output of the
step.

In practice, that means a flow should be able to say things like:

- `review_loop` timed out -> escalate to human
- `collect_review_state` failed -> escalate to human
- `fix_ci_failures` cancelled -> pause or escalate

This should not become a large event system.

The runtime should persist:

- step output
- step outcome
- error text when present
- timestamps and duration

Then the graph can route on those outcomes when needed.

For example, a switch edge may branch on:

- `$.next` for normal business output
- `$result.outcome` for control-plane routing
- `$output.route` when a flow wants the output path to be explicit

If a flow does not define a route for a non-`ok` outcome, failing the run is
still the right default.

## Events and history

Flow event logs are for observability, not for driving the graph directly.

For example, the runtime may record events such as:

- node started
- node heartbeat
- node finished
- run failed

That append-only history belongs in the run log.

Routing should still use a small structured result model rather than treating
the event stream itself as the workflow API.

## Session model

Each flow run gets one main ACP session by default.

Most `acp` nodes should use that main conversation.

If a flow truly needs a separate or isolated conversation, it should ask for it
explicitly. The runtime tracks those bindings internally.

The flow author should usually think in terms of:

- the main reasoning session
- optional isolated side sessions

not low-level persistence details.

Persistent session recovery rule:

- a persistent ACP session is shared reasoning state, not just a transport handle
- if the live ACP connection dies, the runtime should reconnect and try
  `session/load` for the same underlying agent session
- the runtime must not silently replace a dead persistent session with a fresh
  one, because that would discard the worker's accumulated context and change
  the meaning of later steps
- if reconnect-and-load fails, fail the node or flow clearly instead of creating
  a fresh persistent session behind the author's back

Implementation guidance:

- this should be a small session-runtime refactor, not a flow-level workaround
- keep one helper responsible for "is this persistent session still usable"
- that helper should:
  - fail fast if the runtime already knows the current transport is dead
  - reconnect the ACP client
  - try `session/load` for the same underlying session
  - throw a clear error if that load fails
- both the direct persistent prompt path and the queue-owner path should use the
  same helper instead of duplicating liveness logic

## Working directories

`cwd` already exists in `acpx` session handling.

Flows extend that by allowing each node to choose its own working directory,
including dynamically from earlier outputs.

That means a flow can:

1. create an isolated temp clone or worktree in an `action` step
2. run later `acp` nodes inside that directory
3. keep the main repo checkout untouched

Session bindings include `cwd`, so different workspaces do not accidentally
share one persisted ACP session.

## Runtime boundary

The important boundary is:

- ACP for reasoning
- runtime for supervision

## Flow permissions

Powerful flows should be able to declare permission requirements explicitly.

That requirement should be enforced by the runner before the flow starts, not
discovered mid-run after an ACP step hits write denials.

The intended model is:

- the flow declares the minimum permission mode it needs
- the flow may require an explicit operator grant
- the runner resolves both the effective mode and its source
- the runner fails fast when the flow requires an explicit grant and the
  operator did not supply one
- the runtime must propagate the granted mode faithfully through queue-owner and
  session-reuse paths

This is specified in more detail in
[`docs/2026-03-28-acpx-flow-permission-requirements.md`](2026-03-28-acpx-flow-permission-requirements.md).

That boundary matters most when a workflow would otherwise ask the model to do
open-ended orchestration inside one prompt turn.

Examples of mechanics that are usually better owned by the runtime:

- `git fetch`
- `gh api` calls
- local `codex review`
- targeted test execution
- posting comments

This does not make ACP less important.

It keeps ACP focused on the part it is good at while giving the flow runtime
direct ownership of timeouts, heartbeats, and side-effect execution.

## Persistence

Conversation state stays in the existing `acpx` session store:

- `~/.acpx/sessions/*.json`

Flow state lives separately under:

- `~/.acpx/flows/runs/`

The flow store keeps orchestration state such as:

- run status
- current node
- outputs
- latest node results and outcomes
- step history
- session bindings
- errors
- live liveness state

The flow layer should reference session records, not duplicate full ACP
transcripts.

The persisted run snapshot should keep the same top-level flow fields so replay
and inspection continue to describe the same graph the author wrote:

- `name`
- `startAt`
- `nodes`
- `edges`

Trace and replay storage are specified separately in:

- [`2026-03-26-acpx-flow-trace-replay.md`](2026-03-26-acpx-flow-trace-replay.md)

That document defines the run-bundle layout, trace event model, session replay
linkage, and artifact rules needed for step-by-step replay or external
visualization.

## Liveness

Long-running steps need explicit liveness.

Flows should persist live state while a step is active, not only after it
finishes.

Important live fields include:

- `status`
- `currentNode`
- `currentNodeStartedAt`
- `lastHeartbeatAt`
- `statusDetail`
- `error`

`acp` and `action` steps should support timeouts, heartbeats, and cancellation.

That keeps a healthy run distinguishable from a hung run.

## JSON output handling

Flows often need structured model output.

`acpx` supports a forgiving default because models sometimes wrap JSON with
extra text.

The intended parsing layers are:

- `extractJsonObject(...)` for compatibility
- `parseStrictJsonObject(...)` when the contract must be exact
- `parseJsonObject(..., { mode })` when a flow needs explicit control

These are output-parsing helpers, not the flow format itself.

They help one node turn assistant text into structured data after the runtime
has already executed that step.

The first `zod` implementation should not try to replace these helpers.

Definition validation and output validation are related, but they are not the
same thing and should not be collapsed into one change.

Default rule:

- use compatibility JSON unless the workflow truly needs strict parsing

Do not turn output parsing into a large framework.

## Simplicity rules

- Keep the node set small
- Keep `acpx` generic
- Prefer clear runtime boundaries over specialized built-ins
- Add fewer conventions, not more
- Keep the graph visible at the top level
- Use one main session by default
- Keep orchestration out of user callbacks when the runtime can own it clearly
- Keep workload-specific logic in user flow files or example files, not in
  `acpx` core product behavior
- Use compatibility JSON by default and strict JSON only when it pays for itself

## PR triage example shape

A maintainability-first PR triage workflow can fit this model cleanly:

1. `action`: prepare isolated workspace
2. `acp`: extract intent
3. `acp`: judge implementation or solution
4. `acp`: classify bug vs feature
5. `action`: run validation mechanics
6. `acp`: judge refactor need
7. `action`: collect review mechanics
8. `acp`: decide whether blocking findings remain
9. `action`: collect CI mechanics
10. `acp`: decide whether to continue, close, or escalate
11. `action`: post the final comment or take the final GitHub action

This keeps the reasoning in ACP while keeping the mechanics observable and
bounded.

## CLI shape

The current user-facing entrypoint is:

```bash
acpx flow run <file> [--input-json <json> | --input-file <path>]
```

Run state is persisted under `~/.acpx/flows/runs/`.

The source tree includes example flows under `examples/flows/`, including:

- small focused examples such as `echo`, `branch`, `shell`, `workdir`, and
  `two-turn`
- a larger PR-triage example under `examples/flows/pr-triage/`

## What belongs in core

Core flow support in `acpx` should stay generic:

- graph execution
- ACP step execution
- runtime actions
- run persistence
- liveness
- session bindings
- parsing helpers

What should stay outside core:

- PR-triage policy
- repository-specific prompts
- workload-specific route logic
- GitHub-specific business rules beyond generic command execution

## Current direction

The implemented direction in this branch is:

- TypeScript flow modules
- normal authoring imports from `acpx/flows`
- structured top-level flow definitions
- small node set
- runtime-owned liveness and persistence
- optional runtime actions for deterministic work
- per-node `cwd`
- one main ACP session by default

That is the shape flows should continue to follow.

Future ergonomics work should refine that shape, not replace it with a
fully-functional workflow API.
