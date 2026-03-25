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
- one main conversation by default
- explicit isolated conversations where blind judgment is required

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
- an isolated ACP session

### 4. One main session by default, explicit extra sessions when needed

Each flow run should get one implicit main ACP conversation.

Most `acp` nodes should just use that main conversation.

If a step needs isolation or a separate line of work, the flow should ask for
that explicitly instead of relying on hidden session policy defaults.

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
- `packages/flows`
- `packages/core` if extracting the shared runtime into its own workspace
  package proves useful

Recommended responsibilities:

### `packages/acpx`

Published package name: `acpx`

Responsibilities:

- CLI binary
- public umbrella exports
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

The public API should start with a single umbrella:

- `acpx`
- `acpx/flows`

`acpx/core` can exist later if the lower-level runtime surface proves worth
stabilizing. It should not be forced into the first public compatibility
contract unless there is a clear need.

`packages/acpx` should re-export the public surfaces from the workspace
libraries rather than forcing users to import package-internal names.

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

The recommended repository layout is:

- library/runtime code under the package workspace
- user-authored and example flows under a repo-level `workflows/` directory

Example:

- `workflows/pr-triage.flow.ts`
- `workflows/review.flow.ts`

That keeps the workflow library separate from the workflows it executes and
gives the CLI one obvious path shape for local development.

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

The public model should be simple.

### Default behavior

Each flow run gets one implicit main ACP session.

Every `acp` node uses that main session by default.

That should be the common case for:

- exploratory analysis
- implementation
- follow-up fixes
- review/fix loops

### Isolated steps

If a step must be independent, the flow should opt into an isolated session
explicitly.

Use isolation for:

- blind judgment
- independent critics
- adversarial review
- any step that must not inherit earlier conversation state

This should be expressed as a simple flow-level option such as "run this step in
its own session", not by forcing every author to learn internal session-policy
keywords.

### Extra long-lived sessions

Most flows should not need to manually name sessions.

If a workflow truly needs multiple persistent conversations, it may declare
additional session handles explicitly. That is an advanced case, not the
default.

The runtime should own the mapping from those logical handles to underlying
`acpxRecordId` and ACP session identifiers for the run.

### Internal runtime model

Internally, the runtime will still need semantics equivalent to:

- reuse the main session
- create an isolated one-off session
- continue a previously created non-main session

Those are implementation concerns. They do not need to be the first public API
surface.

### Validation rules

The flow validator should reject:

- isolated or blind steps that try to reuse the main conversation
- concurrent branches that would interleave prompts into the same session
- explicit extra-session references that cannot be resolved for the run

## Context visibility

Each `acp` node gets a `read(...)` projection.

The runtime state may be broad, but the node sees only the projected view.

Example:

- node A sees raw issue and diff
- node B sees extracted facts but not earlier verdicts
- node C sees the verdict and executes a side effect

This is the main mechanism for reducing anchoring and confirmation bias.

It is not sufficient by itself for blind review. If a node must not inherit
earlier worker memory, it must use an isolated session as well.

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

The first implementation should support one result path:

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

Recommended initial layout:

- `~/.acpx/flows/runs/<runId>/run.json`
- `~/.acpx/flows/runs/<runId>/events.ndjson`
- `~/.acpx/flows/runs/<runId>/lock`
- `~/.acpx/flows/runs/<runId>/artifacts/...`

If later experience shows that fast global lookup is necessary, an index file
can be added then. It should not be required up front.

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
- `sessionBindings` mapping runtime-owned handles to persisted session ids
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

The canonical local invocation should look like:

- `acpx flow run workflows/pr-triage.flow.ts`

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

- default main-session step -> `ensureSession` then `sendSession`
- isolated one-off step -> `runOnce`
- explicit extra persistent session -> `ensureSession` then `sendSession`
- cancel/control -> existing session control functions

This keeps ACP execution in one place.

## Testing strategy

Build on the existing mock ACP agent and integration test style.

### Library tests

Add tests for:

- graph validation
- default main-session reuse
- isolated-step semantics
- explicit extra-session validation
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
- add `packages/flows`
- extract a shared runtime package only if it materially clarifies the split
- move existing code into the monorepo with minimal logic changes
- keep published `acpx` CLI behavior unchanged

### 2. Core library surface

- define the internal runtime surface that `acpx/flows` depends on
- stop treating all runtime code as CLI-internal implementation detail
- expose stable session and prompt APIs for flow execution inside the repo
- publish `acpx/core` only if that lower-level surface proves worth freezing

### 3. Flow graph and validator

- implement `defineFlow`
- implement node and edge types
- normalize to internal graph IR
- validate graph structure and session-isolation constraints

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
- Each flow run has one implicit main session by default.
- Extra sessions must be explicit.
- Example and user-authored flows should live under a repo-level `workflows/`
  directory rather than inside the library package tree.
- Conversations remain in the existing session store.
- Workflow state uses file-based persistence first.
- The flow runtime uses the current `acpx` runtime directly, not CLI subprocesses.
- A custom MCP result server is optional later, not required up front.

## Success criteria

This work is successful when all of the following are true:

- a flow can be authored as one `.ts` file
- `acpx flow run file.ts` executes it end to end
- the default main-session model is simple and reliable
- isolated steps do not inherit hidden worker memory accidentally
- arbitrary routing rules can be expressed cleanly
- fork/join works across multiple ACP workers
- run state survives process exit and resume
- worker conversations are still stored exactly once through the existing session model
