---
title: acpx Flows Implementation Plan
description: Monorepo plan for adding a general workflow library and CLI to acpx for orchestrating ACP workers with simple primitives.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-03-25
---

# acpx Flows Implementation Plan

## Why this document exists

`acpx` already has the hard parts of ACP execution:

- ACP transport over stdio
- agent spawning and lifecycle handling
- persistent session storage
- queue ownership and prompt serialization
- machine-readable output
- MCP server attachment on session setup

What it does not have yet is a general workflow layer that can orchestrate ACP
workers step by step with:

- explicit graphs
- programmable branching
- selective context visibility
- persistent workflow state outside the worker
- reusable sessions where continuity helps
- fresh sessions where blind judgment is required

This document defines that plan.

It assumes `acpx` will move to a monorepo, but all code will remain in the same
repository and under the same product family.

## Core position

`acpx` should become a swiss army knife for ACP, but it should do that through
small, composable primitives rather than one undifferentiated blob.

The correct split is:

- one repo
- one product family
- multiple packages
- one clear runtime boundary

The worker is not the workflow engine.

The workflow runtime owns:

- graph execution
- branching
- retries
- wait states
- checkpointing
- selective context visibility
- bindings to persistent `acpx` sessions

The ACP worker only executes one step at a time.

## Goals

- Add a general workflow library for ACP workers, not a PR-specific automation tool.
- Keep workflow definitions readable as TypeScript modules with object-shaped graphs.
- Support arbitrary branching and forks/joins with deterministic routing outside the worker.
- Reuse existing `acpx` session persistence for conversations instead of duplicating transcripts.
- Keep the first implementation simple enough to land incrementally in the current codebase.
- Preserve a coherent CLI surface under the `acpx` name.

## Non-goals

- No ACP protocol redesign.
- No requirement to introduce a distributed scheduler.
- No visual builder.
- No giant custom DSL.
- No requirement that every result must come back through a custom MCP tool on day one.
- No transcript duplication into a second workflow database.

## Design principles

### 1. Graph topology should read like data

The default authoring format should be:

- plain object for graph topology
- code only for node-local logic

This keeps flows inspectable, serializable, and renderable.

### 2. Routing must be deterministic outside the worker

Workers produce outputs.

The runtime chooses:

- next node
- retry vs fail
- fan-out
- join behavior
- wait states

Never route on prose alone.

### 3. Context visibility is a first-class primitive

Each node should receive only what its `read(...)` projection returns.

If a step should not know earlier conclusions, that must be enforced by:

- a narrow `read(...)`
- a fresh ACP session

### 4. Session continuity is a policy, not a side effect

Each ACP node should explicitly choose:

- `fresh`
- `sticky(key)`
- `inherit`

### 5. Conversations stay in the existing session store

`acpx` already stores persistent ACP conversations in `~/.acpx/sessions/*.json`.

The workflow layer should store:

- run state
- node state
- branch state
- session references
- artifacts

It should not store duplicate full transcripts.

### 6. Start with the existing runtime, not the CLI

The flow engine should call the current runtime functions directly:

- `runOnce`
- `createSession`
- `ensureSession`
- `sendSession`
- cancel and control operations

It should not shell out to `acpx` as a subprocess.

## Target monorepo shape

The repository should become a workspace monorepo with these packages:

- `packages/acpx`
- `packages/core`
- `packages/flows`

Recommended responsibilities:

### `packages/acpx`

Published package name: `acpx`

Responsibilities:

- CLI binary
- public umbrella exports
- `acpx/core` subpath export
- `acpx/flows` subpath export

This package is the user-facing umbrella.

### `packages/core`

Internal workspace package for the reusable ACP runtime.

Responsibilities:

- ACP transport
- agent spawning
- session lifecycle
- session persistence
- queue runtime
- output formatters
- config loading
- prompt content helpers
- agent registry and capability helpers

This is where the current `src/client.ts`, `src/session-runtime.ts`,
`src/session-persistence/**`, `src/output.ts`, and related files should move
over time.

### `packages/flows`

Internal workspace package for the workflow library.

Responsibilities:

- flow graph types
- graph validation
- flow loader
- run store
- graph executor
- branching and fork/join runtime
- checkpoint/resume
- step result extraction and validation
- optional flow-specific helpers

### Why this shape

This gives `acpx` the swiss-army-knife product shape while keeping the code
modular:

- one repo
- one public brand
- separate runtime layers

## Public package surface

The public API should present a single umbrella:

- `acpx`
- `acpx/core`
- `acpx/flows`

That means `packages/acpx` should re-export the public surfaces from the
workspace libraries rather than forcing users to import package-internal names.

## Flow authoring model

Flows are `.ts` files.

Each file exports one flow definition.

The canonical authoring style is:

