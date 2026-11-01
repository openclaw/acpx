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

These 30 built-in launch profiles share one command shape. Each guide covers the required CLI or adapter, authentication, and capability limits. Ante is experimental.

|                                                              | Agent                                                                                    | Command                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------- |
| ![Pi](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/pi.png)                             | [Pi](https://github.com/openclaw/acpx/blob/main/agents/Pi.md)                            | `acpx pi …`               |
| ![OpenClaw](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/openclaw.png)                 | [OpenClaw](https://github.com/openclaw/acpx/blob/main/agents/OpenClaw.md)                | `acpx openclaw …`         |
| ![Codex](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/codex.png)                       | [Codex](https://github.com/openclaw/acpx/blob/main/agents/Codex.md)                      | `acpx codex …`            |
| ![Claude Code](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/claude.png)                | [Claude Code](https://github.com/openclaw/acpx/blob/main/agents/Claude.md)               | `acpx claude …`           |
| ![Gemini CLI](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/gemini.png)                 | [Gemini CLI](https://github.com/openclaw/acpx/blob/main/agents/Gemini.md)                | `acpx gemini …`           |
| ![Cursor](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/cursor.png)                     | [Cursor](https://github.com/openclaw/acpx/blob/main/agents/Cursor.md)                    | `acpx cursor …`           |
| ![GitHub Copilot](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/copilot.png)            | [GitHub Copilot](https://github.com/openclaw/acpx/blob/main/agents/Copilot.md)           | `acpx copilot …`          |
| ![Ante](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/ante.png)                         | [Ante](https://github.com/openclaw/acpx/blob/main/agents/Ante.md)                        | `acpx ante …`             |
| ![Antigravity](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/antigravity.png)           | [Antigravity](https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md)          | `acpx antigravity …`      |
| ![DeepSeek Harness](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/deepseek-harness.png) | [DeepSeek Harness](https://github.com/openclaw/acpx/blob/main/agents/DeepSeekHarness.md) | `acpx deepseek-harness …` |
| ![Devin](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/devin.png)                       | [Devin](https://github.com/openclaw/acpx/blob/main/agents/Devin.md)                      | `acpx devin …`            |
| ![Factory Droid](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/droid.png)               | [Factory Droid](https://github.com/openclaw/acpx/blob/main/agents/Droid.md)              | `acpx droid …`            |
| ![fast-agent](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/fast-agent.png)             | [fast-agent](https://github.com/openclaw/acpx/blob/main/agents/FastAgent.md)             | `acpx fast-agent …`       |
| ![fx](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/fx.png)                             | [fx](https://github.com/openclaw/acpx/blob/main/agents/Fx.md)                            | `acpx fx …`               |
| ![Grok Build](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/grok-build.png)             | [Grok Build](https://github.com/openclaw/acpx/blob/main/agents/GrokBuild.md)             | `acpx grok-build …`       |
| ![Goose](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/goose.png)                       | [Goose](https://github.com/openclaw/acpx/blob/main/agents/Goose.md)                      | `acpx goose …`            |
| ![iFlow](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/iflow.png)                       | [iFlow](https://github.com/openclaw/acpx/blob/main/agents/Iflow.md)                      | `acpx iflow …`            |
| ![Junie](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/junie.png)                       | [Junie](https://github.com/openclaw/acpx/blob/main/agents/Junie.md)                      | `acpx junie …`            |
| ![Kilocode](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/kilocode.png)                 | [Kilocode](https://github.com/openclaw/acpx/blob/main/agents/Kilocode.md)                | `acpx kilocode …`         |
| ![Kimi](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/kimi.png)                         | [Kimi](https://github.com/openclaw/acpx/blob/main/agents/Kimi.md)                        | `acpx kimi …`             |
| ![Kiro](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/kiro.png)                         | [Kiro](https://github.com/openclaw/acpx/blob/main/agents/Kiro.md)                        | `acpx kiro …`             |
| ![MCode](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/mcode.png)                       | [MCode](https://github.com/openclaw/acpx/blob/main/agents/MCode.md)                      | `acpx mcode …`            |
| ![Mux](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/mux.png)                           | [Mux](https://github.com/openclaw/acpx/blob/main/agents/Mux.md)                          | `acpx mux …`              |
| ![Octomind](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/octomind.png)                 | [Octomind](https://github.com/openclaw/acpx/blob/main/agents/Octomind.md)                | `acpx octomind …`         |
| ![OpenCode](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/opencode.png)                 | [OpenCode](https://github.com/openclaw/acpx/blob/main/agents/OpenCode.md)                | `acpx opencode …`         |
| ![Poolside](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/pool.png)                     | [Poolside](https://github.com/openclaw/acpx/blob/main/agents/Pool.md)                    | `acpx pool …`             |
| ![Qoder](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/qoder.png)                       | [Qoder](https://github.com/openclaw/acpx/blob/main/agents/Qoder.md)                      | `acpx qoder …`            |
| ![Qwen Code](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/qwen.png)                    | [Qwen Code](https://github.com/openclaw/acpx/blob/main/agents/Qwen.md)                   | `acpx qwen …`             |
| ![Trae](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/trae.png)                         | [Trae](https://github.com/openclaw/acpx/blob/main/agents/Trae.md)                        | `acpx trae …`             |
| ![ZeroClaw](https://raw.githubusercontent.com/openclaw/acpx/main/docs/assets/agents/zeroclaw.png)                 | [ZeroClaw](https://github.com/openclaw/acpx/blob/main/agents/ZeroClaw.md)                | `acpx zeroclaw …`         |

Need another ACP server? Use `acpx --agent '<command>' …` or configure a [custom agent](docs/custom-agents.md). See the [agent registry](docs/agents.md) for adapter commands and aliases. [Logo credits](docs/assets/agents/README.md).

## Sessions and one-shot runs

Persistent sessions keep context between prompts, support parallel named workstreams, and queue follow-up prompts when a turn is already running. Use `exec` when you want a stateless run with no saved session.

```bash
acpx codex sessions new --name backend
acpx codex -s backend "trace the checkout timeout"
acpx codex exec "summarize this repository"
acpx --model gpt-5.4 codex exec --config-option reasoning_effort=high "review this repository"
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

Use [`createSharedAcpRuntime()`](docs/shared-sessions.md) when an application and CLI processes need to share one local session owner.

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
