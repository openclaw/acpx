---
title: Flows
description: Multi-step ACP workflows in acpx — define a TypeScript flow, mix acp / action / compute / decision / checkpoint nodes, persist runs, and replay.
---

Flows are how `acpx` runs multi-step ACP work without turning one giant prompt into the workflow engine. They are TypeScript modules that the `acpx/flows` runtime executes step by step, persisting state under `~/.acpx/flows/runs/`.

> Flows are an experimental, opt-in surface. The authoring API is in `acpx/flows`; flows do not change how persistent sessions or `prompt` / `exec` work.

## When to use flows

Reach for a flow when one prompt is not enough — typically because:

- you need a deterministic branch (classify, then route)
- one ACP turn should not also run shell commands or call the GitHub API
- you want each step to be inspectable and replayable
- the workflow is the same across runs, but the input changes

For one-off asks, `acpx codex 'do the thing'` is the right tool. For "run this 6-step PR triage on every PR matching a query," a flow is the right tool.

## Run a flow

```bash
acpx flow run ./my-flow.ts
acpx flow run ./my-flow.ts --input-file ./flow-input.json
acpx flow run ./my-flow.ts --input-json '{"task":"FIX: …"}'
acpx flow run ./my-flow.ts --default-agent claude
acpx --timeout 1800 flow run ./my-flow.ts
```

What happens:

- The runtime loads the flow module from disk.
- A run id is generated and a run directory is created at `~/.acpx/flows/runs/<runId>/`.
- Steps execute in topological order. ACP steps reuse one implicit main session by default.
- Run state (graph, ACP transcripts, artifacts, errors) is persisted as the run progresses.
- The runtime exits when the graph terminates or a checkpoint pauses.

`--input-json` and `--input-file` are mutually exclusive ways to provide flow input. `--default-agent` supplies the default agent profile for `acp` nodes that do not pin one.

## Node types

Flows are graphs. Each node is one of:

| Node         | Purpose                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| `acp`        | A model-shaped step — runs an ACP turn against an agent session.                            |
| `action`     | A deterministic runtime-owned step — typically a shell command or HTTP call.                |
| `compute`    | A pure local function — shape inputs, route, format, derive values.                         |
| `decision`   | A constrained-choice ACP branch — wraps `acp` + `parse` + `switch` for typed routing.       |
| `checkpoint` | A pause point that requires something outside the runtime (human review, external trigger). |

Edges connect nodes. `decisionEdge()` produces typed edges out of a `decision()` node so the routing is explicit and replayable.

The runtime owns:

- graph execution and step ordering
- liveness and timeouts
- ACP session lifecycle
- persistence and replay
- routing through `decision` outcomes

The agent owns reasoning, summarization, and tool calls inside `acp` and `decision` nodes. The flow file does not implement the workflow engine — it declares it.

## Authoring surface

Define a flow with `defineFlow` from `acpx/flows`:

```ts
import { defineFlow, acp, action, compute, decision } from "acpx/flows";

export default defineFlow({
  id: "triage",
  input: { task: "string" },
  steps: {
    classify: decision({
      agent: "codex",
      prompt: ({ task }) => `Classify: ${task}\nLabels: bug | feat | doc`,
      choices: ["bug", "feat", "doc"],
    }),
    fix: acp({ prompt: ({ task }) => `Implement and verify: ${task}` }),
    write_doc: acp({ prompt: ({ task }) => `Draft docs entry for: ${task}` }),
  },
  edges: [
    ["classify", "fix", (out) => out === "bug" || out === "feat"],
    ["classify", "write_doc", (out) => out === "doc"],
  ],
});
```

The example above is illustrative — see `examples/flows/branch.flow.ts` for the canonical small `decision()` example.

## Workspace isolation

`acp` nodes can pin a per-step working directory:

```ts
acp({
  cwd: "${workdir}/.work-tree",
  prompt: ({ task }) => `Run inside the prepped tree: ${task}`,
});
```

This lets a flow `action` step (e.g., `git worktree add`) prepare an isolated workspace, then have downstream `acp` nodes operate inside that cwd. `examples/flows/workdir.flow.ts` shows the pattern end-to-end.