```ts
import { defineFlow, acp, compute, action, checkpoint } from "acpx/flows";

export default defineFlow({
  name: "triage",
  input: InputSchema,
  nodes: {
    facts: acp({ ... }),
    judge: acp({ ... }),
    route: compute({ ... }),
    external: checkpoint(),
    continue_work: action({ ... }),
  },
  edges: [
    { from: "facts", to: "judge" },
    { from: "judge", to: "route" },
    {
      from: "route",
      switch: {
        on: "$.next",
        cases: {
          external: "external",
          continue: "continue_work",
        },
      },
    },
  ],
});
```

### Why object-shaped graphs

This format is better than a fluent chain for:

- readability
- validation
- static analysis
- visualization
- IR generation
- tooling

### Canonical execution model

Authoring format:

- TypeScript module

Execution format:

- normalized graph IR

The engine should normalize every flow into one internal representation before
execution.

## Core primitives

Keep the primitive set small.

### `acp(...)`

Run one ACP worker step.

Use this for any step executed by Codex, OpenClaw, Claude, Pi, or another
ACP-compatible worker.

### `compute(...)`

Pure local transformation.

Used for:

- result normalization
- reducers
- route preparation
- branch aggregation

### `action(...)`

Explicit local side effect.

Used for:

- GitHub writes
- file writes
- notifications
- external API calls

### `checkpoint(...)`

Pause and wait for an external actor or event.

This is the correct primitive, not `human(...)`.

The external actor may be:

- a person
- another worker
- a CI system
- a webhook
- an operator action

### Edge primitives

Support:

- linear edge
- `switch`
- `fork`
- `join`

That is enough for most workflows.

## Branching rules

Branching must support two modes.

### 1. Declarative branching

For common structured cases:

```ts
{
  from: "judge",
  switch: {
    on: "$.decision",
    cases: {
      yes: "yes_path",
      no: "no_path",
    },
  },
}
```

### 2. Arbitrary code-based branching

For custom logic, use a local `compute` router node:

```ts
route: compute({
  run: ({ outputs }) => {
    const answer = String(outputs.judge.answer).trim().toUpperCase();

    if (answer === "Y") return { next: "yes_path" };
    if (answer === "N") return { next: "no_path" };
    return { next: "fallback_path" };
  },
});
```

Then branch declaratively on `route.next`.

This keeps the graph readable while allowing arbitrary branching rules.

## Session model

Session policy is first-class on each `acp` node.

Support exactly these policies:

- `fresh`
- `sticky(key)`
- `inherit`

### `fresh`

Use a new ACP session for this node.

Use for:

- blind judgment
- independent critics
- isolated analysis

### `sticky(key)`

Reuse a persistent `acpx` session bound to the run and key.

Use for:

- implementation loops
- long-running review/fix cycles
- branch-local continuity

### `inherit`

Reuse the active session from an upstream sticky path.

Use only when continuity is intentional.

### Validation rules

The flow validator should reject:

- `inherit` when no inherited session can exist
- two concurrent branches writing to the same sticky key
- steps marked as blind/isolated while using `inherit`

## Context visibility

Each `acp` node gets a `read(...)` projection.

The runtime state may be broad, but the node sees only the projected view.

Example:

- node A sees raw issue and diff
- node B sees extracted facts but not earlier verdicts
- node C sees the verdict and executes a side effect

This is the main mechanism for reducing anchoring and confirmation bias.

## Prompt model

The workflow layer should build on the existing ACP prompt content model.

`acpx` already has prompt helpers and validation for:

- text blocks
- image blocks
- resource links
- embedded resources

That should remain the base prompt type for flow steps rather than inventing a
second prompt representation.

## Result capture

Do not make a custom MCP result tool mandatory for the first implementation.

The current runtime forwards MCP server config to `session/new` and
`session/load`, but it does not yet host a built-in MCP server runtime for flow
steps. The first implementation should respect that.

### Initial result path

Each `acp` node should specify:

- a prompt
- an output schema
- a result extraction policy

Default policy:

- ask the worker to return a final structured JSON object
- capture the ACP output stream
- extract the final assistant payload
- parse JSON
- validate it

### Future extension

Later, a flow-specific MCP tool can be added behind the same abstraction for
more reliable structured returns. That should be an enhancement, not a
prerequisite.

## Schema model

The flow engine should not hard-require one validation library.

Accept any schema-like object that supports one of:

- `parse(value)`
- `safeParse(value)`

This keeps the core flexible and avoids baking a new large dependency into the
runtime contract.

## Persistence model

Do not use SQLite first.

The current repo already uses file-based JSON and NDJSON persistence for
sessions. The workflow layer should match that style.

### Conversation storage

Persistent conversations remain in:

- `~/.acpx/sessions/*.json`
- `~/.acpx/sessions/*.stream.ndjson`

The workflow engine should reference those sessions by `acpxRecordId`.

### Workflow storage

Store workflow state under:

- `~/.acpx/flows/`

Recommended layout:

- `~/.acpx/flows/index.json`
- `~/.acpx/flows/runs/<runId>.json`
- `~/.acpx/flows/runs/<runId>.events.ndjson`
- `~/.acpx/flows/runs/<runId>.lock`
- `~/.acpx/flows/artifacts/<runId>/...`

