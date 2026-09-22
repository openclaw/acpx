import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";
import { DISCARD_OUTPUT_FORMATTER } from "../src/session/execution/discard-output.js";
import { runOnce } from "../src/session/execution/runtime.js";
import type { PermissionStats } from "../src/types.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function recordPermission(client: AcpClient, decision: "approved" | "denied" | "cancelled") {
  // Keep the real counter and snapshot getter; only transport/lifecycle work is stubbed.
  (
    client as unknown as {
      recordPermissionDecision(value: "approved" | "denied" | "cancelled"): void;
    }
  ).recordPermissionDecision(decision);
}

const beforeClose: PermissionStats = { requested: 3, approved: 1, denied: 1, cancelled: 1 };
const afterClose: PermissionStats = { requested: 4, approved: 1, denied: 1, cancelled: 2 };

for (const outcome of ["success", "prompt", "close", "prompt-and-close", "flush"] as const) {
  test(
    `runOnce final permission observer preserves the ${outcome} outcome and flush ordering`,
    { timeout: 5_000 },
    async (t) => {
      const closeEntered = gate();
      const releaseClose = gate();
      const trace: string[] = [];
      const snapshots: PermissionStats[] = [];
      const observerArguments: PermissionStats[] = [];
      const promptFailure = new Error("original prompt failure");
      const closeFailure = new Error("original close failure");
      const flushFailure = new Error("original flush failure");
      const observerFailure = new Error("permission observer failure");
      const meta = { fixture: "permission-lifecycle" };
      let closeCalls = 0;
      let flushCalls = 0;
      let settled = false;

      t.signal.addEventListener("abort", releaseClose.release, { once: true });
      const startMock = t.mock.method(AcpClient.prototype, "start", async () => {});
      t.mock.method(AcpClient.prototype, "createSession", async () => ({
        sessionId: "permission-lifecycle-session",
        configOptionsPresent: false,
        legacyModelMetadataPresent: false,
      }));
      t.mock.method(AcpClient.prototype, "prompt", async function (this: AcpClient) {
        recordPermission(this, "approved");
        recordPermission(this, "denied");
        recordPermission(this, "cancelled");
        if (outcome === "prompt" || outcome === "prompt-and-close") {
          throw promptFailure;
        }
        return { stopReason: "end_turn", _meta: meta };
      });
      t.mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
        closeCalls += 1;
        trace.push("close:entered");
        closeEntered.release();
        await releaseClose.promise;
        // A pending permission can finish cancellation while its owner retires.
        recordPermission(this, "cancelled");
        trace.push("close:settled");
        if (outcome === "close" || outcome === "prompt-and-close") {
          throw closeFailure;
        }
      });

      const running = runOnce(
        {
          agentCommand: "unused-permission-lifecycle-peer",
          cwd: process.cwd(),
          prompt: [{ type: "text", text: "synthetic permission lifecycle" }],
          permissionMode: "deny-all",
          promptRetries: 0,
          outputFormatter: {
            ...DISCARD_OUTPUT_FORMATTER,
            flush() {
              flushCalls += 1;
              trace.push("flush");
              if (outcome === "flush") {
                throw flushFailure;
              }
            },
          },
          onPermissionStats(stats) {
            trace.push("stats");
            snapshots.push({ ...stats });
            observerArguments.push(stats);
            Object.assign(stats, { requested: 99, approved: 99, denied: 99, cancelled: 99 });
            throw observerFailure;
          },
        },
        { signal: new AbortController().signal, handleProcessInterrupts: false },
      ).then(
        (value) => {
          settled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );

      try {
        await closeEntered.promise;
        const client: unknown = startMock.mock.calls[0]?.this;
        assert.ok(client instanceof AcpClient);
        assert.deepEqual(client.getPermissionStats(), beforeClose);
        assert.deepEqual(trace, ["close:entered"]);
        assert.deepEqual(snapshots, [], "the observer must wait for owned cleanup to settle");
        assert.equal(flushCalls, 0);
        assert.equal(settled, false);

        releaseClose.release();
        const result = await running;
        assert.deepEqual(trace, ["close:entered", "close:settled", "stats", "flush"]);
        assert.equal(closeCalls, 1);
        assert.equal(flushCalls, 1);
        assert.deepEqual(
          snapshots,
          [afterClose],
          "exactly one final snapshot includes cleanup decisions",
        );
        assert.equal(observerArguments.length, 1);
        assert.deepEqual(
          client.getPermissionStats(),
          afterClose,
          "observer mutation must not change client counters",
        );

        if (outcome === "success") {
          assert.equal(result.ok, true);
          if (result.ok) {
            assert.equal(result.value.stopReason, "end_turn");
            assert.equal(result.value.sessionId, "permission-lifecycle-session");
            assert.equal(result.value._meta, meta);
            assert.deepEqual(result.value.permissionStats, beforeClose);
            assert.notEqual(result.value.permissionStats, observerArguments[0]);
          }
        } else {
          assert.equal(result.ok, false);
          if (!result.ok) {
            const expected =
              outcome === "flush"
                ? flushFailure
                : outcome === "close" || outcome === "prompt-and-close"
                  ? closeFailure
                  : promptFailure;
            assert.equal(
              result.error,
              expected,
              "the observer must not replace the original outcome",
            );
          }
        }
      } finally {
        releaseClose.release();
        await running;
        t.signal.removeEventListener("abort", releaseClose.release);
      }
    },
  );
}