## Permissions

Flows can declare an explicit permission requirement. If a flow needs `approve-all` and you forget the flag, `acpx` fails fast before the first step runs and prints the flag to add:

```bash
acpx flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
# error: this flow requires --approve-all
```

```bash
# correct
acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
```

This is a guardrail for flows that make real changes — the PR-triage example can comment on or close GitHub PRs against a live repo.

## Run persistence

Each run produces a bundle under `~/.acpx/flows/runs/<runId>/`:

- step-by-step graph state with inputs and outputs
- ACP transcripts for every `acp` and `decision` step
- artifacts written by `action` steps (when the step opts in)
- final result or error

Bundles are immutable once a run terminates. They are the input for the [replay viewer](#replay-viewer).

## Timeouts

`acp` and `action` nodes use the global `--timeout` value as their default per-step timeout. If `--timeout` is not set, flows default to **15 minutes per active step**. Override per step in the flow definition when needed.

A shell action's `timeoutMs: 0` disables its own deadline; an enclosing node deadline still applies. On expiry or interruption, acpx cancels active shell commands and waits for termination and output-stream cleanup before reporting cancellation. Cleanup failures are reported instead of silently claiming cleanup succeeded. An executor that resolves after its node has timed out or been interrupted cannot launch a new shell process.

On POSIX, cleanup covers the owned process group and descendants discoverable before it is signalled, including descendants that move to another process group while their wrapper is active. Successful command completion still follows the wrapper's exit. A child that deliberately starts a separate session with independent stdio and is reparented before cancellation can outlive the flow, as before; acpx does not provide persistent supervision of escaped daemons.

## Replay viewer

`examples/flows/replay-viewer/` is a browser app that visualizes saved run bundles:

- React Flow graph with per-node status
- recent-runs picker (live over WebSocket — in-progress runs update without refresh)
- ACP session inspection per step
- rewind/scrub through the run timeline

Run from the repo root:

```bash
pnpm viewer
```

The viewer is read-only. It opens a saved bundle and lets you inspect what happened; it does not re-run the flow.

## Example flows in the source tree

Under `examples/flows/`:

- `echo.flow.ts` — minimal one-step ACP flow that returns a JSON reply
- `branch.flow.ts` — `decision()` + `decisionEdge()` constrained-choice classification, then a deterministic branch
- `shell.flow.ts` — one runtime-owned shell `action` returning structured JSON
- `workdir.flow.ts` — `action` prepares a worktree, `acp` runs inside that cwd
- `two-turn.flow.ts` — same-session ACP example that uses tools across multiple steps
- `pr-triage/pr-triage.flow.ts` — larger end-to-end example with a written spec; can comment on or close real GitHub PRs against a live repo

The PR-triage example declares an explicit `approve-all` requirement, so it must be run with `--approve-all`.

## Practical examples

```bash
# Smallest possible run
acpx flow run examples/flows/echo.flow.ts \
  --input-json '{"request":"Summarize this repo in one sentence."}'

# decision()/decisionEdge() routing
acpx flow run examples/flows/branch.flow.ts \
  --input-json '{"task":"FIX: add a regression test for the reconnect bug"}'

# Runtime-owned shell action
acpx flow run examples/flows/shell.flow.ts \
  --input-json '{"text":"hello from shell"}'

# Multi-turn same-session work
acpx flow run examples/flows/two-turn.flow.ts \
  --input-json '{"topic":"How should we validate a new ACP adapter?"}'

# Live PR triage (declares approve-all)
acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
```

## See also

- [Architecture: acpx flows](https://github.com/openclaw/acpx/blob/main/docs/2026-03-25-acpx-flows-architecture.md) — full design doc.
- [Flow trace replay](https://github.com/openclaw/acpx/blob/main/docs/2026-03-26-acpx-flow-trace-replay.md) — replay format spec.
- [Flow permission requirements](https://github.com/openclaw/acpx/blob/main/docs/2026-03-28-acpx-flow-permission-requirements.md) — fail-fast permission gating.
- [`examples/flows/` in the source tree](https://github.com/openclaw/acpx/tree/main/examples/flows) — runnable flow examples and a colocated `README`.
