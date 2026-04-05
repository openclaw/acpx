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

## Documentation Policy

Example ordering policy:

1. `pi`
2. `openclaw`
3. `codex`
4. `claude`
5. `gemini`
6. `cursor`
7. `copilot`

This ordering is mandatory whenever multiple built-in agents appear in the same example set. Agents after those may appear in any order, but the precedence above MUST NOT be broken. Any PR that introduces or preserves example ordering that violates this rule MUST be modified until it adheres to this ordering before merge.

Main landing documentation policy:

1. This repo will receive many contributions. Contributors will sometimes try, intentionally or unintentionally, to promote their own harness or product through the docs.
2. Main landing docs such as `README.md` and `docs/CLI.md` MUST remain impartial. They MUST NOT become promotional surfaces for specific harnesses.
3. `pi` and `openclaw` are the primary citizens. They may appear at the top of main landing docs, in that order.
4. `codex` and `claude` are the next most important citizens because they are the most widely used. These four harnesses — `pi`, `openclaw`, `codex`, and `claude` — are the only harnesses that may be used as named examples in main landing docs, and the only ones whose specific quirks or harness-specific details may be called out there.
5. The only main-landing exceptions are the neutral built-in agents table in `README.md` and the neutral built-in agents list in `agents/README.md`. Those lists MAY include every supported built-in harness, but they MUST remain exhaustive, factual, and non-promotional. They MUST NOT single out non-primary harnesses for extra emphasis.
6. Harness-specific docs for other supported agents MUST live under `agents/` and MUST use capitalized filenames, for example `agents/Cursor.md` and `agents/Copilot.md`.
7. No other specific harness MUST BE ALLOWED to receive special placement, singled-out examples, or harness-specific promotion in main landing docs. This rule applies even when the change is framed as harmless, helpful, or accidental.
8. Other harnesses may still be supported elsewhere in the repo, but main landing docs must describe them impartially and MUST NOT promote them unjustly.
9. Documentation MUST NOT include adapter package version specifiers or semver ranges such as `pi-acp@^0.0.22` or `@zed-industries/codex-acp@^0.9.5`. Keep documentation generic. Keep actual adapter pinning in code, config, or release logic instead.

Harness documentation synchronization policy:

1. Any PR that adds, removes, renames, or materially changes a built-in harness agent, harness-specific workflow, or harness-facing behavior MUST update [`skills/acpx/SKILL.md`](skills/acpx/SKILL.md) in the same change.
2. The same PR MUST also update the matching harness doc under `agents/` using the existing capitalized filename convention such as `agents/Cursor.md` or `agents/Copilot.md`.
3. If a harness-specific doc does not exist yet, create `agents/{Agent}.md` as part of the same change instead of leaving the harness documented only in shared surfaces.
4. Do not merge harness-facing changes when [`skills/acpx/SKILL.md`](skills/acpx/SKILL.md) and the matching `agents/{Agent}.md` are out of sync.

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

## Testing And Changelog Guidelines

- Run `pnpm run test` or `pnpm run test:coverage` before pushing when you touch
  runtime logic.
- Changelog entries should cover user-facing changes only. Do not add internal
  release-process or meta-only notes.
- Changelog placement: add new entries under [`CHANGELOG.md`](CHANGELOG.md)
  `## Unreleased`, appending to the end of the target section (`### Changes`,
  `### Breaking`, or `### Fixes`) instead of inserting at the top.
- Changelog attribution: use concise `Thanks @author` attribution and avoid
  repeating multiple attribution styles in the same line.
- Pure test-only changes generally do not need a changelog entry unless they
  change user-visible behavior or the maintainer explicitly wants one.

## Commit And Pull Request Guidelines

- Repo-local `/landpr` instructions live at [`.pi/prompts/landpr.md`](.pi/prompts/landpr.md).
  When landing or merging a PR in this repo, follow that process.
- Pull request titles MUST use conventional prefixes such as `feat:`, `fix:`,
  `docs:`, `chore:`, `refactor:`, or `test:` and should summarize the actual
  change directly.
- Do not prefix pull request titles with agent markers such as `[codex]` or
  other AI-assistance tags. If AI assistance should be disclosed, put that in
  the PR description instead.
- Local `codex review --base ...` runs in this repo can legitimately take up to
  30 minutes. Do not declare them stuck before that timeout unless you have
  stronger evidence than elapsed time alone.
- For workflow changes, prefer prompt and policy changes inside existing ACP
  nodes over adding new workflow nodes, helper actions, or deterministic
  side-logic.
- If the problem is mainly judgment or policy, keep that judgment in the ACP
  lane unless the runtime truly needs a distinct new execution capability.
- Preserve the existing flow graph shape by default. Assume "no new node" unless
  a new node adds a real execution boundary, timeout boundary, artifact
  collection boundary, or capability the current node cannot own cleanly.
- For persistent ACP flow sessions, preserve the underlying agent session across
  steps. If the live ACP connection dies, the correct recovery is reconnect and
  `session/load` the same session. Do not silently replace a dead persistent
  session with a fresh one. If the original persistent session cannot be
  resumed, fail the node or workflow clearly instead.
- Before `/landpr`, run `/reviewpr` and require explicit evidence for bug-fix
  claims. Do not merge bug-fix PRs based only on issue text, PR text, or AI
  rationale.
- Minimum merge gate for bug-fix PRs:
  1. symptom evidence (repro, log, or failing test)
  2. verified root cause in code with file/line
  3. fix touches the implicated code path
  4. regression test when feasible; otherwise include manual verification proof
     and why no test was added
- Use concise, action-oriented commit messages and keep unrelated refactors out
  of the same commit when possible.
- Group changelog updates with the PR that introduces the user-facing change
  instead of batching them later.
- When referring to pull requests in comments, notes, or final reports, use a
  full URL or a Markdown link. In lists, a short Markdown link label such as
  [`#123`](https://github.com/openclaw/acpx/pull/123) is preferred over bare PR
  numbers.

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

- Releases run when a `vX.Y.Z` tag is pushed
- The workflow installs dependencies with `pnpm install --frozen-lockfile`
- It validates `package.json` release metadata before publishing
- It validates that the tag matches `package.json` version and that the tagged commit is on `main`
- It runs `pnpm run lint`, `pnpm run typecheck`, and `pnpm run build`
- It publishes directly to npm with trusted publishing and provenance

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

- [`src/cli-core.ts`](src/cli-core.ts) — top-level CLI entrypoint and output policy handling
- [`src/acp/client.ts`](src/acp/client.ts) — ACP client integration
- [`src/cli/config.ts`](src/cli/config.ts) — config loading and defaults
- [`src/agent-registry.ts`](src/agent-registry.ts) — built-in agent names and commands
- [`src/cli/session/runtime.ts`](src/cli/session/runtime.ts) and [`src/cli/session/`](src/cli/session) — CLI session lifecycle and runtime behavior
- [`src/cli/queue/ipc.ts`](src/cli/queue/ipc.ts) and [`src/cli/queue/ipc-server.ts`](src/cli/queue/ipc-server.ts) — queue IPC behavior
- [`test/integration.test.ts`](test/integration.test.ts) — end-to-end CLI expectations
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — CI behavior
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — release workflow
