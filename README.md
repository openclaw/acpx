# acpx 🤝 — Agents talking to agents, minus the terminal séance

<p align="center">
  <img src="acpx_banner.svg" alt="acpx banner" width="100%" />
</p>

[![CI](https://img.shields.io/github/actions/workflow/status/openclaw/acpx/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/openclaw/acpx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/acpx?style=flat-square)](https://www.npmjs.com/package/acpx)
[![Node.js](https://img.shields.io/node/v/acpx?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/openclaw/acpx?style=flat-square)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/acpx?style=flat-square)](https://www.npmjs.com/package/acpx)

`acpx` is a headless command-line client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). It gives agents, orchestrators, and developers one structured interface for persistent sessions, one-shot runs, permissions, and machine-readable output across ACP-compatible coding agents.

```console
$ acpx codex sessions new
<session-id>
$ acpx codex "summarize this repository"
[tool] Read README.md (completed)
This repository contains ...
[done] end_turn
```

> [!NOTE]
> `acpx` is pre-1.0. Treat its CLI and runtime interfaces as evolving.

## Install

Install the published npm package globally:

```bash
npm install -g acpx@latest
```

`acpx` requires Node.js 22.13 or newer. To try it without a global install, prefix a command with `npx acpx@latest` instead. See the [install guide](docs/install.md) for adapter prerequisites, updates, and source builds.

## Quick start

Install and authenticate the coding agent you want to use, then create a session in your project and send it a prompt:

```bash
acpx codex sessions new
acpx codex "find the slowest test and explain why"
```

The session is scoped to the current repository and persists across invocations. Creating sessions explicitly prevents automation from starting an unexpected conversation. The [quickstart](docs/quickstart.md) continues with named sessions, one-shot runs, history, and JSON output.

## Choose an agent

Use the same command shape with the built-in launch profiles:

| Agent             | Command                      |
| ----------------- | ---------------------------- |
| Codex             | `acpx codex …`               |
| Claude Code       | `acpx claude …`              |
| Gemini CLI        | `acpx gemini …`              |
| OpenClaw          | `acpx openclaw …`            |
| Custom ACP server | `acpx --agent '<command>' …` |

The upstream agent must be installed and authenticated when its adapter does not provide that itself. See [built-in agents](docs/agents.md) for every supported profile and [custom agents](docs/custom-agents.md) for registry configuration.

## Sessions and one-shot runs

Persistent sessions keep context between prompts, support parallel named workstreams, and queue follow-up prompts when a turn is already running. Use `exec` when you want a stateless run with no saved session.

```bash
acpx codex sessions new --name backend
acpx codex -s backend "trace the checkout timeout"
acpx codex exec "summarize this repository"
```

Session state lives under `~/.acpx/`. The [sessions guide](docs/sessions.md) covers scope, queue ownership, reconnects, export/import, cancellation, and cleanup.

## Automation and permissions

Text output is the default. `--format json` emits NDJSON ACP events for automation, while `--format quiet` prints only the final assistant text. Output events retain structured thinking, tool calls, diffs, and completion state instead of terminal escape sequences.

Permission modes range from read approval to explicit deny or approve-all policies. Use `--cwd` to set the session scope and filesystem boundary. Global and project JSON configuration can provide defaults; command-line flags take precedence.

- [Output formats](docs/output-formats.md)
- [Permissions](docs/permissions.md)
- [Configuration](docs/config.md)
- [Exit codes](docs/exit-codes.md)

## Flows and embedding

For multi-step work, `acpx flow run` executes TypeScript workflows that combine ACP turns with deterministic actions, decisions, computation, and checkpoints. The package also exports `acpx/runtime` and `acpx/flows` for applications that need session and workflow primitives without shelling out.

Start with the [flows guide](docs/flows.md), then use the [examples](examples/flows/README.md) and [architecture notes](docs/2026-03-25-acpx-flows-architecture.md) for deeper integrations.

## Documentation

- [CLI reference](docs/CLI.md) — commands, flags, and behavior
- [Prompting](docs/prompting.md) — arguments, stdin, files, and queueing
- [Session controls](docs/session-control.md) — cancel, modes, options, and status
- [Compare agents](docs/compare.md) — run one prompt across multiple agents
- [ACP coverage](docs/2026-02-19-acp-coverage-roadmap.md) — implemented protocol methods
- [Vision](VISION.md) — project scope and design principles

The full documentation is also available at [acpx.sh](https://acpx.sh/).

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:docs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and review guidance.

## License

MIT. See [LICENSE](LICENSE).
