---
title: acpx Flows Production Architecture
description: Production-ready execution model for acpx workflows, with runtime-owned control, native actions, ACP reasoning steps, and strong liveness guarantees.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-03-25
---

# acpx Flows Production Architecture

## Why this document exists

The first experimental `acpx` flow runner proved that multi-step ACP workflows
are viable, but it also exposed the wrong execution boundary.

The clearest example was PR triage:

- the flow itself was structurally fine
- the worker made good judgments
- the run still stalled because a long-running nested `codex review` subprocess
  was launched inside an ACP turn and never returned a final result

This document defines the production-ready architecture for `acpx` flows.

The goal is not to make the worker do everything.

The goal is to make the runtime own execution and liveness, while the ACP worker
owns reasoning, judgment, and code changes.

## Core position

The correct long-term shape is a hybrid workflow engine:

- the runtime is the control plane
- ACP workers are reasoning workers
- deterministic mechanics run as native runtime actions

In other words:

- the runtime should own step execution, deadlines, retries, heartbeats,
  cancellation, state, and side effects
- the worker should own analysis, coding, judgment, summarization, and
  decisions that are genuinely model-shaped

This is the cleanest and most production-ready boundary.

It is also the most robust answer to the question raised by the prototype:

why did the flow stall?

Because a child tool run was hosted inside an ACP turn instead of being owned
and supervised by the runtime.

## What went wrong in the prototype

The current prototype runner executes ACP steps synchronously and waits for each
step to finish before persisting completion.

That is acceptable for simple prompts, but it becomes fragile when an ACP step
tries to orchestrate external mechanics itself.

In the PR triage case, the failure mode was:

1. the runtime entered the review step
2. the worker decided to run `codex review`
3. that review launched as a nested subprocess inside the worker turn
4. the review got stuck on transport/runtime behavior
5. the parent ACP turn never returned structured output
6. the outer flow looked hung

This exposed three separate issues:

- the wrong boundary for deterministic actions
- no explicit per-step liveness signal in run state
- no reliable step deadline or timeout behavior at the flow layer

## Production model

### 1. The runtime is the control plane

The flow runtime should own:

- flow graph execution
- current node and next node
- step deadlines and timeouts
- retries and retry policy
- run persistence
- heartbeats and staleness detection
- cancellation
- side-effect execution
- idempotency and action receipts

The runtime must always know:

- which node is active
- how long it has been active
- whether it is making progress
- whether it timed out
- whether it is blocked on a human or an external dependency

### 2. ACP steps are for reasoning, not orchestration

ACP steps should be used for:

- extracting intent
- judging solution shape
- classifying bug vs feature
- deciding whether refactor is needed
- deciding whether human escalation is required
- editing code when the change is genuinely model-driven
- summarizing findings for a final comment

ACP steps should not be the place where the model is expected to supervise
long-running deterministic subprocesses.

That means:

- do not host `codex review` inside a Codex ACP turn
- do not host `gh api` polling loops inside an ACP turn
- do not host CI approval or CI inspection loops inside an ACP turn

Those belong to the runtime.

### 3. Native action steps should handle deterministic work

The runtime should support native action steps for deterministic operations such
as:

- `git_fetch`
- `checkout_pr`
- `gh_api`
- `codex_review`
- `approve_workflow_run`
- `post_pr_comment`
- `close_pr`
- `run_tests`
- `run_targeted_validation`

These actions should be:

- directly observable
- cancellable
- time-bounded
- resumable when possible
- recorded with machine-readable receipts

The worker can still decide whether they should run, but the runtime should
actually execute them.

### 4. One durable run state, updated while the step is still active

The flow runtime must persist live state before awaiting a step result.

At minimum, run state should include:

- `status`
- `currentNode`
- `currentNodeKind`
- `currentNodeStartedAt`
- `lastHeartbeatAt`
- `statusDetail`
- `outputs`
- `steps`
- `sessionBindings`
- `waitingOn`
- `error`

This avoids the current ambiguity where `run.json` only changes after a node
completes and a healthy run looks frozen.

### 5. Every long-running step needs heartbeat, deadline, and cancellation

Every `acp` or `action` step should support:

- `timeoutMs`
- optional heartbeat updates
- cancellation on timeout
- explicit terminal result if timed out

For ACP steps:

- timeout should cancel the active session prompt if possible

For native action steps:

- timeout should kill the child process and mark the step `timed_out`

This is the minimum production liveness contract.

### 6. Side effects must be idempotent and recorded

A production workflow runtime must assume retries and restarts.

For effectful steps such as posting comments or closing PRs, the runtime should
store receipts such as:

- GitHub comment id
- workflow run id
- CI approval id
- commit sha
- pushed branch sha

That allows safe resume and retry behavior without duplicated actions.

### 7. Session handling should stay simple

The session model should remain:

