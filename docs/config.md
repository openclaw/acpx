---
title: Config
description: Global and project JSON config files, supported keys, precedence rules, the agents map, and authentication via env or config.
---

`acpx` is configurable through two JSON files. CLI flags always win over config, and project config wins over global.

## Files and precedence

```text
1. Global   ~/.acpx/config.json
2. Project  <cwd>/.acpxrc.json
3. CLI flags
```

Each layer is a partial override merged on top of the previous one. Missing keys inherit; arrays and objects are replaced, not deep-merged (with the exception of the `agents` map, where keys merge and per-agent objects replace wholesale).

Inspect the resolved view:

```bash
acpx config show
```

Create a global template (only writes if the file does not already exist):

```bash
acpx config init
```

## Supported keys

```json
{
  "defaultAgent": "codex",
  "defaultPermissions": "approve-all",
  "nonInteractivePermissions": "deny",
  "authPolicy": "skip",
  "ttl": 300,
  "timeout": null,
  "format": "text",
  "mcpServers": [
    {
      "name": "local-tools",
      "type": "stdio",
      "command": "./bin/mcp-server"
    }
  ],
  "agents": {
    "my-custom": { "command": "./bin/my-acp-server", "args": ["acp"] }
  },
  "auth": {
    "openai_api_key": "sk-…"
  }
}
```

| Key                         | Type             | Default           | Notes                                                                                              |
| --------------------------- | ---------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `defaultAgent`              | string           | `"codex"`         | Used when top-level `prompt`, `exec`, `cancel`, `set*`, `sessions` runs without an explicit agent. |
| `defaultPermissions`        | enum             | `"approve-reads"` | `approve-all` / `approve-reads` / `deny-all`.                                                      |
| `nonInteractivePermissions` | enum             | `"deny"`          | `deny` or `fail` when no TTY is present.                                                           |
| `authPolicy`                | enum             | `"skip"`          | Controls when ACP `authenticate` is attempted.                                                     |
| `ttl`                       | integer          | `300`             | Queue owner idle TTL in seconds. `0` disables idle shutdown.                                       |
| `timeout`                   | number \| `null` | `null`            | Default `--timeout` in seconds (decimal allowed).                                                  |
| `format`                    | enum             | `"text"`          | Default `--format`.                                                                                |
| `mcpServers`                | array            | `[]`              | MCP servers sent to new and loaded ACP sessions. Project values replace global values.             |
| `agents`                    | object           | `{}`              | Override or add agent commands (see below).                                                        |
| `auth`                      | object           | `{}`              | ACP auth-method credential map (see below).                                                        |

CLI flags always override these values. For example, `--approve-all` wins over `defaultPermissions: "deny-all"`.

Use `--mcp-config <path>` when MCP servers belong to a session or automation job rather than the
working tree. The file must contain the same top-level `mcpServers` array shown above; it replaces
the project/global `mcpServers` value for that invocation. Relative paths resolve from `--cwd`.

```bash
acpx --cwd /workspace --mcp-config /run/job-mcp.json codex 'use the configured tools'
```

An existing persistent session cannot switch MCP configurations while its queue owner is live.
Close that session first, then retry with the new `--mcp-config` file.

## The `agents` map

Custom agents and overrides live here:

```json
{
  "agents": {
    "my-agent": {
      "command": "./bin/my-acp-server",
      "args": ["acp", "--profile", "ci"]
    },
    "codex": {
      "command": "/usr/local/bin/codex-acp",
      "args": ["--mode", "stable"]
    }
  }
}
```

Rules:

- Keys are friendly names you would type at `acpx <name> …`.
- `command` is required; it can be a single executable or include in-string args (`"node ./bin/x.mjs"`).
- `args` is optional. If present, it is appended after the parsed `command` tokens.
- Custom agent `args` arrays are honored — required adapter sub-commands are no longer dropped silently.
- An entry that shares a name with a built-in **replaces** the built-in for that name.

Project config can shadow global config by re-declaring the same key:

```json
{ "agents": { "codex": { "command": "/usr/local/bin/codex-acp" } } }
```

Use this to point a particular repo at a vendored or pinned adapter.

## Authentication

ACP `authenticate` handshakes need credentials. `acpx` resolves them from two sources, in order:

1. `ACPX_AUTH_<METHOD_ID>` environment variable, where `<METHOD_ID>` is the upper-cased ACP auth-method id.
2. `auth.<methodId>` value in config.

```bash
ACPX_AUTH_OPENAI_API_KEY=sk-… acpx codex 'do the thing'
```

```json
{ "auth": { "openai_api_key": "sk-…" } }
```

Ambient provider env vars like `OPENAI_API_KEY` are still passed through to child agents in their environment, but they do **not** trigger ACP auth-method selection on their own. This is intentional — it avoids surprise login flows in adapters that interpret an ambient key as "go ahead and authenticate."

When an adapter advertises auth methods, `acpx` invokes `authenticate` if it
finds a matching `ACPX_AUTH_*` environment variable or `auth` config value.
`authPolicy` controls what happens when no matching credential is available:

| Value    | Behavior                                                                                  |
| -------- | ----------------------------------------------------------------------------------------- |
| `"skip"` | Continue without ACP authentication and let the adapter handle auth itself. **(default)** |
| `"fail"` | Fail immediately instead of continuing without a matching ACP credential.                 |

## Environment variables

`ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` makes built-in `claude` sessions include
Claude Code user settings. By default, they load only project and local settings
to avoid globally enabled channel or daemon plugins interfering with spawned ACP
sessions.

Other ACP-relevant behavior:

- Session storage path is derived from the OS home directory (`~/.acpx/sessions`).
- Child adapter processes inherit the current environment by default.
- Some adapters look at their own env vars (e.g., `QODER_PERSONAL_ACCESS_TOKEN`) — see [Agents](agents.md) for per-adapter notes.

## Practical config recipes

### Make CI fail rather than deny

```json
{
  "defaultPermissions": "approve-reads",
  "nonInteractivePermissions": "fail",
  "format": "json"
}
```

### Default to Claude with a longer timeout

```json
{
  "defaultAgent": "claude",
  "timeout": 1800,
  "ttl": 0
}
```

### Vendor an internal Codex build for one repo

`<repo>/.acpxrc.json`:

```json
{
  "agents": {
    "codex": {
      "command": "/opt/internal/codex-acp",
      "args": ["--profile", "internal-stable"]
    }
  }
}
```

### Pin a custom agent name without colliding with a built-in

```json
{
  "agents": {
    "ci-bot": {
      "command": "node ./scripts/ci-acp-bridge.mjs"
    }
  }
}
```

Then `acpx ci-bot 'run sanity checks'` resolves through the registry without any `--agent` flag.

## See also

- [Agents](agents.md) — built-in registry and per-agent notes.
- [Custom agents](custom-agents.md) — `--agent` escape hatch and unknown positional names.
- [Permissions](permissions.md) — `defaultPermissions` and non-interactive policy.
- [Output formats](output-formats.md) — `format` default and `--json-strict`.
