import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QueueConnectionError, QueueProtocolError } from "../src/errors.js";
import { sendSession } from "../src/session/execution/queue-owner-runtime.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import {
  MAX_MESSAGE_BUFFER_SIZE,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  tryCancelOnRunningOwner,
  tryCloseSessionOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModelOnRunningOwner,
  trySetModeOnRunningOwner,
  trySubmitToRunningOwner,
  terminateQueueOwnerForSession,
} from "../src/session/queue/ipc.js";
import {
  isProcessAlive,
  readQueueOwnerRecord,
  type QueueOwnerRecord,
} from "../src/session/queue/lease-store.js";
import type { AcpJsonRpcMessage, AcpMessageDirection, OutputFormatter } from "../src/types.js";
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
  verifiedProcessIdentity,
} from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

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
  onPermissionEscalation() {
    // no-op
  },
  flush() {
    // no-op
  },
};

test(
  "shared queue preserves turn identity, cancels only the target, and detaches observers",
  { timeout: 15_000 },
  async () => {
    await withTempHome(async () => {
      const sessionId = "shared-queue-controls";
      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert(lease);
      let activeCancels = 0;
      const owner = await SessionQueueOwner.start(lease, {
        cancelPrompt: async () => {
          activeCancels += 1;
          return true;
        },
        closeSession: async () => false,
        setSessionMode: async () => {},
        setSessionModel: async () => undefined,
        setSessionConfigOption: async () => ({ configOptions: [] }),
      });
      const submit = (requestId: string) => {
        const abort = new AbortController();
        let accept!: () => void;
        const accepted = new Promise<void>((resolve) => {
          accept = resolve;
        });
        const result = trySubmitToRunningOwner({
          sessionId,
          requestId,
          requireSharedRuntime: true,
          message: requestId,
          permissionMode: "deny-all",
          outputFormatter: NOOP_OUTPUT_FORMATTER,
          waitForCompletion: true,
          onQueueAccepted: accept,
          signal: abort.signal,
        });
        void result.catch(() => {});
        return { result, accepted, abort };
      };
      const submissions: ReturnType<typeof submit>[] = [];
      try {
        const activeReady = owner.nextTask(1_000);
        const active = submit("active");
        submissions.push(active);
        await active.accepted;
        const activeTask = await activeReady;
        assert.equal(activeTask?.requestId, "active");
        assert(activeTask);

        const removed = submit("removed");
        const retained = submit("retained");
        submissions.push(removed, retained);
        await Promise.all([removed.accepted, retained.accepted]);
        assert.equal(owner.queueDepth(), 2);
        assert.equal(
          await tryCancelOnRunningOwner({ sessionId, targetRequestId: "missing" }),
          false,
        );
        assert.equal(activeCancels, 0);

        for (const requestId of ["active", "removed"]) {
          const duplicate = submit(requestId);
          submissions.push(duplicate);
          await assert.rejects(duplicate.result, {
            detailCode: "QUEUE_REQUEST_DUPLICATE",
            retryable: false,
          });
        }
        assert.equal(owner.queueDepth(), 2);

        assert.equal(
          await tryCancelOnRunningOwner({ sessionId, targetRequestId: "removed" }),
          true,
        );
        assert.equal(activeCancels, 0, "cancelling a queued turn must not cancel the active turn");
        await assert.rejects(removed.result, {
          detailCode: "QUEUE_REQUEST_CANCELLED",
          retryable: false,
        });
        assert.equal(owner.queueDepth(), 1);

        retained.abort.abort(new Error("observer detached"));
        await assert.rejects(retained.result, /observer detached/);
        assert.equal(owner.queueDepth(), 1, "detachment must preserve admitted work");
        assert.equal(await tryCancelOnRunningOwner({ sessionId, targetRequestId: "active" }), true);
        assert.equal(
          activeCancels,
          1,
          "dequeued starting turns retain their cancellation identity",
        );
        owner.completeTask(activeTask);
        assert.equal(
          await tryCancelOnRunningOwner({ sessionId, targetRequestId: "active" }),
          false,
        );
        assert.equal((await owner.nextTask(100))?.requestId, "retained");
      } finally {
        for (const submission of submissions) {
          submission.abort.abort();
        }
        await Promise.allSettled(submissions.map(({ result }) => result));
        await owner.close();
        await releaseQueueOwnerLease(lease);
      }
    });
  },
);