- one main ACP session by default
- explicit isolated sessions only when a step truly needs a blind or separate
  conversation

The runtime should track those bindings internally.

The flow author should usually think in terms of:

- main reasoning session
- isolated critic session when needed

not in terms of queue-owner mechanics or persistence internals.

## Recommended step model

The core step kinds should stay small:

- `acp`
- `compute`
- `action`
- `checkpoint`

But the semantics should be tighter.

### `acp`

Use for model-shaped work:

- judgment
- code generation
- summarization
- route recommendation

### `compute`

Use for local pure transforms:

- normalizing outputs
- computing branch keys
- reducing multiple findings into one route

### `action`

Use for deterministic external work supervised by the runtime:

- git commands
- GitHub API calls
- test execution
- local `codex review`
- comment posting
- CI approval

### `checkpoint`

Use for explicit wait states:

- human approval
- external webhook
- workflow approval gate that the runtime cannot clear

## Simplicity rules

The runtime should stay boring.

That means:

- keep the core node set small
- prefer generic primitives over workload-specific helpers
- add fewer conventions, not more

Some concrete examples:

- a per-step `cwd` override is enough; `acpx` does not need a built-in
  `git_worktree_for_pr` primitive
- a shell-backed `action` step is enough for many deterministic mechanics; do
  not rush to add a new first-class node type for every external tool
- keep JSON parsing simple:
  - use compatibility parsing by default for real workflows, because models do
    sometimes wrap valid JSON in extra chatter
  - use strict JSON parsing only when the contract truly must fail on any extra
    text
  - do not turn structured-output handling into a giant parser framework

The right bias is:

- generic runtime capabilities in `acpx`
- workload-specific policy in user-authored workflow files

That keeps the library production-ready without making it heavy.

## PR triage under the production model

The PR triage workflow should still follow the same logical flow, but some
current ACP steps should become native actions.

A better shape is:

1. `load_pr` — `action`
2. `prepare_workspace` — `action`
3. `extract_intent` — `acp`
4. `judge_implementation_or_solution` — `acp`
5. `bug_or_feature` — `acp`
6. `reproduce_bug_and_test_fix` or `test_feature_directly` — `action`
7. `judge_refactor` — `acp`
8. `collect_github_review_state` — `action`
9. `run_local_codex_review` — `action`
10. `judge_review_outcome` — `acp` or `compute`
11. `check_ci_state` — `action`
12. `fix_ci_failures` — `acp` plus `action` test steps as needed
13. `render_final_comment` — `acp`
14. `post_comment` / `close_pr` / `checkpoint` — `action` or `checkpoint`

This keeps the worker in charge of judgment while making execution much more
reliable.

## What the runtime should expose

The runtime should eventually expose:

- per-node timeout configuration
- per-node heartbeat policy
- per-action retry policy
- per-action idempotency keys
- live `flow status`
- `flow cancel`
- `flow resume`
- step receipts in run state

This does not require a giant orchestration DSL.

It requires a small set of strong primitives.

## Failure model

The runtime should distinguish these states clearly:

- `running`
- `waiting`
- `completed`
- `failed`
- `timed_out`
- `cancelled`

And these error classes should be surfaced distinctly when possible:

- child process hung
- child process failed
- ACP prompt timed out
- external API failed
- blocked on permission gate
- blocked on human approval
- invalid step output

That makes debugging and operator behavior much cleaner.

## Incremental path from the current implementation

The best migration path is:

### Step 1: improve liveness and observability

Add:

- `currentNode`
- `currentNodeStartedAt`
- `lastHeartbeatAt`
- live `run.json` updates at node start
- per-node `timeoutMs`

This should land first.

### Step 2: add native action execution

Keep the same graph model, but make deterministic work first-class:

- command-backed actions
- GitHub-backed actions
- review/test actions

This should land second.

### Step 3: move recursive mechanics out of ACP prompts

Refactor workflows so they stop asking the worker to supervise:

- `codex review`
- `gh api`
- CI approval loops
- comment posting

The runtime should do those directly.

### Step 4: add receipts and idempotency

This makes comment posting, PR closing, and CI approval safe under retries and
resume.

## What not to do

Do not move toward:

- a single giant conversational agent that does everything
- recursive agent-inside-agent orchestration for core mechanics
- implicit run state that only exists in model context
- prose-only routing for effectful decisions

That shape may feel flexible at first, but it is the least production-ready
option.

## Final position

The most production-ready `acpx` flow architecture is:

- durable runtime-owned workflow execution
- native deterministic action steps
- ACP reasoning steps for judgment and coding
- explicit liveness, heartbeat, timeout, and cancellation
- idempotent recorded side effects

That is the cleanest long-term model.

It is also the most credible path if `acpx` wants flows that survive real,
long-running, autonomous workloads without turning the worker itself into a
fragile orchestration layer.
