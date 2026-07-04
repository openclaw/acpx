---
name: acpx
description: Use acpx as a headless ACP CLI for agent-to-agent communication, including prompt/exec/sessions workflows, session scoping, queueing, permissions, output formats, system-prompt overrides, and multi-agent flows authored with defineFlow/decision/decisionEdge.
---

# acpx

## When to use this skill

Use this skill when you need to run coding agents through `acpx`, manage persistent ACP sessions, queue prompts, override the Claude system prompt, prune stale sessions, consume structured agent output from scripts, or compose multi-agent workflows declaratively with `acpx/flows`.

## What acpx is

`acpx` is a headless, scriptable CLI client for the Agent Client Protocol (ACP). It is built for agent-to-agent communication over the command line and avoids PTY scraping.

Core capabilities:

- Persistent multi-turn sessions per repo/cwd
- One-shot execution mode (`exec`)
- Named parallel sessions (`-s/--session`)
- Idempotent session creation (`sessions ensure`)
- Session retention controls (`sessions prune` with age filters and history cleanup)
- Portable session export/import for moving records and history across machines
- Queue-aware prompt submission with optional fire-and-forget (`--no-wait`)
- Cooperative cancel command (`cancel`) for in-flight turns
- Graceful cancellation via ACP `session/cancel` on interrupt
- Session control methods (`set-mode`, `set <key> <value>`)
- Agent reconnect/resume after dead subprocess detection
- Prompt input via stdin or `--file`
- Config files with global+project merge and `config show|init`
- Session metadata/history inspection (`sessions show`, `sessions history`)
- Local agent process checks via `status`
- Stable ACP client methods for filesystem and terminal requests
- Stable ACP `authenticate` handshake via env/config credentials
- Structured streaming output (`text`, `json`, `quiet`) with optional `--suppress-reads`
- Built-in agent registry plus raw `--agent` escape hatch
- Claude system prompt override via `--system-prompt` / `--append-system-prompt`
- Optional terminal capability disable via `--no-terminal` for review-only flows
- Tool whitelist (`--allowed-tools`), turn cap (`--max-turns`), retry on transient failures (`--prompt-retries`)
- Multi-agent flows via `acpx flow run` and the `acpx/flows` authoring API (`defineFlow`, `decision`, `decisionEdge`, `acp`, `action`, `compute`, `checkpoint`)

## Install

```bash
npm i -g acpx
```

For normal session reuse, prefer a global install over `npx`.

## Command model

`prompt` is the default verb.

```bash
acpx [global_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_options] [prompt_text...]
acpx [global_options] compare <agent>... '<prompt_text>'
acpx [global_options] compare <agent>... --file <path>
acpx [global_options] cancel [-s <name>]
acpx [global_options] set-mode <mode> [-s <name>]
acpx [global_options] set <key> <value> [-s <name>]
acpx [global_options] status [-s <name>]
acpx [global_options] sessions [list | new [--name <name>] | ensure [--name <name>] | close [name] | show [name] | history [name] [--limit <count>] | export [name] --output <path> | import <archive> [--name <name>] [--cwd <dir>] | prune [--dry-run] [--before <date> | --older-than <days>] [--include-history]]
acpx [global_options] config [show | init]
acpx [global_options] flow run <file> [--input-json '<json>' | --input-file <path>] [--default-agent <name>]

acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] <agent> exec [prompt_options] [prompt_text...]
acpx [global_options] <agent> cancel [-s <name>]
acpx [global_options] <agent> set-mode <mode> [-s <name>]
acpx [global_options] <agent> set <key> <value> [-s <name>]
acpx [global_options] <agent> status [-s <name>]
acpx [global_options] <agent> sessions [list | new [--name <name>] | ensure [--name <name>] | close [name] | show [name] | history [name] [--limit <count>] | export [name] --output <path> | import <archive> [--name <name>] [--cwd <dir>] | prune [--dry-run] [--before <date> | --older-than <days>] [--include-history]]
```

If prompt text is omitted and stdin is piped, `acpx` reads prompt text from stdin.

## Built-in agent registry

Friendly agent names resolve to commands:

- `pi` -> `npx pi-acp`
- `openclaw` -> `openclaw acp`
- `codex` -> `npx -y @agentclientprotocol/codex-acp`
- `claude` -> `npx -y @agentclientprotocol/claude-agent-acp` (ACPX-owned package range)
- `gemini` -> `gemini --acp`
- `cursor` -> `cursor-agent acp`
- `copilot` -> `copilot --acp --stdio`
- `droid` -> `droid exec --output-format acp` (`factory-droid` and `factorydroid` also resolve to `droid`)
- `fast-agent` -> `uvx fast-agent-mcp acp`
- `grok-build` -> `grok agent stdio`
- `iflow` -> `iflow --experimental-acp`
- `kilocode` -> `npx -y @kilocode/cli acp`
- `kimi` -> `kimi acp`
- `kiro` -> `kiro-cli-chat acp`
- `mux` -> `npx -y mux@^0.27.0 acp`
- `opencode` -> `npx -y opencode-ai acp`
- `qoder` -> `qodercli --acp`
  Forwards Qoder-native `--allowed-tools` and `--max-turns` startup flags from `acpx` session options.
- `qwen` -> `qwen --acp`
- `trae` -> `traecli acp serve`

Rules:

- Default agent is `codex` for top-level `prompt`, `exec`, and `sessions`.
- Unknown positional agent tokens are treated as raw agent commands.
- `--agent <command>` explicitly sets a raw ACP adapter command.
- Do not combine a positional agent and `--agent` in the same command.

## Commands

### Prompt (default, persistent session)

Implicit:

```bash
acpx codex 'fix flaky tests'
```

Explicit:

```bash
acpx codex prompt 'fix flaky tests'
acpx prompt 'fix flaky tests'   # defaults to codex
```

Behavior:

- Uses a saved session for the session scope key
- Auto-resumes prior session when one exists for that scope
- If no session exists for the scope, exits with `NO_SESSION` and prompts for `sessions new`
- Is queue-aware when another prompt is already running for the same session
- On interrupt during an active turn, sends ACP `session/cancel` before force-kill fallback

Prompt options:

- `-s, --session <name>`: use a named session within the same cwd
- `--no-wait`: enqueue and return immediately when session is already busy
- `-f, --file <path>`: read prompt text from file (`-` means stdin)

### Exec (one-shot)

```bash
acpx exec 'summarize this repo'
acpx codex exec 'summarize this repo'
```

Behavior:

- Runs a single prompt in a temporary ACP session
- Does not reuse or save persistent session state

### Compare (multi-agent one-shot)

```bash
acpx compare pi openclaw codex 'summarize this checkout'
acpx --format json compare codex claude --file prompt.md
```

Behavior:

- Runs the same temporary-session prompt against each listed agent
- Runs agents serially in the requested workspace
- Reuses the global `exec` controls: cwd, timeout, permissions, `--policy`, auth, terminal, retries, model/system options, and output format
- `--format text` prints one summary table row per agent
- `--format json` or `--json` prints `CompareRow[]`
- `--format quiet` prints `<agent>\t<status>` per row
- Does not create saved sessions or separate compare transcript directories

### Cancel / Mode / Config / Model

```bash
acpx codex cancel
acpx codex set-mode auto
acpx codex set model gpt-5.2[high]
acpx codex set model gpt-5.4
```

Behavior:

- `cancel`: sends cooperative `session/cancel` through queue-owner IPC.
- `set-mode`: calls ACP `session/set_mode`.
- `set-mode` mode ids are adapter-defined; unsupported values are rejected by the adapter (often `Invalid params`).
- `set`: calls ACP `session/set_config_option`.
- For codex, reasoning effort is selected through advertised ACP model ids when the adapter reports model variants.
- `--model <id>`: Claude-compatible adapters may consume session creation metadata; other agents must advertise a model config option or legacy `models` metadata.
- `set model <id>`: uses `session/set_config_option` for advertised model config options and preserves `session/set_model` for explicitly advertised legacy models.
- `set-mode`/`set` route through queue-owner IPC when active, otherwise reconnect directly.

### Sessions