test(
  "queue acceptance and prompt write remain distinct despite throwing observers",
  { timeout: 10_000 },
  async () => {
    await withTempHome(async () => {
      const sessionId = "shared-queue-started";
      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert(lease);
      const owner = await SessionQueueOwner.start(lease, {
        cancelPrompt: async () => false,
        closeSession: async () => false,
        setSessionMode: async () => {},
        setSessionModel: async () => undefined,
        setSessionConfigOption: async () => ({ configOptions: [] }),
      });
      let accept!: () => void;
      let start!: () => void;
      let promptStarted = false;
      const accepted = new Promise<void>((resolve) => {
        accept = resolve;
      });
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const result = trySubmitToRunningOwner({
        sessionId,
        requestId: "host-request",
        requireSharedRuntime: true,
        message: "hello",
        permissionMode: "deny-all",
        resumePolicy: "same-session-only",
        outputFormatter: NOOP_OUTPUT_FORMATTER,
        waitForCompletion: true,
        onQueueAccepted: () => {
          accept();
          throw new Error("accept observer failed");
        },
        onPromptStarted: () => {
          promptStarted = true;
          start();
          throw new Error("start observer failed");
        },
      });
      void result.catch(() => {});
      try {
        await accepted;
        assert.equal(promptStarted, false);
        const task = await owner.nextTask(1_000);
        assert(task);
        assert.equal(task.requestId, "host-request");
        assert.equal(task.resumePolicy, "same-session-only");
        assert.equal(task.reportPromptStarted, true);
        task.send({ type: "prompt_started", requestId: task.requestId });
        await started;
        task.send({
          type: "error",
          requestId: task.requestId,
          code: "PERMISSION_DENIED",
          detailCode: "EXPECTED_REFUSAL",
          origin: "runtime",
          retryable: false,
          message: "refused",
        });
        await assert.rejects(result, { detailCode: "EXPECTED_REFUSAL", retryable: false });
        task.close();
        owner.completeTask(task);
      } finally {
        await owner.close();
        await releaseQueueOwnerLease(lease);
      }
    });
  },
);

test("pre-aborted shared submissions do not start an owner", async () => {
  await withTempHome(async () => {
    const reason = new Error("cancelled before submission");
    await assert.rejects(
      sendSession({
        sessionId: "never-started",
        prompt: [{ type: "text", text: "hello" }],
        permissionMode: "deny-all",
        outputFormatter: NOOP_OUTPUT_FORMATTER,
        signal: AbortSignal.abort(reason),
        queueOwnerArgs: ["missing-owner-entry.js"],
      }),
      (error) => error === reason,
    );
    assert.equal(await readQueueOwnerRecord("never-started"), undefined);
  });
});

test(
  "shared owner reports actual ACP prompt start and persists the host request ID",
  { timeout: 20_000 },
  async () => {
    await withTempHome(async (homeDir) => {
      const sessionId = "shared-runtime-native-owner";
      const record = makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: "existing-agent-session",
        cwd: homeDir,
        agentCommand: process.execPath,
        agentArgv: [
          process.execPath,
          fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
          "--supports-load-session",
        ],
      });
      await writeSessionRecordFile(homeDir, record);
      let start!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      let settled = false;
      const result = sendSession({
        sessionId,
        requestId: "host-request-survives-rpc-ids",
        requireSharedRuntime: true,
        prompt: [{ type: "text", text: "stream-sleep 100 shared-live" }],
        permissionMode: "deny-all",
        outputFormatter: NOOP_OUTPUT_FORMATTER,
        resumePolicy: "same-session-only",
        ttlMs: 1,
        onPromptStarted: start,
        queueOwnerArgs: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "__queue-owner"],
      });
      void result.then(
        () => {
          settled = true;
        },
        () => {},
      );
      try {
        await Promise.race([
          started,
          result.then(() => {
            throw new Error("owner completed without a prompt-start notification");
          }),
        ]);
        assert.equal(settled, false, "promptStarted must precede turn completion");
        const outcome = await result;
        assert(!("queued" in outcome));
        assert.equal(outcome.stopReason, "end_turn");
        assert.equal(outcome.record.lastRequestId, "host-request-survives-rpc-ids");
        assert.equal(
          (await resolveSessionRecord(sessionId)).lastRequestId,
          "host-request-survives-rpc-ids",
        );
      } finally {
        await terminateQueueOwnerForSession(sessionId);
      }
    });
  },
);

