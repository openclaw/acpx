# AGENTS.md — acpx

## Purpose

This file is for contributors and coding agents working in this repository.
Keep it focused on how to develop, validate, and ship `acpx`.

Use these files for the other concerns:

- [`README.md`](README.md) for user-facing install and usage
- [`docs/CLI.md`](docs/CLI.md) for CLI reference
- [`VISION.md`](VISION.md) for product direction and boundaries
- [`CONTRIBUTING.md`](CONTRIBUTING.md) for PR expectations
- [`skills/acpx/SKILL.md`](skills/acpx/SKILL.md) for agent-usage guidance

When you need implementation detail, prefer the in-repo references below
instead of expanding this file into a full technical spec.

## Repo

- GitHub: `https://github.com/openclaw/acpx`
- npm: `https://www.npmjs.com/package/acpx`
- Default branch: `main`
- Runtime: Node.js `>=22.12.0`
- Package manager: `pnpm@10.23.0`

## Product Direction

- `acpx` should be the smallest useful ACP client: a lightweight CLI that lets one
  agent talk to another agent through the Agent Client Protocol without PTY
  scraping or adapter-specific glue.
- The goal is not to build a giant orchestration layer. The goal is to make ACP
  practical, robust, and easy to compose in real workflows.
- The primary user is another agent, orchestrator, or harness. Human usability
  still matters, but it is a secondary constraint.
- `acpx` should not try to do too many things at once.
- If a feature does not make `acpx` a better ACP client or backend, it probably
  does not belong in core.
- In `acpx`, data models, config keys, keywords, flags, output shapes, and naming
  conventions are part of the product surface.
- They should be scrutinized multiple times before being added or changed.
  Convenience is not enough. Every new convention creates long-term compatibility
  cost.
- The default stance should be to add fewer conventions, make them clearer, and
  keep them stable.
- Read [`VISION.md`](VISION.md) before changing user-visible behavior or conventions.

## Setup

Install dependencies:

```bash
pnpm install
```

Run the CLI from source:

```bash
pnpm run dev -- --help
```

Build the distributable CLI:

```bash
pnpm run build
node dist/cli.js --help
```

Published install/use:

```bash
npm install -g acpx@latest
# or
npx acpx@latest --help
```

## Local Workflow

1. Make changes in `src/`, `test/`, docs, or workflow files.
2. Use `pnpm run dev -- ...` for quick manual checks.
3. Run the smallest relevant validation command while iterating.
4. Before opening or updating a PR, run the full checks for the scope you changed.

## Common Commands

- `pnpm run build` — build the distributable CLI
- `pnpm run test` — local test run without coverage gate
- `pnpm run test:coverage` — CI-equivalent test run with coverage thresholds
- `pnpm run typecheck` — TypeScript typecheck
- `pnpm run lint` — source linting plus persisted-key casing checks
- `pnpm run format:check` — formatting check
- `pnpm run check` — format, typecheck, lint, build, and coverage tests
- `pnpm run check:docs` — docs format and markdown lint
- `pnpm run perf:report` — performance reporting helper

## Fundamental acpx Calls

Use these examples when you need the most basic `acpx` flows while developing
or validating the CLI:

```bash
acpx codex sessions new
acpx codex 'fix the failing test'
acpx codex prompt 'rewrite AGENTS.md for contributors'
acpx codex exec 'summarize this repo'
acpx exec 'summarize this repo'                  # defaults to codex
acpx codex sessions list
acpx codex sessions show
acpx codex status
acpx codex cancel
acpx codex sessions new --name docs
acpx codex -s docs 'rewrite CLI docs'
acpx config show
acpx config init
acpx --format json codex exec 'review changed files'
```

## When To Run Checks

- Docs-only changes in `docs/**`, [`README.md`](README.md), or [`CONTRIBUTING.md`](CONTRIBUTING.md):
  run `pnpm run check:docs`
- Code changes in `src/**`, `test/**`, `scripts/**`, `package.json`, or workflow files:
  run `pnpm run check`
- Code plus docs changes:
  run both `pnpm run check` and `pnpm run check:docs`
- Quick iteration on runtime or test changes:
  use `pnpm run test` first, then `pnpm run check` before pushing
- Changes to flags, config, output, agent registry names, session behavior, queueing, or persistence formats:
  always run `pnpm run check`

`AGENTS.md` changes are not treated as docs-only by CI right now, so changes to
this file should be treated like regular repo changes for validation purposes.

## CI

CI lives in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

- Pull requests and pushes run against `main`
- CI first detects change scope
- Docs-only changes skip the code matrix
- Docs changes run the `Docs` job via `pnpm run check:docs`
- Non-doc changes run:
  - `pnpm run format:check`
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run build`
  - `pnpm run test:coverage`
- CI installs dependencies with `pnpm install --frozen-lockfile`
- CI uses Node 24 by default; the `Test` job runs on Node 22

## Release / CD

Release automation lives in [`.github/workflows/release.yml`](.github/workflows/release.yml).

- Releases are manual (`workflow_dispatch`)
- The workflow installs dependencies with `pnpm install --frozen-lockfile`
- It validates `package.json` release metadata before publishing
- It runs `pnpm run lint`, `pnpm run typecheck`, and `pnpm run build`
- It bumps from the latest npm version and publishes through `release-it`

The release workflow currently requires these `package.json` values:

- `author`: `OpenClaw Team <dev@openclaw.ai>`
- `repository.url`: `https://github.com/openclaw/acpx`

Do not change release metadata or publishing behavior casually.

## Key Areas

- [`src/`](src) — CLI and runtime implementation
- [`test/`](test) — Node test suite
- [`scripts/`](scripts) — repo maintenance and perf helpers
- [`README.md`](README.md) — install and usage docs
- [`docs/CLI.md`](docs/CLI.md) — full CLI reference
- [`VISION.md`](VISION.md) — product boundaries
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution workflow

## Technical References

- [`src/cli-core.ts`](src/cli-core.ts) — command handling and top-level CLI flow
- [`src/client.ts`](src/client.ts) — ACP client integration
- [`src/config.ts`](src/config.ts) — config loading and defaults
- [`src/agent-registry.ts`](src/agent-registry.ts) — built-in agent names and commands
- [`src/session-runtime.ts`](src/session-runtime.ts) and [`src/session-runtime/`](src/session-runtime) — session lifecycle and runtime behavior
- [`src/queue-ipc.ts`](src/queue-ipc.ts) and [`src/queue-ipc-server.ts`](src/queue-ipc-server.ts) — queue IPC behavior
- [`test/integration.test.ts`](test/integration.test.ts) — end-to-end CLI expectations
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — CI behavior
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — release workflow
