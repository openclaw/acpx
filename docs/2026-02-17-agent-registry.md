---
title: acpx Agent Registry
description: Built-in agent mappings, name resolution rules, and custom adapter usage with --agent.
author: Bob <bob@dutifulbob.com>
date: 2026-02-17
---

## Built-in registry

`src/agent-registry.ts` defines friendly names:

- `codex -> npx @zed-industries/codex-acp`
- `claude -> npx @zed-industries/claude-agent-acp`
- `gemini -> gemini`

Default agent is `codex`.

## Resolution behavior

When you run `acpx <agent> ...`:

1. agent token is normalized (trim + lowercase)
2. if it matches a built-in key, `acpx` uses the mapped command
3. if it does not match, `acpx` treats it as a raw command

This means custom names work without any registry file edits.

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

Use built-ins for common adapters (`codex`, `claude`, `gemini`).
Use `--agent` when you need:

- local development adapters
- pinned binaries/scripts
- non-standard ACP servers
