import assert from "node:assert/strict";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";

test("SessionQueueOwner handles control requests and nextTask timeouts", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-control-success");
    assert(lease);

    let cancelled = 0;
    const modes: string[] = [];
    const configRequests: Array<{ id: string; value: string }> = [];

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => {
        cancelled += 1;
        return true;
      },
      setSessionMode: async (modeId) => {
        modes.push(modeId);
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async (configId, value) => {
        configRequests.push({ id: configId, value });
        return {
          configOptions: [],
        } as SetSessionConfigOptionResponse;
      },
    });

    try {
      assert.equal(await owner.nextTask(10), undefined);

      const cancelSocket = await connectSocket(lease.socketPath);
      const cancelLines = readline.createInterface({ input: cancelSocket });
      const cancelIterator = cancelLines[Symbol.asyncIterator]();
      cancelSocket.write(
        `${JSON.stringify({
          type: "cancel_prompt",
          requestId: "req-cancel",
        })}\n`,
      );

      const cancelAccepted = (await nextJsonLine(cancelIterator)) as { type: string };
      const cancelResult = (await nextJsonLine(cancelIterator)) as {
        type: string;
        cancelled: boolean;
      };
      assert.equal(cancelAccepted.type, "accepted");
      assert.equal(cancelResult.type, "cancel_result");
      assert.equal(cancelResult.cancelled, true);
      cancelLines.close();
      cancelSocket.destroy();

      const modeSocket = await connectSocket(lease.socketPath);
      const modeLines = readline.createInterface({ input: modeSocket });
      const modeIterator = modeLines[Symbol.asyncIterator]();
      modeSocket.write(
        `${JSON.stringify({
          type: "set_mode",
          requestId: "req-mode",
          modeId: "plan",
          timeoutMs: 250,
        })}\n`,
      );

      const modeAccepted = (await nextJsonLine(modeIterator)) as { type: string };
      const modeResult = (await nextJsonLine(modeIterator)) as { type: string; modeId: string };
      assert.equal(modeAccepted.type, "accepted");
      assert.equal(modeResult.type, "set_mode_result");
      assert.equal(modeResult.modeId, "plan");
      modeLines.close();
      modeSocket.destroy();

      const configSocket = await connectSocket(lease.socketPath);
      const configLines = readline.createInterface({ input: configSocket });
      const configIterator = configLines[Symbol.asyncIterator]();
      configSocket.write(
        `${JSON.stringify({
          type: "set_config_option",
          requestId: "req-config",
          configId: "thinking_level",
          value: "high",
          timeoutMs: 250,
        })}\n`,
      );

      const configAccepted = (await nextJsonLine(configIterator)) as { type: string };
      const configResult = (await nextJsonLine(configIterator)) as {
        type: string;
        response: { configOptions: unknown[] };
      };
      assert.equal(configAccepted.type, "accepted");
      assert.equal(configResult.type, "set_config_option_result");
      assert.deepEqual(configResult.response.configOptions, []);
      configLines.close();
      configSocket.destroy();

      assert.equal(cancelled, 1);
      assert.deepEqual(modes, ["plan"]);
      assert.deepEqual(configRequests, [{ id: "thinking_level", value: "high" }]);
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner enqueues fire-and-forget prompts and rejects invalid owner generations", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-prompt-success");
    assert(lease);

    const queueDepths: number[] = [];
    const owner = await SessionQueueOwner.start(
      lease,
      {
        cancelPrompt: async () => false,
        setSessionMode: async () => {
          // no-op
        },
        setSessionModel: async () => {
          // no-op
        },
        setSessionConfigOption: async () =>
          ({
            configOptions: [],
          }) as SetSessionConfigOptionResponse,
      },
      {
        maxQueueDepth: 4,
        onQueueDepthChanged: (depth) => {
          queueDepths.push(depth);
        },
      },
    );

    try {
      const promptSocket = await connectSocket(lease.socketPath);
      const promptLines = readline.createInterface({ input: promptSocket });
      const promptIterator = promptLines[Symbol.asyncIterator]();
      promptSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-submit",
          ownerGeneration: lease.ownerGeneration,
          message: "hello from queue",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const accepted = (await nextJsonLine(promptIterator)) as {
        type: string;
        ownerGeneration?: number;
      };
      assert.equal(accepted.type, "accepted");
      assert.equal(accepted.ownerGeneration, lease.ownerGeneration);

      const task = await owner.nextTask();
      assert(task);
      assert.equal(task.requestId, "req-submit");
      assert.equal(task.message, "hello from queue");
      assert.deepEqual(task.prompt, [{ type: "text", text: "hello from queue" }]);
      assert.equal(owner.queueDepth(), 0);
      assert.deepEqual(queueDepths, [1, 0]);
      promptLines.close();
      promptSocket.destroy();

      const badSocket = await connectSocket(lease.socketPath);
      const badLines = readline.createInterface({ input: badSocket });
      const badIterator = badLines[Symbol.asyncIterator]();
      badSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-bad-generation",
          ownerGeneration: lease.ownerGeneration + 1,
          message: "stale",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );

      const mismatch = (await nextJsonLine(badIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(mismatch.type, "error");
      assert.equal(mismatch.detailCode, "QUEUE_OWNER_GENERATION_MISMATCH");
      badLines.close();
      badSocket.destroy();

      const invalidSocket = await connectSocket(lease.socketPath);
      const invalidLines = readline.createInterface({ input: invalidSocket });
      const invalidIterator = invalidLines[Symbol.asyncIterator]();
      invalidSocket.write(
        `${JSON.stringify({
          type: "set_mode",
          requestId: "req-invalid",
          modeId: "",
        })}\n`,
      );

      const invalid = (await nextJsonLine(invalidIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(invalid.type, "error");
      assert.equal(invalid.detailCode, "QUEUE_REQUEST_INVALID");
      invalidLines.close();
      invalidSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});
