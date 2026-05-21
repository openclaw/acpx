---
title: Custom agents
description: Run any ACP-capable server through acpx — unknown positional names, --agent escape hatch, and config-defined custom agents.
---

`acpx` does not require an agent to be in the built-in registry. Any ACP-capable command can be the agent.

There are three ways to use a custom agent.

## 1. Unknown positional name

If you type a positional agent token that is not a built-in friendly name, `acpx` treats it as a raw command:

```bash
acpx my-agent 'review this patch'
acpx my-agent prompt 'do the thing'
acpx my-agent exec 'one-shot ask'
acpx my-agent sessions
```

The literal string `my-agent` becomes the spawn command. This is useful when you have an ACP server already on `PATH` under a name that is not a built-in.

## 2. `--agent <command>` escape hatch

For ad-hoc commands or paths with arguments and quoting, use `--agent`:

```bash
acpx --agent ./bin/my-custom-acp-server 'do something'
acpx --agent 'node ./scripts/acp-dev-server.mjs --mode ci' exec 'summarize changes'
```

Rules:

- Do not combine `--agent` with a positional agent token in the same command. That is a usage error.
- The resolved command string becomes the session scope key (`agentCommand`). Two different command strings are two different sessions, even if the underlying binary is the same.
- Empty commands and unterminated quoting are rejected as usage errors.

## 3. Config-defined agents

For commands you use repeatedly, define them in [`~/.acpx/config.json`](config.md#the-agents-map):

```json
{
  "agents": {
    "ci-bot": {
      "command": "node ./scripts/ci-acp-bridge.mjs",
      "args": ["--profile", "internal"]
    }
  }
}
```

Then call by friendly name:

```bash
acpx ci-bot 'run validation checks'
```

Custom names defined in config win over the built-in registry, so you can also override `codex`, `claude`, etc. with a vendored adapter.

## Session scope and the agent command

The agent command — whether built-in, unknown positional, `--agent`, or config-defined — is part of the session scope key:

```text
(agentCommand, absoluteCwd, optional name)
```

Practical implication: switching from `acpx --agent ./bin/v1` to `acpx --agent ./bin/v2` in the same repo gives you two independent session histories, not one shared session. Use a config entry with a stable friendly name to keep history continuous across binary upgrades.

## ACP requirements for custom agents

A custom agent must:

- Speak ACP over stdio (or whatever transport the adapter supports — most are stdio).
- Implement the standard ACP methods (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/resume` or `session/load`, `session/close`).
- Advertise `agentCapabilities` and `availableModels` honestly. `--model <id>` requires `availableModels` to include the requested id, and `set model <id>` calls `session/set_model`.

`fs/*` and `terminal/*` client methods are stable on the `acpx` side and respect cwd sandboxing — your adapter can request file reads, writes, and terminal calls and they will be routed through `acpx`'s permission policy.

## Practical examples

Local dev server with arguments:

```bash
acpx --agent 'node --inspect ./scripts/dev-acp.mjs --port 5555' \
     codex sessions new
```

Wait — that runs through `--agent`, so `codex` would be a positional agent and conflict. The right form is one or the other:

```bash
acpx --agent 'node ./scripts/dev-acp.mjs' sessions new
acpx --agent 'node ./scripts/dev-acp.mjs' 'run a sanity check'
```

Per-repo override with config:

`<repo>/.acpxrc.json`:

```json
{
  "agents": {
    "internal": {
      "command": "/opt/internal/acp-bridge",
      "args": ["--profile", "stable"]
    }
  }
}
```

Then everywhere in that repo:

```bash
acpx internal sessions new
acpx internal 'review the latest commit'
acpx internal exec 'list TODO comments'
```

OpenClaw repo-local checkout (the canonical "override a built-in" example):

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node scripts/run-node.mjs acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```

## See also

- [Agents](agents.md) — built-in registry.
- [Config](config.md) — the `agents` map and precedence rules.
- [Sessions](sessions.md) — how the agent command participates in scope keys.
