import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractJsonObject } from "../src/flows/json.js";
import { FlowRunner, defineFlow, shell } from "../src/flows/runtime.js";

type WriteLiveArgs = [string, unknown, { type?: string }?];

/**
 * Production-path regression: FlowRunner.runWithHeartbeat must swallow
 * writeLive rejections from the setInterval boundary so a failing live
 * store cannot surface unhandledRejection while a shell node runs.
 */
test("FlowRunner heartbeat writeLive rejections do not become unhandledRejection", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-hb-reject-home-"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-hb-reject-runs-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "unused",
        agentCommand: "unused",
        cwd: process.cwd(),
      }),
      permissionMode: "approve-all",
      outputRoot,
    });

    const store = (
      runner as unknown as {
        store: {
          writeLive: (...args: WriteLiveArgs) => Promise<void>;
        };
      }
    ).store;
    const originalWriteLive = store.writeLive.bind(store);
    let heartbeatAttempts = 0;
    let rejectedIntervalHeartbeats = 0;
    store.writeLive = async (...args: WriteLiveArgs) => {
      const event = args[2];
      if (event?.type === "node_heartbeat") {
        heartbeatAttempts += 1;
        // First call is awaited during shell prepare (must succeed so the
        // node can run). Interval ticks from runWithHeartbeat must be
        // swallowed so they never become unhandledRejection.
        if (heartbeatAttempts > 1) {
          rejectedIntervalHeartbeats += 1;
          throw new Error("disk full (proof)");
        }
      }
      return originalWriteLive(...args);
    };

    const flow = defineFlow({
      name: "heartbeat-reject-test",
      startAt: "slow",
      nodes: {
        slow: shell({
          heartbeatMs: 20,
          exec: () => ({
            command: process.execPath,
            args: [
              "-e",
              "setTimeout(() => process.stdout.write(JSON.stringify({done:true})), 120)",
            ],
          }),
          parse: (result) => extractJsonObject(result.stdout),
        }),
      },
      edges: [],
    });

    const result = await runner.run(flow, {});
    // Allow any late timer ticks to surface
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    assert.equal(result.state.status, "completed");
    assert.deepEqual(result.state.outputs.slow, { done: true });
    assert.ok(
      rejectedIntervalHeartbeats >= 1,
      `expected at least one rejected interval heartbeat, got attempts=${heartbeatAttempts} rejected=${rejectedIntervalHeartbeats}`,
    );
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    await fs.rm(outputRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
