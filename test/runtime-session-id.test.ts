import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_SESSION_ID_META_KEYS,
  extractRuntimeSessionId,
} from "../src/runtime-session-id.js";

test("runtime session id keys are canonical", () => {
  assert.deepEqual(RUNTIME_SESSION_ID_META_KEYS, ["agentSessionId"]);
});

test("extractRuntimeSessionId reads canonical key", () => {
  const meta = {
    agentSessionId: "agent-1",
  };

  assert.equal(extractRuntimeSessionId(meta), "agent-1");
});

test("extractRuntimeSessionId ignores non-string and empty values", () => {
  assert.equal(
    extractRuntimeSessionId({
      agentSessionId: 123,
    }),
    undefined,
  );
  assert.equal(
    extractRuntimeSessionId({
      agentSessionId: "   ",
    }),
    undefined,
  );
  assert.equal(extractRuntimeSessionId(null), undefined);
  assert.equal(extractRuntimeSessionId([]), undefined);
  assert.equal(extractRuntimeSessionId("meta"), undefined);
});