```bash
acpx sessions
acpx sessions list
acpx sessions list --filter-cwd .
acpx sessions list --cursor <cursor>
acpx sessions list --local
acpx sessions new
acpx sessions new --name backend
acpx sessions ensure
acpx sessions ensure --name backend
acpx sessions close
acpx sessions close backend
acpx sessions show
acpx sessions history --limit 20
acpx sessions export backend --output backend-session.json
acpx sessions import backend-session.json --name backend-restored
acpx sessions prune --dry-run --older-than 7
acpx sessions prune --older-than 30 --include-history
acpx status

acpx codex sessions
acpx codex sessions new --name backend
acpx codex sessions ensure --name backend
acpx codex sessions close backend
acpx codex sessions show backend
acpx codex sessions history backend --limit 20
acpx codex sessions export backend --output backend-session.json
acpx codex sessions import backend-session.json --name backend-restored
acpx codex sessions prune --before 2026-04-01 --include-history
acpx codex status
```

Behavior:

- `sessions` and `sessions list` are equivalent
- `sessions list` uses ACP `session/list` when the agent advertises it; JSON
  includes agent `SessionInfo`, `_meta`, and `nextCursor`
- `sessions list --filter-cwd <dir>` applies the ACP cwd filter, and
  `--cursor <cursor>` requests a specific page
- `sessions list --local` reads saved acpx records instead
- `new` creates a fresh session for the current `(agentCommand, cwd, optional name)` scope
- `new --name <name>` targets a named session scope
- when `new` replaces an existing open session in that scope, the old one is soft-closed
- `ensure` returns the nearest matching active session for the scope, or creates one when none is open. Idempotent — safe to call before every prompt in scripts.
- `close` targets current cwd default session
- `close <name>` targets current cwd named session
- `show [name]` prints stored metadata for that scoped session
- `history [name]` prints stored turn history previews (default 20, use `--limit`)
- `export [name] --output <path>` writes a portable JSON archive containing session state and event history
- `import <archive>` creates a fresh local record, reopens the copied session as idle, keeps the provider session id, and clears source-machine process metadata
- imported sessions must resume that provider session; if the destination agent cannot load it, prompts fail clearly instead of starting an empty conversation
- `import --name <name>` and `--cwd <dir>` override the destination scope; import fails if that scope already has an active session or another local record already uses the same provider session id
- `prune` deletes closed session records to reclaim disk space
  - `--dry-run` previews what would be deleted without touching disk
  - `--older-than <days>` and `--before <date>` filter by close time, falling back to last-used time when a record was never explicitly closed
  - `--include-history` also removes per-session event stream files (otherwise only the JSON record is removed)

## Global options

- `--agent <command>`: raw ACP agent command (escape hatch)
- `--cwd <dir>`: working directory for session scope (default: current directory)
- `--approve-all`: auto-approve all permission requests
- `--approve-reads`: auto-approve reads/searches, prompt for writes (default mode)
- `--deny-all`: deny all permission requests
- `--non-interactive-permissions <policy>`: when prompting is unavailable, choose `deny` or `fail`
- `--permission-policy <json-or-file>` / `--policy`: per-tool ACP permission rules (`autoApprove`, `autoDeny`, `escalate`, `defaultAction`)
- `--format <fmt>`: output format (`text`, `json`, `quiet`)
- `--json-strict`: strict JSON mode; requires `--format json` and suppresses non-JSON stderr output
- `--suppress-reads`: suppress raw read-file contents while preserving the selected format
- `--timeout <seconds>`: max wait time (positive number)
- `--ttl <seconds>`: queue owner idle TTL before shutdown (default `300`, `0` disables TTL)
- `--model <id>`: request an agent model during session creation; non-Claude agents must advertise a model config option or legacy `models` metadata
- `--system-prompt <text>`: replace the agent system prompt. Forwarded to claude-agent-acp via ACP `_meta.systemPrompt`; persisted in `session_options.system_prompt` so reuse keeps the override. Other agents ignore the field.
- `--append-system-prompt <text>`: append text to the agent system prompt. Forwarded to claude-agent-acp via ACP `_meta.systemPrompt.append`; same persistence rules as `--system-prompt`.
- `--allowed-tools <list>`: comma-separated tool whitelist (use `""` for no tools)
- `--max-turns <count>`: cap session turn count
- `--prompt-retries <count>`: retry failed prompt turns on transient errors (default `0`)
- `--no-terminal`: do not advertise the ACP terminal capability — useful for review-only or sandboxed agent invocations
- `--verbose`: verbose ACP/debug logs to stderr

