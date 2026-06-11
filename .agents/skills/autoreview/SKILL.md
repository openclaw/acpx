---
name: autoreview
description: "Autoreview closeout: local dirty changes, PR branch vs main, parallel acpx checks."
---

# Autoreview

Run Codex's built-in code review as a closeout check. This is code review
(`codex review`), not an ACP runtime approval mode.

Codex native review mode is the preferred path. Non-Codex reviewers are
fallback/second-opinion paths that receive a generated diff prompt, not the
native Codex review runtime.

Use when:

- user asks for Codex review, autoreview, or second-model review
- after non-trivial code edits, before final/commit/ship
- reviewing a local branch or PR branch after fixes

## Contract

- Treat review output as advisory. Never blindly apply it.
- Verify every finding by reading the real code path and adjacent files.
- Read dependency docs/source/types when the finding depends on external behavior.
- Reject unrealistic edge cases, speculative risks, broad rewrites, and fixes
  that over-complicate the codebase.
- Prefer small fixes at the right ownership boundary.
- Keep going until the selected review path returns no accepted/actionable
  findings.
- If a review-triggered fix changes code, rerun focused tests and rerun the
  review helper.
- Default to Codex review. If Codex is unavailable or exits with an error, the
  helper falls back to the first configured CLI from `claude -p`, `pi -p`,
  `opencode run`, `droid exec`, or `copilot`.
- Stop as soon as the review command/helper exits 0 with no
  accepted/actionable findings. Do not run an extra direct `codex review` just
  to get prettier closeout wording.
- Do not push just to review. Push only when the user requested push/ship/PR
  update.

## Pick Target

Dirty local work:

```bash
.agents/skills/autoreview/scripts/autoreview --mode local
```

Use this only when the patch is actually unstaged/staged/untracked in the
current checkout.

Branch/PR work:

```bash
git fetch origin
.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main
```

If an open PR exists, the helper uses its actual base through `ghx` when
available, then `gh`.

Committed single change:

```bash
.agents/skills/autoreview/scripts/autoreview --mode commit --commit HEAD
```

Use commit review for already-landed or already-pushed work on `main`.

## Parallel Closeout

Format first if formatting can change line locations. Then it is OK to run
tests and review in parallel:

```bash
.agents/skills/autoreview/scripts/autoreview --parallel-tests "pnpm run check"
```

By default, when `package.json`, `pnpm-lock.yaml`, `node_modules`, `pnpm`, and a
`check` script are present, the helper runs:

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false PNPM_CONFIG_OFFLINE=true pnpm run check
```

Disable auto tests with `AUTOREVIEW_AUTO_TESTS=0`.

## Helper

```bash
.agents/skills/autoreview/scripts/autoreview --help
```

The helper:

- chooses dirty `--uncommitted` first
- otherwise uses the current PR base if `ghx pr view` or `gh pr view` works
- otherwise uses `origin/main` for non-main branches
- supports `--reviewer codex|claude|pi|opencode|droid|copilot|auto`
- supports `--fallback-reviewer auto|claude|pi|opencode|droid|copilot|none`
- falls back only when Codex is unavailable or exits nonzero, not when Codex
  reports findings
- supports `--dry-run`, `--parallel-tests`, and commit refs
- runs nested Codex review with full access by default; use `--no-yolo` or
  `AUTOREVIEW_YOLO=0` to opt out
- still accepts legacy `CODEX_REVIEW_*` env vars when the matching
  `AUTOREVIEW_*` var is unset
- prints `autoreview clean: no accepted/actionable findings reported` when the
  selected review command exits 0 with no accepted/actionable findings

Branch mode may fail on Codex CLI versions that reject `--base` plus prompt
injection. On that exact parser error, rerun plain `codex review --base <ref>`
instead of falling back to a non-Codex reviewer.

## Final Report

Include:

- review command used
- tests/proof run
- findings accepted/rejected, briefly why
- the clean review result from the final helper/review run, or why a remaining
  finding was consciously rejected

Do not run another Codex review solely to improve the final report wording. If
the final helper run exited 0 and produced no accepted/actionable findings,
report that exact run as clean.
