import assert from "node:assert/strict";
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