### What a run record should store

- `runId`
- `flowName`
- `flowPath`
- `flowVersion`
- `status`
- `cwd`
- `createdAt`
- `updatedAt`
- `input`
- `nodeStates`
- `outputs`
- `activeBranches`
- `sessionBindings`
- `waitingOn`
- `artifacts`

### What it should not store

- duplicate conversation transcripts
- duplicate token usage copied out of session records

## Run model

Each run is a checkpointed state machine.

The runtime should persist after every node transition:

- node started
- node completed
- branch chosen
- checkpoint entered
- run resumed
- run failed
- run completed

This is required for:

- crash recovery
- inspectability
- replay
- long-lived checkpoints

## CLI surface

Add a new top-level command family:

- `acpx flow run <file>`
- `acpx flow resume <run-id>`
- `acpx flow show <run-id>`
- `acpx flow graph <file>`
- `acpx flow validate <file>`

### Important compatibility note

Today, unknown first tokens are treated as agent names. Adding `flow` is
therefore a real top-level surface change and must be treated as a deliberate
reserved verb.

### Loader model

Flow files should be authored as `.ts`.

The CLI should load them directly.

That means the monorepo needs a dedicated runtime loader path for TypeScript
flow modules instead of pretending the current CLI-only build is enough.

## Agent selection inside flows

Do not rely on CLI-level `--agent` overrides for the first implementation.

Flows may contain multiple `acp` nodes with different profiles, so one global
raw command override is ambiguous.

Instead, flow nodes should name an agent profile resolved through the existing
config and registry layer.

Example:

- `profile: "codex"`
- `profile: "openclaw"`
- `profile: "claude"`

Later, per-node raw command overrides can be added if they are actually needed.

## Use of existing runtime

The flow engine should build on the current runtime instead of duplicating it.

Recommended mapping:

- `fresh` node -> `runOnce`
- `sticky(key)` initial bind -> `ensureSession`
- sticky turn execution -> `sendSession`
- cancel/control -> existing session control functions

This keeps ACP execution in one place.

## Testing strategy

Build on the existing mock ACP agent and integration test style.

### Library tests

Add tests for:

- graph validation
- `fresh` vs `sticky` semantics
- `inherit` validation
- declarative branching
- arbitrary code-based routing via `compute`
- fork/join execution
- checkpoint persistence and resume
- run store locking
- result parsing failures

### CLI tests

Add integration tests for:

- `acpx flow run ...`
- `acpx flow validate ...`
- `acpx flow graph ...`
- `acpx flow resume ...`
- reserved `flow` verb behavior

### Mock worker coverage

The existing mock worker should remain the base for flow tests so the workflow
layer is validated against ACP behavior, not ad-hoc stubs.

## Implementation phases

### 1. Monorepo cutover

- create workspace structure
- add `packages/acpx`
- add `packages/core`
- add `packages/flows`
- move existing code into `packages/core` and `packages/acpx` with minimal logic changes
- keep published `acpx` CLI behavior unchanged

### 2. Core library surface

- define public `acpx/core` exports
- stop treating all runtime code as CLI-internal implementation detail
- expose stable session and prompt APIs for flow execution

### 3. Flow graph and validator

- implement `defineFlow`
- implement node and edge types
- normalize to internal graph IR
- validate graph structure and session-policy constraints

### 4. File-based run store

- add `~/.acpx/flows/` store
- implement run record persistence
- implement event log
- implement run locks
- implement checkpoint and resume

### 5. Flow executor

- execute `acp`, `compute`, `action`, `checkpoint`
- wire `acp` nodes into existing session runtime
- implement branch, fork, join, and failure semantics

### 6. Result extraction

- add structured final-result capture
- add validator bridge for schema parsing
- add normalized failure handling for malformed worker results

### 7. CLI

- add `flow` command family
- add TypeScript flow loader
- add run/validate/graph/show/resume commands

### 8. Hardening

- improve inspectability
- add graph rendering
- add richer artifacts
- evaluate whether a custom MCP return tool is worth adding

## Resolved decisions

- The repo becomes a monorepo.
- The public product family remains `acpx`.
- The first-class workflow API lives under `acpx/flows`.
- Graph topology is object-shaped, not fluent-first.
- Branching is fully programmable.
- `checkpoint` is the right primitive, not `human`.
- Conversations remain in the existing session store.
- Workflow state uses file-based persistence first.
- The flow runtime uses the current `acpx` runtime directly, not CLI subprocesses.
- A custom MCP result server is optional later, not required up front.

## Success criteria

This work is successful when all of the following are true:

- a flow can be authored as one `.ts` file
- `acpx flow run file.ts` executes it end to end
- fresh and sticky session behavior are explicit and reliable
- blind steps do not inherit hidden worker memory accidentally
- arbitrary routing rules can be expressed cleanly
- fork/join works across multiple ACP workers
- run state survives process exit and resume
- worker conversations are still stored exactly once through the existing session model
