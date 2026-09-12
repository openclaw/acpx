# Contributing to acpx

`acpx` is a lightweight CLI and embeddable client for the Agent Client Protocol.
Read [VISION.md](VISION.md) before proposing a feature or changing a public
interface. Bugs and focused fixes are welcome; discuss larger API or architecture
changes in an [acpx issue](https://github.com/openclaw/acpx/issues) first.

## Development

Use the Node.js source-build versions and pnpm version listed in
[AGENTS.md](AGENTS.md#repo). Install the locked dependencies, then run the CLI:

```bash
pnpm install --frozen-lockfile
pnpm run dev -- --help
```

The source is in `src/`, the Node test suite is in `test/`, and protocol
conformance cases are in `conformance/`. The replay viewer and sample workflows
live in `examples/flows/`. See [AGENTS.md](AGENTS.md) for commands, dependency
boundaries, and repository policies.

## Before opening a pull request

Keep each PR focused on one problem. Explain the trigger, the resulting behavior,
and why the change belongs in acpx. Use a conventional title such as `fix:`,
`refactor:`, or `docs:`. Keep maintainer edits enabled so maintainers can help land
the change.

Start with the smallest relevant test while iterating. Before requesting review:

- For code, tests, scripts, package metadata, workflows, or `AGENTS.md`, run
  `pnpm run check`.
- For documentation changes, run `pnpm run check:docs`; run both commands when
  changing code and docs together. The docs script checks the README, docs site,
  and flow example guides. For other Markdown, also pass each changed file to
  `pnpm exec oxfmt --check` and `pnpm exec markdownlint-cli2`.
- For changes to CLI flags, run `pnpm run mutate` as well.
- Exercise the built CLI or public runtime on the affected path and record the
  commands and results in the PR. Bug fixes should include a regression test.
- For non-trivial code changes, run the repository's isolated autoreview helper:
  `.agents/skills/autoreview/scripts/autoreview`. Verify its findings and address
  actionable problems before requesting review.
- Ensure CI passes. For visual changes, include before/after screenshots using
  synthetic data and check that the captures contain no secrets or private data.

The CLI, runtime exports, flags, configuration keys, session records, and output
formats are compatibility surfaces. Preserve existing behavior during refactors;
explain intentional behavior changes and update the relevant documentation.
Maintainers add user-facing changelog entries when landing contributions.

## Agent documentation

Keep built-in agent documentation and examples consistent with
[AGENTS.md](AGENTS.md#documentation-policy). A change to a built-in agent or its
behavior must update both its `agents/{Agent}.md` guide and
[`skills/acpx/SKILL.md`](skills/acpx/SKILL.md). Shared landing documentation should
remain impartial and follow the repository's example ordering.

## Review follow-through

Handle review conversations on your PR, including automated reviews. After
addressing a finding, reply with the change or evidence and resolve the
conversation. Leave it open when a maintainer or reviewer decision is still
needed. AI-assisted contributions follow the same correctness, testing, and
review expectations as other contributions.

## Reporting bugs and vulnerabilities

File reproducible bugs in [acpx issues](https://github.com/openclaw/acpx/issues).
Include the acpx version, Node.js version, operating system, adapter, command,
expected behavior, and actual result. Remove credentials and private conversation
content from logs and session files before sharing them.

For security vulnerabilities, email **security@openclaw.ai** instead of opening a
public issue. Include the affected acpx version, reproduction steps, demonstrated
impact, and any proposed remediation.
