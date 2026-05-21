---
title: Quickstart
description: From install to a persistent multi-turn ACP session in under two minutes. Covers your first prompt, named sessions, exec, and JSON output.
---

This walks through the smallest useful path: install `acpx`, point it at a coding agent, run a multi-turn session, then peek at the persisted state.

## 1. Install

```bash
npm install -g acpx@latest
acpx --version
```

If you would rather not install globally, every command below works with `npx acpx@latest …`. ([Install](install.md) covers options.)

## 2. Pick an agent

`acpx` ships with adapters for a dozen coding agents. The two most common starting points:

```bash
# Codex (OpenAI), via @agentclientprotocol/codex-acp
acpx codex --help

# Claude Code, via @agentclientprotocol/claude-agent-acp
acpx claude --help
```

You only need the underlying agent CLI installed (or, for the npm-packaged adapters, nothing — `npx` fetches them on first use). [Agents](agents.md) lists every built-in.

## 3. Create a session

`acpx` requires an explicit session before the first prompt — this avoids surprise auto-creation in CI.

```bash
cd ~/repos/your-project
acpx codex sessions new
```

That creates a record under `~/.acpx/sessions/`, scoped to `(agentCommand, cwd)`.

## 4. Send a prompt

```bash
acpx codex 'find the slowest test in this repo and explain why'
```

You will see structured ACP events stream by — assistant text, `[tool]` blocks for each tool call, plan updates, and a final `[done] end_turn` line.

Keep going. The session is persistent:

```bash
acpx codex 'now propose a one-line fix for the slowest one'
acpx codex 'apply the fix and re-run that test'
```

Each prompt resumes the same session. If a prompt is already in flight, `acpx` queues new prompts onto the running owner instead of starting a second adapter — so you can fire-and-forget:

```bash
acpx codex --no-wait 'after the fix lands, summarize root cause in 3 lines'
```

## 5. Run something parallel

Named sessions let you split workstreams in the same repo:

```bash
acpx codex sessions new --name backend
acpx codex sessions new --name docs

acpx codex -s backend 'fix the checkout timeout'
acpx codex -s docs    'draft release notes from recent commits'
```

Sessions live side by side and resume independently.

## 6. One-shot, no saved context

Use `exec` for stateless asks:

```bash
acpx codex exec 'in 5 bullets, what does this repo do?'
acpx claude exec --file ./brief.md
```

`exec` never reads or writes a saved session record. Perfect for scripts.

## 7. Inspect what happened

```bash
acpx codex sessions               # list sessions for codex in this scope
acpx codex sessions show          # full metadata for the cwd default
acpx codex sessions history       # last 20 turn previews
acpx codex status                 # running / idle / dead / no-session
```

To remove closed records once you are done:

```bash
acpx codex sessions prune --dry-run
acpx codex sessions prune --older-than 30
```

## 8. Pipe it into your tooling

`--format json` emits one ACP JSON-RPC message per line. `--format json --json-strict` adds the guarantee that nothing else lands on stdout.

```bash
acpx --format json codex exec 'review changed files for risky patterns' \
  | jq -r 'select(.method=="session/update")'
```

Use `quiet` when you only want the final assistant text:

```bash
SUMMARY=$(acpx --format quiet codex exec 'one-line summary of this branch')
```

## 9. Lock down permissions

By default, `acpx` auto-approves reads and prompts for writes. Tighten or relax:

```bash
acpx --approve-all  codex 'apply the patch and run tests'
acpx --deny-all     codex 'analyze this code without using any tools'
acpx --non-interactive-permissions fail codex …   # fail instead of deny when no TTY
```

[Permissions](permissions.md) has the full policy table.

## Where to next

- [Sessions](sessions.md) — scope rules, queueing, soft-close, prune.
- [Prompting](prompting.md) — implicit vs explicit, stdin, `--file`, `--no-wait`.
- [Output formats](output-formats.md) — text, json, json-strict, quiet, suppress-reads.
- [Flows](flows.md) — multi-step ACP workflows when one prompt is not enough.
