import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TIMER_DELAY_MS } from "../src/cli/timer-duration.js";
import { createSharedAcpRuntime } from "../src/runtime.js";

for (const ttlMs of [MAX_TIMER_DELAY_MS + 1, MAX_TIMER_DELAY_MS + 0.5, Number.MAX_VALUE]) {
  test(`shared runtime rejects unsupported rounded TTL ${ttlMs} before session work`, () => {
    assert.throws(
      () => createSharedAcpRuntime({ cwd: process.cwd(), permissionMode: "deny-all", ttlMs }),
      {
        name: "AcpRuntimeError",
        code: "ACP_INVALID_RUNTIME_OPTION",
        message: /ttlMs.*maximum supported timer delay/,
      },
    );
  });
}

test("shared runtime retains existing TTL defaults, sentinels, and fractional admission", async () => {
  for (const ttlMs of [
    undefined,
    0,
    -1,
    Number.NaN,
    Infinity,
    -Infinity,
    0.4,
    1.6,
    MAX_TIMER_DELAY_MS,
    MAX_TIMER_DELAY_MS + 0.4,
  ]) {
    const runtime = createSharedAcpRuntime({
      cwd: process.cwd(),
      permissionMode: "deny-all",
      ttlMs,
    });
    await runtime.shutdown();
  }
});
