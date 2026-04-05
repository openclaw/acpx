import assert from "node:assert/strict";
import fs from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  MAX_MESSAGE_BUFFER_SIZE,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySetConfigOptionOnRunningOwner,
  trySetModeOnRunningOwner,
  trySubmitToRunningOwner,
} from "../src/cli/queue/ipc.js";
import { QueueConnectionError, QueueProtocolError } from "../src/errors.js";
import type { OutputFormatter } from "../src/types.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  connectSocket,
  createSingleRequestServer,
  listenServer,
  nextJsonLine,
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
  onAcpMessage() {
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

    const server = createSingleRequestServer((socket, request) => {
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

    const server = createSingleRequestServer((socket, request) => {
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

test("trySetConfigOptionOnRunningOwner returns the queue owner response", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "control-config-success-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "set_config_option");
      socket.write(
        `${JSON.stringify({
          type: "accepted",
          requestId: request.requestId,
        })}\n`,
      );
      socket.write(
        `${JSON.stringify({
          type: "set_config_option_result",
          requestId: request.requestId,
          response: {
            configOptions: [],
          },
        })}\n`,
      );
      socket.end();
    });

    await listenServer(server, socketPath);

    try {
      const response = await trySetConfigOptionOnRunningOwner(
        sessionId,
        "thinking_level",
        "high",
        1_000,
        true,
      );
      assert.deepEqual(response, {
        configOptions: [],
      });
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("trySubmitToRunningOwner surfaces protocol invalid JSON detail code", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "submit-invalid-json-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "submit_prompt");
      socket.write(
        `${JSON.stringify({
          type: "accepted",
          requestId: request.requestId,
        })}\n`,
      );
      socket.write("{invalid-json\n");
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
          assert(error instanceof QueueProtocolError);
          assert.equal(error.detailCode, "QUEUE_PROTOCOL_INVALID_JSON");
          assert.equal(error.origin, "queue");
          assert.equal(error.retryable, true);
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

test("trySubmitToRunningOwner surfaces disconnect-before-ack detail code", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "submit-disconnect-before-ack";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = createSingleRequestServer((socket) => {
      socket.end();
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
          assert.equal(error.detailCode, "QUEUE_DISCONNECTED_BEFORE_ACK");
          assert.equal(error.origin, "queue");
          assert.equal(error.retryable, true);
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

test("trySubmitToRunningOwner rejects oversized queue messages", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "submit-oversized-message";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "submit_prompt");
      socket.write(
        `${JSON.stringify({
          type: "accepted",
          requestId: request.requestId,
        })}\n`,
      );
      socket.write(`${"x".repeat(MAX_MESSAGE_BUFFER_SIZE + 1)}\n`);
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
          assert(error instanceof Error);
          assert.match(error.message, /Message buffer exceeded/);
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

test("trySubmitToRunningOwner streams queued lifecycle and returns result", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "queued-lifecycle-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const events: string[] = [];
    const formatter: OutputFormatter = {
      setContext(context) {
        events.push(`context:${context.sessionId}`);
      },
      onAcpMessage(message) {
        if ("method" in message && typeof message.method === "string") {
          events.push(`event:${message.method}`);
          return;
        }
        events.push("event:response");
      },
      onError(params) {
        events.push(`error:${params.code}`);
      },
      flush() {
        events.push("flush");
      },
    };

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "submit_prompt");
      socket.write(
        `${JSON.stringify({
          type: "accepted",
          requestId: request.requestId,
        })}\n`,
      );
      socket.write(
        `${JSON.stringify({
          type: "event",
          requestId: request.requestId,
          message: {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "agent-session",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "hello" },
              },
            },
          },
        })}\n`,
      );
      socket.write(
        `${JSON.stringify({
          type: "result",
          requestId: request.requestId,
          result: {
            stopReason: "end_turn",
            sessionId: "agent-session",
            permissionStats: {
              requested: 1,
              approved: 1,
              denied: 0,
              cancelled: 0,
            },
            resumed: true,
            record: {
              schema: "acpx.session.v1",
              acpxRecordId: sessionId,
              acpSessionId: "agent-session",
              agentCommand: "mock-agent",
              cwd: "/tmp/project",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastUsedAt: "2026-01-01T00:00:00.000Z",
              lastSeq: 2,
              eventLog: {
                active_path: "/tmp/session.stream.ndjson",
                segment_count: 1,
                max_segment_bytes: 1024,
                max_segments: 1,
                last_write_at: "2026-01-01T00:00:00.000Z",
                last_write_error: null,
              },
              title: null,
              messages: [],
              updated_at: "2026-01-01T00:00:00.000Z",
              cumulative_token_usage: {},
              request_token_usage: {},
            },
          },
        })}\n`,
      );
      socket.end();
    });

    await listenServer(server, socketPath);

    try {
      const result = await trySubmitToRunningOwner({
        sessionId,
        message: "hello",
        permissionMode: "approve-reads",
        outputFormatter: formatter,
        waitForCompletion: true,
      });

      assert(result);
      assert.equal("queued" in result, false);
      if ("queued" in result) {
        assert.fail("expected completed result, received queued response");
      }
      assert.equal(result.sessionId, "agent-session");
      assert.equal(result.stopReason, "end_turn");
      assert.equal(result.resumed, true);
      assert.equal(
        events.some((entry) => entry === `context:${sessionId}`),
        true,
      );
      assert.equal(events.includes("event:session/update"), true);
      assert.equal(events.includes("flush"), true);
      assert.equal(
        events.some((entry) => entry.startsWith("error:")),
        false,
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
      setSessionModel: async () => {
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
      setSessionModel: async () => {
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

test("SessionQueueOwner rejects prompts when queue depth exceeds the configured limit", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-overloaded");
    assert(lease);

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
        maxQueueDepth: 1,
      },
    );

    const firstSocket = await connectSocket(lease.socketPath);
    firstSocket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId: "req-first",
        ownerGeneration: lease.ownerGeneration,
        message: "first",
        permissionMode: "approve-reads",
        waitForCompletion: true,
      })}\n`,
    );

    const secondSocket = await connectSocket(lease.socketPath);
    secondSocket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId: "req-second",
        ownerGeneration: lease.ownerGeneration,
        message: "second",
        permissionMode: "approve-reads",
        waitForCompletion: true,
      })}\n`,
    );

    const secondLines = readline.createInterface({ input: secondSocket });
    const secondIterator = secondLines[Symbol.asyncIterator]();

    try {
      const accepted = (await nextJsonLine(secondIterator)) as { type: string; requestId: string };
      assert.equal(accepted.type, "accepted");
      assert.equal(accepted.requestId, "req-second");

      const error = (await nextJsonLine(secondIterator)) as {
        type: string;
        detailCode?: string;
        retryable?: boolean;
      };
      assert.equal(error.type, "error");
      assert.equal(error.detailCode, "QUEUE_OWNER_OVERLOADED");
      assert.equal(error.retryable, true);
    } finally {
      secondLines.close();
      secondSocket.destroy();
      firstSocket.destroy();
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("trySubmitToRunningOwner clears stale owner lock on protocol mismatch", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "submit-stale-owner-protocol-mismatch";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "submit_prompt");
      socket.write(
        `${JSON.stringify({
          type: "accepted",
          requestId: request.requestId,
        })}\n`,
      );
      socket.write(
        `${JSON.stringify({
          type: "session_update",
          requestId: request.requestId,
          update: {
            sessionId: "legacy-session",
          },
        })}\n`,
      );
      socket.end();
    });

    await listenServer(server, socketPath);

    try {
      const outcome = await trySubmitToRunningOwner({
        sessionId,
        message: "hello",
        permissionMode: "approve-reads",
        outputFormatter: NOOP_OUTPUT_FORMATTER,
        waitForCompletion: true,
      });
      assert.equal(outcome, undefined);
      await assert.rejects(fs.access(lockPath));
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});
