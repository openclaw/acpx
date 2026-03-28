import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunLocation,
  readRequestedRunId,
} from "../examples/flows/replay-viewer/src/lib/run-url.js";

test("readRequestedRunId returns the requested run query", () => {
  assert.equal(
    readRequestedRunId("?run=2026-03-28T000551318Z-pr-triage-dbda9214"),
    "2026-03-28T000551318Z-pr-triage-dbda9214",
  );
  assert.equal(readRequestedRunId("?foo=1&run=abc123"), "abc123");
  assert.equal(readRequestedRunId("", "/run/abc123"), "abc123");
  assert.equal(readRequestedRunId("?run=older", "/run/newer"), "newer");
  assert.equal(readRequestedRunId("?run=   "), null);
  assert.equal(readRequestedRunId(""), null);
});

test("buildRunLocation preserves unrelated params and hash", () => {
  assert.equal(
    buildRunLocation("http://127.0.0.1:4173/?tab=session#graph", "run-42"),
    "/run/run-42?tab=session#graph",
  );

  assert.equal(
    buildRunLocation("http://127.0.0.1:4173/run/old?tab=session&run=old#graph", null),
    "/?tab=session#graph",
  );
});
