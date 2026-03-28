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

Flows are `.ts` modules that export a graph definition.

The topology should read like data:

- `nodes`
- `edges`
- declarative routing

Node-local behavior can still be code.

Typical authoring shape:

```ts
import { defineFlow, acp, action, compute, checkpoint } from "acpx/flows";

export default defineFlow({
  name: "example",
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

Default rule:

- use compatibility JSON unless the workflow truly needs strict parsing

Do not turn output parsing into a large framework.

## Simplicity rules

- Keep the node set small
- Keep `acpx` generic
- Prefer clear runtime boundaries over specialized built-ins
- Add fewer conventions, not more
- Use one main session by default
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
- small node set
- runtime-owned liveness and persistence
- optional runtime actions for deterministic work
- per-node `cwd`
- one main ACP session by default

That is the shape flows should continue to follow.