Cursor may advertise bracketed model ids such as `composer-2.5[fast=false]`. A bare Cursor
model name is normalized only when exactly one advertised bracketed variant matches it.

Permission flags are mutually exclusive.

## System prompt override (Claude)

`--system-prompt` and `--append-system-prompt` let you specialize a Claude session without leaving lingering one-off state, while still benefiting from persistent session reuse.

```bash
# Replace the system prompt for a named session, persisted across reuse
acpx --system-prompt "You are a code reviewer who challenges every implicit assumption." claude -s review

# Append a guideline on top of the default system prompt
acpx --append-system-prompt "Always explain trade-offs before recommending a fix." claude -s impl
```

The override is forwarded via ACP `_meta.systemPrompt` (or `_meta.systemPrompt.append`) on `session/new` and stored in `session_options.system_prompt`. Subsequent `prompt`/`ensure` calls in the same scope keep the override unless you explicitly create a new session. Non-Claude adapters ignore the field, so the same flag is safe inside cross-agent scripts.

## Claude settings isolation

Built-in `acpx claude` sessions load Claude project and local settings, but not
user settings. This prevents globally enabled channel and daemon plugins from
claiming singleton external resources in an ACP-spawned session.

Set `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` only when the spawned session needs
the user's global Claude settings and no such plugin conflict exists. Ambient
credentials and other environment variables are still inherited normally.

## Sessions cleanup

Closed session records accumulate on disk by default. Use `sessions prune` to enforce retention:

```bash
# Preview what would be deleted (no writes)
acpx codex sessions prune --dry-run --older-than 7

# Remove records closed more than 30 days ago, including their event-stream files
acpx codex sessions prune --older-than 30 --include-history

# Remove everything closed before a date
acpx codex sessions prune --before 2026-04-01
```

Without `--include-history`, only the lightweight JSON record is removed; event-stream files are preserved for audit. With it, the per-session event log is also deleted to reclaim disk space.

## Config files

Config files are merged in this order (later wins):

- global: `~/.acpx/config.json`
- project: `<cwd>/.acpxrc.json`

Supported keys:

- `defaultAgent`
- `defaultPermissions` (`approve-all`, `approve-reads`, `deny-all`)
- `nonInteractivePermissions` (`deny`, `fail`)
- `ttl` (seconds)
- `timeout` (seconds or `null`)
- `format` (`text`, `json`, `quiet`)
- `agents` map (`name -> { command, args? }`)
- `auth` map (`authMethodId -> credential`)

Use `acpx config show` to inspect the resolved config and `acpx config init` to create the global template.

For ACP `authenticate` handshakes, use either config `auth` entries or explicit
`ACPX_AUTH_<METHOD_ID>` environment variables such as `ACPX_AUTH_OPENAI_API_KEY`.
Ambient provider env vars such as `OPENAI_API_KEY` are still passed through to
child agents, but they do not trigger ACP auth-method selection on their own.

## Devin ACP compatibility

Devin is not a built-in agent shortcut. Use the raw command escape hatch:

```bash
acpx --agent 'devin acp' exec 'summarize this repo'
```

Pass Devin global flags such as `--model <model>` before `acp` when needed.

When `acpx` detects a Devin ACP launch (`devin ... acp`, `devin ... --acp`, or `devin ... --experimental-acp`), it advertises the minimum Windsurf-compatible metadata needed for Devin's ACP gate:

- `clientInfo.name`: `windsurf` instead of `acpx`
- `clientInfo.version`: `ACPX_DEVIN_WINDSURF_VERSION` env var, default `1.110.1`
- `clientCapabilities`: standard `fs` and `terminal` support, plus `_meta["cognition.ai/requestDiagnostics"] = true`
- Extension handling: returns `{}` for Devin `_cognition.ai/request_diagnostics` requests and accepts extension notifications without method-not-found noise

This compatibility shim is scoped to Devin ACP launches only. Other agents continue to receive standard `acpx` identity and capabilities.

