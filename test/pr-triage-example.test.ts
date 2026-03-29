import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  extractCodexReviewTail,
  selectLocalCodexReviewText,
} from "../examples/flows/pr-triage/review-text.js";

test("selectLocalCodexReviewText prefers stdout when present", () => {
  assert.equal(selectLocalCodexReviewText("review text", "ignored"), "review text");
});

test("selectLocalCodexReviewText extracts the codex tail from stderr logs", () => {
  const stderr = [
    "exec",
    '/bin/zsh -lc "pnpm run test"',
    "2026-03-27T10:32:45.444599Z  WARN codex_protocol::openai_models: personality fallback",
    "codex",
    "The patch only adds focused coverage for `src/perf-metrics.ts`, and I did not find any actionable issues.",
  ].join("\n");

  assert.equal(
    selectLocalCodexReviewText("", stderr),
    "The patch only adds focused coverage for `src/perf-metrics.ts`, and I did not find any actionable issues.",
  );
});

test("extractCodexReviewTail falls back to the final non-log block", () => {
  const stderr = [
    "exec",
    '/bin/zsh -lc "ls test"',
    "2026-03-27T10:31:41.894302Z  WARN codex_protocol::openai_models: personality fallback",
    "P1: Missing regression coverage for timeout edge case.",
    "P2: Minor wording cleanup in docs.",
  ].join("\n");

  assert.equal(
    extractCodexReviewTail(stderr),
    [
      "P1: Missing regression coverage for timeout edge case.",
      "P2: Minor wording cleanup in docs.",
    ].join("\n"),
  );
});

test("fix_ci_failures owns CI monitoring until a terminal state", () => {
  const sourcePath = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");

  return fs.readFile(sourcePath, "utf8").then((source) => {
    assert.match(source, /fix_ci_failures:\s*\{[\s\S]*?timeoutMs:\s*60 \* 60_000,/);
    const edgeBlock = source.match(/\{\s*from:\s*"fix_ci_failures",[\s\S]*?\n\s*\},\n\s*\{/)?.[0];

    assert.ok(edgeBlock, "Expected a fix_ci_failures edge block");
    assert.match(
      edgeBlock,
      /cases:\s*\{[\s\S]*?check_final_conflicts:\s*"check_final_conflicts",[\s\S]*?comment_and_escalate_needs_judgment:\s*"comment_and_escalate_needs_judgment",[\s\S]*?\}/,
    );
    assert.doesNotMatch(edgeBlock, /collect_ci_state:/);
  });
});

test("human handoff is split into ready-for-landing and needs-judgment lanes", () => {
  const sourcePath = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");

  return fs.readFile(sourcePath, "utf8").then((source) => {
    assert.match(source, /comment_and_escalate_ready_for_landing:/);
    assert.match(source, /comment_and_escalate_needs_judgment:/);
    assert.match(source, /post_ready_for_landing_comment:/);
    assert.match(source, /post_needs_judgment_comment:/);
    assert.match(source, /"ready_for_human_landing_decision"/);
    assert.match(source, /"needs_human_judgment"/);
    assert.match(
      source,
      /const route = clean[\s\S]*options\.phase === "initial"[\s\S]*"bug_or_feature"[\s\S]*"comment_and_escalate_ready_for_landing"/,
    );
    assert.doesNotMatch(source, /comment_and_escalate_to_human:/);
  });
});

test("maintenance PRs stay on the feature path without adding a new flow node", () => {
  const sourcePath = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");

  return fs.readFile(sourcePath, "utf8").then((source) => {
    assert.match(
      source,
      /Dependency-only, tooling-only, docs-only, or lockfile-only maintenance PRs should still use the `feature` path\./,
    );
    assert.match(
      source,
      /validation_result": "validated" \| "standard_checks_sufficient" \| "blocked" \| "not_proven"/,
    );
    assert.doesNotMatch(source, /validate_via_standard_checks:/);
    assert.doesNotMatch(source, /buildTargetedTestPlan/);
    assert.doesNotMatch(source, /ensureProjectDependencies/);
  });
});

test("validation stays in ACP nodes instead of hardcoded runtime helpers", () => {
  const sourcePath = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");

  return fs.readFile(sourcePath, "utf8").then((source) => {
    assert.match(
      source,
      /reproduce_bug_and_test_fix:\s*\{[\s\S]*?nodeType:\s*"acp"[\s\S]*?promptReproduceBugAndTestFix/,
    );
    assert.match(
      source,
      /test_feature_directly:\s*\{[\s\S]*?nodeType:\s*"acp"[\s\S]*?promptTestFeatureDirectly/,
    );
    assert.match(source, /Own the validation plan yourself\./);
    assert.doesNotMatch(source, /runValidationPlan/);
    assert.doesNotMatch(source, /runShellLine/);
  });
});

test("judge_refactor asks whether anything should be added removed simplified or refactored", () => {
  const sourcePath = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");

  return fs.readFile(sourcePath, "utf8").then((source) => {
    assert.match(
      source,
      /Judge whether this PR is ready as-is, or whether anything should be added, removed, simplified, or refactored before it continues\./,
    );
    assert.match(
      source,
      /Use `superficial` if the main direction is fine but there is still some minor thing that should be added, removed, simplified, or locally refactored first\./,
    );
    assert.match(
      source,
      /If a PR fixes the validated issue but also introduces extra behavior or special-case logic beyond the minimum needed for that fix, prefer `superficial` over `none` unless it was necessary to prove the issue resolved\./,
    );
  });
});

test("pr-triage configures a descriptive run title from repo and PR number", () => {
  const sourcePath = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");

  return fs.readFile(sourcePath, "utf8").then((source) => {
    assert.match(
      source,
      /run:\s*\{[\s\S]*title:\s*\(\{\s*input\s*\}\)\s*=>\s*formatPrTriageRunTitle\(loadPullRequestInput\(input\)\)/,
    );
    assert.match(source, /return `PR-triage-\$\{repoName\}-\$\{pr\.prNumber\}`;/);
  });
});
