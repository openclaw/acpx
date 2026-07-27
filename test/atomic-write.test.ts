import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createAtomicWriteTempPath } from "../src/session/persistence/atomic-write.js";

test("atomic write temp paths stay distinct within the same millisecond", () => {
  const originalNow = Date.now;
  Date.now = () => 1_750_000_000_000;

  try {
    const destination = path.join("/tmp", "session.json");
    const first = createAtomicWriteTempPath(destination, () => "first-write");
    const second = createAtomicWriteTempPath(destination, () => "second-write");

    assert.notEqual(first, second);
    assert.equal(path.dirname(first), path.dirname(destination));
    assert.equal(path.dirname(second), path.dirname(destination));
    assert.match(first, /\.first-write\.tmp$/u);
    assert.match(second, /\.second-write\.tmp$/u);
  } finally {
    Date.now = originalNow;
  }
});
