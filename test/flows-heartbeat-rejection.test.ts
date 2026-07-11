import assert from "node:assert/strict";
import test from "node:test";

/**
 * Mirrors FlowRunner.runWithHeartbeat's timer boundary: best-effort writes
 * must not surface as unhandledRejection when writeLive rejects.
 */
test("heartbeat timer boundary swallows writeLive rejections", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  let calls = 0;
  const writeLive = async (): Promise<void> => {
    calls += 1;
    throw new Error("disk full (proof)");
  };

  const heartbeat = async (): Promise<void> => {
    await writeLive();
  };

  const timer = setInterval(() => {
    void heartbeat().catch(() => {
      // best effort — same as FlowRunner.runWithHeartbeat
    });
  }, 15);

  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
  clearInterval(timer);
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  process.off("unhandledRejection", onUnhandled);

  assert.ok(calls >= 2, `expected multiple heartbeat attempts, got ${calls}`);
  assert.equal(rejections.length, 0, `unexpected unhandledRejection: ${String(rejections)}`);
});
