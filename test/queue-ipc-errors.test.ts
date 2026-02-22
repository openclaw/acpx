import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import net from "node:net";
import readline from "node:readline";
import test from "node:test";
import { QueueConnectionError } from "../src/errors.js";
import {
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySetModeOnRunningOwner,
  trySubmitToRunningOwner,
} from "../src/queue-ipc.js";
import type { OutputFormatter } from "../src/types.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

const NOOP_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {
    // no-op
  },
  onSessionUpdate() {
    // no-op
  },
  onClientOperation() {
    // no-op
  },
  onDone() {
    // no-op
  },
  onError() {
    // no-op
  },
  flush() {
    // no-op
  },
};

test("trySubmitToRunningOwner propagates typed queue prompt errors", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "prompt-error-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        if (!line) {
          return;
        }

        const request = JSON.parse(line) as { requestId: string; type: string };
        assert.equal(request.type, "submit_prompt");
        socket.write(
          `${JSON.stringify({
            type: "accepted",
            requestId: request.requestId,
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "error",
            requestId: request.requestId,
            code: "PERMISSION_DENIED",
            detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
            origin: "queue",
            retryable: false,
            message: "permission denied by queue control",
            acp: {
              code: -32000,
              message: "Authentication required",
              data: {
                methodId: "token",
              },
            },
          })}\n`,
        );
        socket.end();
      });
    });

    await listenServer(server, socketPath);

    try {
      await assert.rejects(
        async () =>
          await trySubmitToRunningOwner({
            sessionId,
            message: "hello",
            permissionMode: "approve-reads",
            outputFormatter: NOOP_OUTPUT_FORMATTER,
            waitForCompletion: true,
          }),
        (error: unknown) => {
          assert(error instanceof QueueConnectionError);
          assert.equal(error.outputCode, "PERMISSION_DENIED");
          assert.equal(error.detailCode, "QUEUE_CONTROL_REQUEST_FAILED");
          assert.equal(error.origin, "queue");
          assert.equal(error.retryable, false);
          assert.equal(error.acp?.code, -32000);
          assert.match(error.message, /permission denied by queue control/);
          return true;
        },
      );
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("trySetModeOnRunningOwner propagates typed queue control errors", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "control-error-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        if (!line) {
          return;
        }

        const request = JSON.parse(line) as { requestId: string; type: string };
        assert.equal(request.type, "set_mode");
        socket.write(
          `${JSON.stringify({
            type: "accepted",
            requestId: request.requestId,
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "error",
            requestId: request.requestId,
            code: "RUNTIME",
            detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
            origin: "queue",
            retryable: true,
            message: "mode switch rejected by owner",
          })}\n`,
        );
        socket.end();
      });
    });

    await listenServer(server, socketPath);

    try {
      await assert.rejects(
        async () => await trySetModeOnRunningOwner(sessionId, "plan", 1_000, false),
        (error: unknown) => {
          assert(error instanceof QueueConnectionError);
          assert.equal(error.outputCode, "RUNTIME");
          assert.equal(error.detailCode, "QUEUE_CONTROL_REQUEST_FAILED");
          assert.equal(error.origin, "queue");
          assert.equal(error.retryable, true);
          assert.match(error.message, /mode switch rejected by owner/);
          return true;
        },
      );
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("SessionQueueOwner emits typed invalid request payload errors", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-invalid-request");
    assert(lease);

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionConfigOption: async () =>
        ({
          configOptions: [],
        }) as SetSessionConfigOptionResponse,
    });

    const socket = await connectSocket(lease.socketPath);
    socket.write("{invalid\n");

    const lines = readline.createInterface({ input: socket });
    const iterator = lines[Symbol.asyncIterator]();

    try {
      const payload = (await nextJsonLine(iterator)) as {
        type: string;
        code?: string;
        detailCode?: string;
        origin?: string;
        message: string;
      };
      assert.equal(payload.type, "error");
      assert.equal(payload.code, "RUNTIME");
      assert.equal(payload.detailCode, "QUEUE_REQUEST_PAYLOAD_INVALID_JSON");
      assert.equal(payload.origin, "queue");
      assert.match(payload.message, /Invalid queue request payload/);
    } finally {
      lines.close();
      socket.destroy();
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner emits typed shutdown errors for pending prompts", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-shutdown-pending");
    assert(lease);

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionConfigOption: async () =>
        ({
          configOptions: [],
        }) as SetSessionConfigOptionResponse,
    });

    const socket = await connectSocket(lease.socketPath);
    const lines = readline.createInterface({ input: socket });
    const iterator = lines[Symbol.asyncIterator]();

    socket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId: "req-pending",
        message: "sleep 5000",
        permissionMode: "approve-reads",
        waitForCompletion: true,
      })}\n`,
    );

    try {
      const accepted = (await nextJsonLine(iterator)) as {
        type: string;
        requestId: string;
      };
      assert.equal(accepted.type, "accepted");
      assert.equal(accepted.requestId, "req-pending");

      await owner.close();

      const payload = (await nextJsonLine(iterator)) as {
        type: string;
        code?: string;
        detailCode?: string;
        origin?: string;
        retryable?: boolean;
        message: string;
      };
      assert.equal(payload.type, "error");
      assert.equal(payload.code, "RUNTIME");
      assert.equal(payload.detailCode, "QUEUE_OWNER_SHUTTING_DOWN");
      assert.equal(payload.origin, "queue");
      assert.equal(payload.retryable, true);
      assert.match(payload.message, /shutting down/i);
    } finally {
      lines.close();
      socket.destroy();
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

async function connectSocket(socketPath: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function nextJsonLine(
  iterator: AsyncIterator<string>,
  timeoutMs = 2_000,
): Promise<unknown> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for queue line")), timeoutMs);
  });

  const next = (async () => {
    const result = await iterator.next();
    if (result.done || !result.value) {
      throw new Error("Queue socket closed before receiving expected line");
    }
    return JSON.parse(result.value);
  })();

  return await Promise.race([next, timeout]);
}
