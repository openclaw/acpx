import assert from "node:assert/strict";
import test from "node:test";
import { isReadLikeTool, SUPPRESSED_READ_OUTPUT } from "../src/cli/output/read-suppression.js";

test("SUPPRESSED_READ_OUTPUT is stable", () => {
  assert.equal(SUPPRESSED_READ_OUTPUT, "[read output suppressed]");
});

test("isReadLikeTool matches explicit read kind", () => {
  assert.equal(isReadLikeTool({ kind: "read", title: "Anything" }), true);
});

test("isReadLikeTool infers read-like titles", () => {
  assert.equal(isReadLikeTool({ title: "Read: /tmp/file.txt" }), true);
  assert.equal(isReadLikeTool({ title: "Open file" }), true);
  assert.equal(isReadLikeTool({ title: "View buffer" }), true);
});

test("isReadLikeTool rejects unrelated titles and blanks", () => {
  assert.equal(isReadLikeTool({ title: "Write file" }), false);
  assert.equal(isReadLikeTool({ title: "   " }), false);
  assert.equal(isReadLikeTool({}), false);
});
