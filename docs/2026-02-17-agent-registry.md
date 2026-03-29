---
title: acpx Agent Registry
description: Built-in agent mappings, name resolution rules, and custom adapter usage with --agent.
author: Bob <bob@dutifulbob.com>
date: 2026-02-17
---

## Built-in registry

`src/agent-registry.ts` defines friendly names such as:

- `pi -> npx pi-acp`
- `openclaw -> openclaw acp`
- `codex -> npx @zed-industries/codex-acp`
- `claude -> npx -y @agentclientprotocol/claude-agent-acp`

The built-in agents table lives in [../README.md](../README.md). Additional built-in agent docs live under [../agents/README.md](../agents/README.md).

Default agent is `codex`.

## Resolution behavior

When you run `acpx <agent> ...`:

1. agent token is normalized (trim + lowercase)
2. if it matches a built-in key, `acpx` uses the mapped command
3. if it does not match, `acpx` treats it as a raw command

This means custom names work without any registry file edits.

`factory-droid` and `factorydroid` are built-in aliases for `droid`, so they
resolve to the same `droid exec --output-format acp` command.

## `--agent` escape hatch

`--agent <command>` forces a raw adapter command and bypasses positional agent resolution.

Example:

```bash
acpx --agent ./my-custom-acp-server 'summarize this repo'
```

Rules:

- do not combine a positional agent with `--agent`
- the command string is parsed into executable + args before spawn
- the chosen command is what session scoping uses

## Practical guidance

Use the built-ins documented in `src/agent-registry.ts`. For the full supported-agents list and additional built-in agent docs, see [../README.md](../README.md) and [../agents/README.md](../agents/README.md).
Use `--agent` when you need:

- local development adapters
- repo-local OpenClaw bridge commands such as `pnpm openclaw acp --session agent:main:main`
- pinned binaries/scripts
- non-standard ACP servers
