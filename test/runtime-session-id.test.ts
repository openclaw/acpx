import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_SESSION_ID_META_KEYS,
  extractRuntimeSessionId,
} from "../src/runtime-session-id.js";

test("runtime session id precedence is stable", () => {
  assert.deepEqual(RUNTIME_SESSION_ID_META_KEYS, [
    "runtimeSessionId",
    "providerSessionId",
    "codexSessionId",
    "claudeSessionId",
  ]);
});

test("extractRuntimeSessionId uses first non-empty supported key", () => {
  const meta = {
    runtimeSessionId: "runtime-1",
    providerSessionId: "provider-1",
    codexSessionId: "codex-1",
    claudeSessionId: "claude-1",
  };

  assert.equal(extractRuntimeSessionId(meta), "runtime-1");
});

test("extractRuntimeSessionId falls back across provider/codex/claude keys", () => {
  assert.equal(
    extractRuntimeSessionId({
      runtimeSessionId: "   ",
      providerSessionId: "provider-2",
      codexSessionId: "codex-2",
      claudeSessionId: "claude-2",
    }),
    "provider-2",
  );

  assert.equal(
    extractRuntimeSessionId({
      runtimeSessionId: "",
      providerSessionId: "",
      codexSessionId: "codex-3",
      claudeSessionId: "claude-3",
    }),
    "codex-3",
  );

  assert.equal(
    extractRuntimeSessionId({
      runtimeSessionId: "",
      providerSessionId: "",
      codexSessionId: "",
      claudeSessionId: "claude-4",
    }),
    "claude-4",
  );
});

test("extractRuntimeSessionId ignores non-string and empty values", () => {
  assert.equal(
    extractRuntimeSessionId({
      runtimeSessionId: 123,
      providerSessionId: null,
      codexSessionId: ["codex"],
      claudeSessionId: "",
    }),
    undefined,
  );
  assert.equal(extractRuntimeSessionId(null), undefined);
  assert.equal(extractRuntimeSessionId([]), undefined);
  assert.equal(extractRuntimeSessionId("meta"), undefined);
});
