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
      /cases:\s*\{[\s\S]*?check_final_conflicts:\s*"check_final_conflicts",[\s\S]*?comment_and_escalate_to_human:\s*"comment_and_escalate_to_human",[\s\S]*?\}/,
    );
    assert.doesNotMatch(edgeBlock, /collect_ci_state:/);
  });
});