See the repository [`agents/Devin.md`](https://github.com/openclaw/acpx/blob/main/agents/Devin.md) for the full Devin compatibility contract.

## Session behavior

Persistent prompt sessions are scoped by:

- `agentCommand`
- absolute `cwd`
- optional session `name`

Persistence:

- Session records are stored in `~/.acpx/sessions/*.json`.
- `-s/--session` creates parallel named conversations in the same repo.
- Changing `--cwd` changes scope and therefore session lookup.
- closed sessions are retained on disk with `closed: true` and `closedAt` until pruned.
- auto-resume by scope skips closed sessions.

Resume behavior:

- Prompt mode attempts to reconnect to saved session.
- If adapter-side session is invalid/not found, `acpx` creates a fresh session and updates the saved record.
- explicitly selected session records can still be resumed via `loadSession` even if previously closed.
- dead saved PIDs are detected and reconnected on the next prompt.
- each completed prompt stores lightweight turn history previews in the session record.

## Prompt queueing and `--no-wait`

Queueing is per persistent session.

- The active `acpx` process for a running prompt becomes the queue owner.
- Other invocations submit prompts over local IPC.
- On Unix-like systems, queue IPC uses a Unix socket under `~/.acpx/queues/<hash>.sock`.
- Ownership is coordinated with a lock file under `~/.acpx/queues/<hash>.lock`.
- On Windows, named pipes are used instead of Unix sockets.
- after the queue drains, owner shutdown is governed by TTL (default 300s, configurable with `--ttl`).

Submission behavior:

- Default: enqueue and wait for queued prompt completion, streaming updates back.
- `--no-wait`: enqueue and return after queue acknowledgement.
- `Ctrl+C` during an active turn sends ACP `session/cancel`, waits briefly, then force-kills only if cancellation does not finish in time.
- `cancel` sends the same cooperative cancellation without requiring terminal signals.

## Output formats

Use `--format <fmt>`:

- `text` (default): human-readable stream with updates/tool status and done line
- `json`: NDJSON event stream (good for automation)
- `quiet`: final assistant text only
- `--suppress-reads`: replace raw read-file contents with `[read output suppressed]` in `text` and `json` output
- `--json-strict`: pair with `--format json` to suppress non-JSON stderr noise (logs, banners) for downstream consumers

Example automation:

```bash
acpx --format json codex exec 'review changed files' \
  | jq -r 'select(.type=="tool_call") | [.status, .title] | @tsv'
```

## Permission modes

- `--approve-all`: no interactive permission prompts
- `--approve-reads` (default): approve reads/searches, prompt for writes
- `--deny-all`: deny all permission requests
- `--non-interactive-permissions <deny|fail>`: chosen behavior when no TTY is available to prompt
- `--policy <json-or-file>`: match ACP permission requests by tool kind/title; non-interactive escalations add ACP response metadata

If every permission request is denied/cancelled and none approved, `acpx` exits with permission-denied status.

## Flows (multi-agent workflows)

Flows let you declare a multi-agent workflow as a graph of typed nodes connected by edges, executed by the `acpx` runtime. The runtime owns persistence, retries, timeouts, and routing — the flow file declares the shape, not the engine.

### Run a flow

```bash
acpx flow run ./my-flow.flow.ts --input-file ./flow-input.json
acpx flow run ./my-flow.flow.ts --input-json '{"task":"FIX: add a regression test"}'
acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
acpx flow run ./my-flow.flow.ts --default-agent claude
```

Run artifacts persist under `~/.acpx/flows/runs/<runId>/`. Default per-step timeout is 15 minutes when `--timeout` is unset; flows that declare permission requirements fail fast before starting.

### Authoring a flow

The authoring surface lives in `acpx/flows`. The minimal example:

```ts
import { acp, decision, decisionEdge, defineFlow, checkpoint, extractJsonObject } from "acpx/flows";

const choices = ["bug", "feat", "doc"] as const;

export default defineFlow({
  name: "pr-triage",
  startAt: "classify",
  nodes: {
    classify: decision({
      choices,
      question: ({ input }) =>
        `Classify the PR description below. Reply with one of: ${choices.join(", ")}.\n\n${input.description}`,
    }),
    bug_lane: acp({
      prompt: ({ outputs }) =>
        `The PR is a bug. Write a regression test that reproduces it.\n\nDecision context: ${JSON.stringify(outputs.classify)}`,
      parse: (text) => extractJsonObject(text),
    }),
    feat_lane: acp({
      prompt: () => "List acceptance criteria for the feature, one bullet per criterion.",
    }),
    doc_lane: checkpoint({
      summary: "doc change — needs human review",
      run: ({ outputs }) => ({ route: "doc", note: outputs.classify }),
    }),
  },
  edges: [
    decisionEdge({
      from: "classify",
      choices,
      cases: {
        bug: "bug_lane",
        feat: "feat_lane",
        doc: "doc_lane",
      },
    }),
  ],
});
```

### Node types

| Type                                    | Purpose                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp({ prompt, parse?, agent?, cwd? })` | Model-driven step. The `prompt` builder receives `{ input, outputs }`. Optional `parse` coerces the raw text (e.g., `extractJsonObject`).                        |
| `decision({ choices, question })`       | Constrained-choice LLM step. `choices` is a `readonly` tuple; the runtime validates the model's reply against it and TypeScript infers the union from `choices`. |
| `action(...)`                           | Runtime-supervised deterministic operation: shell, GitHub API, test execution, comment posting.                                                                  |
| `compute(...)`                          | Pure local data transform: normalization, routing key derivation, signal reduction.                                                                              |
| `checkpoint({ summary, run })`          | Pause point for human or external trigger. `run` returns the outcome to record while paused.                                                                     |

### Edge shapes

```ts
// Linear edge
{ from: "node", to: "next" }

// JSONPath switch — non-decision routing
{
  from: "node",
  switch: {
    on: "$.route",
    cases: { "value-a": "branch_a", "value-b": "branch_b" },
  },
}

// Decision edge — exhaustive at compile time
decisionEdge({
  from: "classify",
  choices,                                 // same readonly tuple as decision()
  cases: {                                 // every choice must map to a node id
    bug: "bug_lane",
    feat: "feat_lane",
    doc: "doc_lane",
  },
})
```

If a `decisionEdge` omits a case from `choices`, the TypeScript compiler refuses to compile — so a flow can't ship with a forgotten branch when new choices are added.

### Why use flows

- **Cross-vendor by construction**: classify with `codex`, write code with `claude`, summarize with `gemini` — same flow file, no glue.
- **Persistence and replay**: every run streams events to disk, replayable via the flow viewer under `~/.acpx/flows/runs/`.
- **Permission preflight**: flows declaring permission requirements fail before any agent starts, instead of mid-run.
- **Typed routing**: the LLM is constrained to a literal union, the compiler verifies exhaustivity, the runtime validates the reply.

See `examples/flows/` in the repo for working samples (`branch.flow.ts`, `pr-triage/`, `two-turn.flow.ts`, `shell.flow.ts`, `workdir.flow.ts`).

## Practical workflows

Persistent repo assistant:

```bash
acpx codex 'inspect failing tests and propose a fix plan'
acpx codex 'apply the smallest safe fix and run tests'
```

Parallel named streams:

```bash
acpx codex -s backend 'fix API pagination bug'
acpx codex -s docs 'draft changelog entry for release'
```

Specialized Claude reviewer that survives session reuse:

```bash
acpx --system-prompt "You are a reviewer who refuses to approve untested changes." claude -s reviewer
acpx claude -s reviewer 'review the diff in src/auth/'
```

Idempotent session bootstrap (safe to call before every prompt in scripts):

```bash
acpx codex sessions ensure -s ci
acpx codex -s ci 'run the smoke suite and report failures'
```

Queue follow-up without waiting:

```bash
acpx codex 'run full test suite and investigate failures'
acpx codex --no-wait 'after tests, summarize root causes and next steps'
```

One-shot script step:

```bash
acpx --format quiet exec 'summarize repo purpose in 3 lines'
```

Machine-readable output for orchestration:

```bash
acpx --format json --json-strict codex 'review current branch changes' > events.ndjson
```

Raw custom adapter command:

```bash
acpx --agent './bin/custom-acp-server --profile ci' 'run validation checks'
```

Periodic cleanup:

```bash
acpx codex sessions prune --dry-run --older-than 14
acpx codex sessions prune --older-than 30 --include-history
```

Multi-agent triage flow:

```bash
acpx --approve-all flow run ./pr-triage.flow.ts --input-json '{"prNumber": 842}'
```

Repo-scoped review with permissive mode:

```bash
acpx --cwd ~/repos/shop --approve-all codex -s pr-842 \
  'review PR #842 for regressions and propose minimal patch'
```
