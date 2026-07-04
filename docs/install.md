---
title: Install
description: Install acpx globally with npm, run it ad-hoc with npx, or build from source. Covers Node version, PATH, and updating.
---

`acpx` is published to npm as [`acpx`](https://www.npmjs.com/package/acpx). It is a single Node CLI — no service to host, no daemon to manage. Session state lives under `~/.acpx/`.

## Requirements

- Node.js **22.13 or newer** (see `engines.node` in `package.json`)
- pnpm **10.33.2** for source builds
- The underlying coding agent CLI you plan to talk to (Codex, Claude, etc.)

If pnpm is not installed yet, use npm:

```bash
npm install -g pnpm@10.33.2
```

Some older Corepack builds bundled with supported Node.js versions have stale
package-signing keys and fail while preparing current pnpm releases. Installing
pnpm with npm avoids that bootstrap failure.

`acpx` itself does not need a global install of every adapter. Built-in adapters that ship as npm packages (`pi-acp`, `@agentclientprotocol/codex-acp`, `@agentclientprotocol/claude-agent-acp`, `@kilocode/cli`, `opencode-ai`, `mux`) are auto-fetched with `npx` on first use. The `fast-agent` built-in uses `uvx fast-agent-mcp acp`, so it requires `uvx` on `PATH`. Native CLI built-ins require their upstream CLI to be installed and authenticated separately.

## Global install (recommended)

```bash
npm install -g acpx@latest
```

Verify:

```bash
acpx --version
acpx --help
```

Global install is the default for most workflows because it keeps queue owners and persistent sessions warm between invocations.

## Run without installing

```bash
npx acpx@latest codex 'fix the failing tests'
```

`npx` works for one-off use but pays a small startup cost on every invocation. For repeated session reuse, prefer the global install.

## Update

```bash
npm install -g acpx@latest
```

Check what changed in the [changelog](https://github.com/openclaw/acpx/blob/main/CHANGELOG.md). Pre-1.0 releases can break CLI/runtime surface area between minor versions.

## Where data lives

| Path                          | What it stores                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `~/.acpx/sessions/*.json`     | Persistent session records (scope key, last prompt, history previews, model, options) |
| `~/.acpx/queues/<hash>.sock`  | Unix socket for active queue owners (named pipe on Windows)                           |
| `~/.acpx/queues/<hash>.lock`  | Ownership lock file                                                                   |
| `~/.acpx/flows/runs/<runId>/` | Persisted flow run bundles (graph state, ACP transcripts, artifacts)                  |
| `~/.acpx/config.json`         | Optional global config (see [Config](config.md))                                      |
| `<cwd>/.acpxrc.json`          | Optional project config (merged on top of global, CLI flags still win)                |

Queue and IPC directories are created with owner-only permissions. `acpx` re-tightens permissions on previously-permissive directories at startup.

## Build from source

For development or to test an unreleased branch:

```bash
git clone https://github.com/openclaw/acpx.git
cd acpx
npm install -g pnpm@10.33.2 # if pnpm is not already installed
pnpm install
pnpm run build
node dist/cli.js --help
```

Run during development without rebuilding:

```bash
pnpm dev codex 'fix the tests'
```

See [`CONTRIBUTING.md`](https://github.com/openclaw/acpx/blob/main/CONTRIBUTING.md) for tests, lint, and the conformance suite.

## Tell your agent about acpx

If you are configuring an upstream coding agent (Pi, OpenClaw, Claude Code) to delegate work through `acpx`, paste this block into its harness instructions:

```text
I want you to use acpx to run coding agents over the Agent Client Protocol
(ACP) instead of scraping PTY sessions. Please do the following:

1. Install acpx globally (recommended) or use npx:
   npm install -g acpx@latest

2. For Pi or OpenClaw, use the reference URL below. For Codex-style skill
   installation, install the acpx skill so you have the full reference
   available:
   npx acpx@latest --skill install acpx --agent codex --scope user
   Use --agent claude for Claude Code. For another harness not listed by
   --skill install --help, use the reference URL below instead.

3. Read the acpx skill reference so you know every command, flag, and
   workflow pattern:
   https://raw.githubusercontent.com/openclaw/acpx/main/skills/acpx/SKILL.md

4. Full CLI reference with all options and examples:
   https://acpx.sh/CLI.html

From now on, when you need to delegate work to a coding agent, use acpx
instead of spawning raw terminal sessions.
```

## Next steps

- [Quickstart](quickstart.md) — your first persistent session in two minutes.
- [Agents](agents.md) — every built-in agent name and what it wraps.
- [Config](config.md) — global + project JSON config.
