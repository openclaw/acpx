---
title: Overview
permalink: /
description: "acpx is a headless CLI client for the Agent Client Protocol (ACP) — talk to coding agents from the command line, not the PTY."
---

## Try it

After a one-line install ([Quickstart](quickstart.md) walks through it), every coding agent is one command away.

```bash
# Persistent multi-turn session, scoped per repo.
acpx codex sessions new
acpx codex 'find the flaky test and fix it'

# Switch agents, same surface.
acpx claude 'refactor the auth middleware'
acpx gemini 'review this branch'

# One-shot, no saved context.
acpx codex exec 'summarize this repo in 5 bullets'

# Pipe structured ACP events into your own automation.
acpx --format json codex exec 'review changed files' \
  | jq -r 'select(.type=="tool_call") | [.status,.title] | @tsv'

# Run a TypeScript multi-step flow against a real agent.
acpx flow run examples/flows/branch.flow.ts \
  --input-json '{"task":"add a regression test for the reconnect bug"}'
```

`text` output is human readable, `--format json` emits NDJSON ACP messages, `--format quiet` keeps only the assistant text. Tool calls, thinking, and diffs come through as structured events instead of ANSI scraping.

## What acpx does

- **One CLI, every coding agent.** Built-in adapters for Codex, Claude, Pi, OpenClaw, Gemini, Cursor, Copilot, Droid, Qwen, Qoder, Trae, and more — plus `--agent` for any custom ACP server.
- **Persistent sessions.** Multi-turn conversations survive across invocations, scoped per repo. `-s <name>` runs parallel workstreams (`backend`, `docs`, `pr-842`).
- **Queue-aware prompts.** Submit while a turn is running; new prompts queue and drain in order. `--no-wait` enqueues and returns. `cancel` aborts cooperatively without tearing the session down.
- **Crash-resistant.** Dead agent processes are detected and reloaded automatically. `Ctrl+C` sends ACP `session/cancel` before any force-kill.
- **Structured output.** `text`, `json`, and `quiet` modes. Strict JSON mode keeps stderr quiet so machines can parse stdout cleanly.
- **Permission policy as a flag.** `--approve-all`, `--approve-reads` (default), `--deny-all`. Non-interactive policy is configurable. Sandbox to a `--cwd`.
- **Flows.** `acpx flow run <file>` executes a TypeScript workflow over multiple ACP turns plus deterministic `action` and `compute` steps. Run state persists under `~/.acpx/flows/runs/`.
- **Embeddable.** `acpx/runtime` and `acpx/flows` are public exports — build higher-level tools without re-implementing session storage, queue ownership, or ACP wire handling.

## Pick your path

- **Trying it.** [Install](install.md) → [Quickstart](quickstart.md). Two minutes from `npm i -g acpx` to your first turn.
- **Talking to a specific agent.** The [Agents](agents.md) page lists every built-in name and the upstream CLI it wraps.
- **Wiring an automation.** [Output formats](output-formats.md) for the JSON envelope, [Sessions](sessions.md) for scope rules, [Permissions](permissions.md) for policy.
- **Multi-step orchestration.** [Flows](flows.md) covers `acp` / `action` / `compute` / `decision` / `checkpoint` nodes and replay.
- **Looking up a flag.** The [CLI reference](CLI.md) is the long-form spec for every command, option, and exit code.

## Project

Active alpha; the [changelog](https://github.com/openclaw/acpx/blob/main/CHANGELOG.md) tracks each release. The CLI surface is still evolving — see the [Vision](VISION.md) for what stays in core and what does not. MIT licensed. Not affiliated with any specific agent vendor.