test("legacy owners reject shared submission and targeted cancellation before receiving requests", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "legacy-owner";
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ ...paths, sessionId, pid: keeper.pid });
    let requests = 0;
    const server = createSingleRequestServer((socket, request) => {
      requests += 1;
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.end(
        `${JSON.stringify({ type: "cancel_result", requestId: request.requestId, cancelled: true })}\n`,
      );
    });
    await listenServer(server, paths.socketPath);
    try {
      const unsupported = { detailCode: "QUEUE_SHARED_RUNTIME_UNSUPPORTED", retryable: false };
      await assert.rejects(
        trySubmitToRunningOwner({
          sessionId,
          requestId: "new-request",
          message: "must not run",
          permissionMode: "deny-all",
          outputFormatter: NOOP_OUTPUT_FORMATTER,
          waitForCompletion: true,
          requireSharedRuntime: true,
        }),
        unsupported,
      );
      await assert.rejects(
        tryCancelOnRunningOwner({ sessionId, targetRequestId: "new-request" }),
        unsupported,
      );
      assert.equal(requests, 0);
      assert.equal(isProcessAlive(keeper.pid), true);
      assert.equal(await tryCancelOnRunningOwner({ sessionId }), true);
      assert.equal(requests, 1, "legacy CLI cancellation remains supported");
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("queue controls reject invalid responses and preserve false results", async () => {
  let selectedCloseOwner: QueueOwnerRecord | undefined;
  const controls = [
    { type: "cancel_prompt", send: (sessionId: string) => tryCancelOnRunningOwner({ sessionId }) },
    {
      type: "close_session",
      send: (sessionId: string) =>
        tryCloseSessionOnRunningOwner({
          sessionId,
          onOwnerSelected: (owner) => {
            selectedCloseOwner = owner;
          },
        }),
    },
    {
      type: "set_mode",
      send: (sessionId: string) => trySetModeOnRunningOwner(sessionId, "plan", 1000, false),
    },
    {
      type: "set_model",
      send: (sessionId: string) => trySetModelOnRunningOwner(sessionId, "model", 1000, false),
    },
    {
      type: "set_config_option",
      send: (sessionId: string) =>
        trySetConfigOptionOnRunningOwner(sessionId, "verbosity", "terse", 1000, false),
    },
  ];
  await withTempHome(async (homeDir) => {
    const sessionId = "control-admission";
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ ...paths, sessionId, pid: keeper.pid });
    const expectedOwner = await readQueueOwnerRecord(sessionId);
    try {
      for (const control of controls) {
        for (const [scenario, detailCode] of [
          ["wrong-id", "QUEUE_PROTOCOL_MALFORMED_MESSAGE"],
          ["missing-ack", "QUEUE_ACK_MISSING"],
          ["unexpected", "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE"],
          ...(control.type === "cancel_prompt" || control.type === "close_session"
            ? [["false-result", undefined]]
            : []),
        ]) {
          const responseErrors: NodeJS.ErrnoException[] = [];
          const server = createSingleRequestServer((socket, request) => {
            // Rejecting a malformed reply can close a named pipe while this
            // fixture is still writing its next response.
            socket.on("error", (error: NodeJS.ErrnoException) => responseErrors.push(error));
            assert.equal(request.type, control.type);
            if (scenario !== "missing-ack") {
              socket.write(
                `${JSON.stringify({ type: "accepted", requestId: scenario === "wrong-id" ? "wrong" : request.requestId })}\n`,
              );
            }
            const response =
              scenario === "false-result"
                ? control.type === "cancel_prompt"
                  ? { type: "cancel_result", cancelled: false }
                  : { type: "close_session_result", closed: false }
                : { type: "event", message: { jsonrpc: "2.0", method: "synthetic" } };
            socket.end(`${JSON.stringify({ ...response, requestId: request.requestId })}\n`);
          });
          await listenServer(server, paths.socketPath);
          try {
            selectedCloseOwner = undefined;
            if (detailCode) {
              await assert.rejects(
                control.send(sessionId),
                { detailCode, origin: "queue", retryable: false },
                `${control.type}: ${scenario}`,
              );
            } else {
              assert.equal(await control.send(sessionId), false, control.type);
            }
            if (control.type === "close_session") {
              assert.deepEqual(selectedCloseOwner, expectedOwner);
            }
          } finally {
            await closeServer(server);
          }
          for (const error of responseErrors) {
            assert(detailCode, "valid control responses must not disconnect early");
            assert.equal(error.code, "EPIPE");
          }
        }
      }
    } finally {
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("close keeps the selected owner when its endpoint and lease disappear", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "close-owner-disappears";
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ ...paths, sessionId, pid: process.pid });
    const expectedOwner = await readQueueOwnerRecord(sessionId);
    let selectedOwner: QueueOwnerRecord | undefined;
    const result = await tryCloseSessionOnRunningOwner({
      sessionId,
      onOwnerSelected: (owner) => {
        selectedOwner = owner;
        unlinkSync(paths.lockPath);
      },
    });
    assert.equal(result, undefined);
    assert.deepEqual(selectedOwner, expectedOwner);
  });
});

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
        value: { configOptions: [] },
        persistsControlState: false,
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
          assert.equal(error.retryable, false);
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
          assert.equal(error.retryable, false);
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
    const queuedMessages: Array<{
      message: AcpJsonRpcMessage;
      direction?: AcpMessageDirection;
    }> = [
      {
        direction: "outbound",
        message: {
          jsonrpc: "2.0",
          id: "direction-prompt",
          method: "session/prompt",
          params: { sessionId: "agent-session", prompt: [{ type: "text", text: "hello" }] },
        },
      },
      {
        direction: "inbound",
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
      },
      { message: { jsonrpc: "2.0", id: "direction-prompt", result: { stopReason: "end_turn" } } },
    ];
    const receivedMessages: Array<{
      message: AcpJsonRpcMessage;
      direction: AcpMessageDirection | undefined;
    }> = [];
    const formatter: OutputFormatter = {
      setContext(context) {
        events.push(`context:${context.sessionId}`);
      },
      onAcpMessage(message, direction?: AcpMessageDirection) {
        receivedMessages.push({ message, direction });
        if ("method" in message && typeof message.method === "string") {
          events.push(`event:${message.method}`);
          return;
        }
        events.push("event:response");
      },
      onError(params) {
        events.push(`error:${params.code}`);
      },
      onPermissionEscalation(event) {
        events.push(`permission:${event.toolCallId}`);
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
      for (const event of queuedMessages) {
        socket.write(
          `${JSON.stringify({ type: "event", requestId: request.requestId, ...event })}\n`,
        );
      }
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
      assert.deepEqual(
        receivedMessages,
        queuedMessages.map(({ message, direction }) => ({ message, direction })),
      );
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
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () => ({
        configOptions: [],
      }),
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
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () => ({
        configOptions: [],
      }),
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

test("SessionQueueOwner preserves request ids for clients arriving during shutdown", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-shutdown-new-client";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () => ({
        configOptions: [],
      }),
    });

    try {
      owner.beginShutdown();
      const socket = await connectSocket(lease.socketPath);
      const lines = readline.createInterface({ input: socket });
      const iterator = lines[Symbol.asyncIterator]();
      socket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-during-shutdown",
          ownerGeneration: lease.ownerGeneration,
          message: "arrived during shutdown",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );

      const payload = (await nextJsonLine(iterator)) as {
        type: string;
        requestId: string;
        detailCode?: string;
        origin?: string;
        retryable?: boolean;
        message: string;
      };
      assert.equal(payload.type, "error");
      assert.equal(payload.requestId, "req-during-shutdown");
      assert.equal(payload.detailCode, "QUEUE_OWNER_CLOSED");
      assert.equal(payload.origin, "queue");
      assert.equal(payload.retryable, true);
      assert.match(payload.message, /shutting down/i);
      lines.close();
      socket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner rejects no-wait prompts when queue depth exceeds the limit", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-overloaded");
    assert(lease);

    const owner = await SessionQueueOwner.start(
      lease,
      {
        cancelPrompt: async () => false,
        closeSession: async () => false,
        setSessionMode: async () => {
          // no-op
        },
        setSessionModel: async () => {
          // no-op
        },
        setSessionConfigOption: async () => ({
          configOptions: [],
        }),
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
        waitForCompletion: false,
      })}\n`,
    );

    const secondLines = readline.createInterface({ input: secondSocket });
    const secondIterator = secondLines[Symbol.asyncIterator]();

    try {
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

for (const replaceOwner of [false, true]) {
  test(`uncertain submission preserves ${replaceOwner ? "a replacement owner" : "the observed owner"} without retry`, async () => {
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
        const respond = async () => {
          if (replaceOwner) {
            await writeQueueOwnerLock({
              lockPath,
              socketPath,
              sessionId,
              pid: keeper.pid,
              ownerGeneration: 42,
            });
          }
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
        };
        void respond().catch((error: Error) => socket.destroy(error));
      });

      await listenServer(server, socketPath);

      try {
        await assert.rejects(
          trySubmitToRunningOwner({
            sessionId,
            message: "hello",
            permissionMode: "approve-reads",
            outputFormatter: NOOP_OUTPUT_FORMATTER,
            waitForCompletion: true,
          }),
          { detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE", retryable: false },
        );
        if (replaceOwner) {
          assert.equal((await readQueueOwnerRecord(sessionId))?.ownerGeneration, 42);
        }
        await fs.access(lockPath);
        assert.equal(isProcessAlive(keeper.pid), true);
      } finally {
        await closeServer(server);
        await cleanupOwnerArtifacts({ socketPath, lockPath });
        stopProcess(keeper);
      }
    });
  });
}

test("trySubmitToRunningOwner rejects MCP config changes for a live owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "submit-mcp-config-owner-mismatch";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      mcpConfigPath: "/tmp/job-mcp.json",
      mcpConfigFingerprint: "fingerprint-v1",
    });

    try {
      await assert.rejects(
        async () =>
          await trySubmitToRunningOwner({
            sessionId,
            message: "hello",
            mcpConfigPath: "/tmp/job-mcp.json",
            mcpConfigFingerprint: "fingerprint-v2",
            permissionMode: "approve-reads",
            outputFormatter: NOOP_OUTPUT_FORMATTER,
            waitForCompletion: true,
          }),
        (error: unknown) => {
          assert(error instanceof QueueConnectionError);
          assert.equal(error.detailCode, "QUEUE_MCP_CONFIG_CONFLICT");
          assert.equal(error.retryable, false);
          return true;
        },
      );
      await fs.access(lockPath);
      assert.equal(keeper.exitCode, null);
      assert.equal(keeper.signalCode, null);
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("trySubmitToRunningOwner recovers stale owners before MCP conflict checks", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "submit-stale-mcp-config-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      mcpConfigPath: "/tmp/old-mcp.json",
      mcpConfigFingerprint: "fingerprint-v1",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      processIdentity: await verifiedProcessIdentity(keeper.pid),
    });

    try {
      const outcome = await trySubmitToRunningOwner({
        sessionId,
        message: "hello",
        mcpConfigPath: "/tmp/new-mcp.json",
        mcpConfigFingerprint: "fingerprint-v2",
        permissionMode: "approve-reads",
        outputFormatter: NOOP_OUTPUT_FORMATTER,
        waitForCompletion: true,
      });
      assert.equal(outcome, undefined);
      await assert.rejects(fs.access(lockPath));
      assert.equal(keeper.exitCode == null && keeper.signalCode == null, false);
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("trySubmitToRunningOwner marks quiet errors as outputAlreadyEmitted after formatter emits", async () => {
  // Regression test for double-emission in quiet mode.
  //
  // When the owner has not emitted an ACP error event, emitQueueOwnerError()
  // calls formatter.onError() to emit the structured error line, then must
  // return a QueueConnectionError with
  // outputAlreadyEmitted === true so that the top-level emitRequestedError
  // handler in cli-core.ts does not emit the same error a second time on
  // stderr.  Without the fix, two stderr lines would appear: one structured
  // "[acpx] error: …" from the formatter and one raw line from the catch.
  await withTempHome(async (homeDir) => {
    const sessionId = "quiet-double-emit-session";
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
          code: "RUNTIME",
          detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
          origin: "queue",
          retryable: false,
          message: "prompt failed in queue owner",
        })}\n`,
      );
      socket.end();
    });

    await listenServer(server, socketPath);

    const onErrorCalls: string[] = [];
    const spyFormatter: OutputFormatter = {
      setContext() {
        // no-op
      },
      onAcpMessage() {
        // no-op
      },
      onError(params) {
        onErrorCalls.push(params.code);
      },
      onPermissionEscalation() {
        // no-op
      },
      flush() {
        // no-op
      },
    };

    try {
      await assert.rejects(
        async () =>
          await trySubmitToRunningOwner({
            sessionId,
            message: "hello",
            permissionMode: "approve-reads",
            outputFormatter: spyFormatter,
            errorEmissionPolicy: { queueErrorAlreadyEmitted: true },
            waitForCompletion: true,
          }),
        (error: unknown) => {
          assert(error instanceof QueueConnectionError, "expected QueueConnectionError");
          // After the fix: formatter emitted once → error must be marked so
          // the top-level handler does not emit a second time.
          assert.equal(
            error.outputAlreadyEmitted,
            true,
            "QueueConnectionError must carry outputAlreadyEmitted=true when formatter already emitted",
          );
          return true;
        },
      );

      // The formatter's onError must have been called exactly once.
      assert.equal(onErrorCalls.length, 1, "formatter.onError must be called exactly once");
      assert.equal(onErrorCalls[0], "RUNTIME");
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});
