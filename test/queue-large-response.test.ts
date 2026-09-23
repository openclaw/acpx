import assert from "node:assert/strict";
import type net from "node:net";
import test from "node:test";
import {
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySubmitToRunningOwner,
} from "../src/session/queue/ipc.js";
import type { AcpJsonRpcMessage, SessionSendOutcome, SessionSendResult } from "../src/types.js";
import { closeServer, createSingleRequestServer, listenServer } from "./queue-test-helpers.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const FORMER_RESPONSE_LIMIT = 10 * 1024 * 1024;
type ResponseContext = { requestId: string; cwd: string; ownerGeneration: number };

function completedResult(cwd: string, text = "small"): SessionSendResult {
  return {
    sessionId: "large-response",
    stopReason: "end_turn",
    resumed: true,
    permissionStats: { requested: 0, approved: 0, denied: 0, cancelled: 0 },
    record: makeSessionRecord({
      acpxRecordId: "large-response",
      acpSessionId: "native-session",
      agentCommand: "synthetic-peer",
      cwd,
      messages: [{ Agent: { content: [{ Text: text }], tool_results: {} } }],
    }),
  };
}

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function withResponse(
  body: (context: ResponseContext) => Buffer[],
  inspect: (context: {
    result: Promise<SessionSendOutcome | undefined>;
    messages: AcpJsonRpcMessage[];
    written: Promise<void>;
    abort: AbortController;
    cwd: string;
  }) => Promise<void>,
  keepOpen = false,
): Promise<void> {
  await withTempHome("acpx-large-response-", async (cwd) => {
    const lease = await tryAcquireQueueOwnerLease("large-response");
    assert(lease);
    const sockets = new Set<net.Socket>();
    const writes: Promise<void>[] = [];
    let requestCount = 0;
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    const server = createSingleRequestServer((socket, request) => {
      requestCount += 1;
      const context = { requestId: request.requestId, cwd, ownerGeneration: lease.ownerGeneration };
      const chunks = [
        line({
          type: "accepted",
          requestId: context.requestId,
          ownerGeneration: context.ownerGeneration,
        }),
        ...body(context),
      ];
      writes.push(
        (async () => {
          try {
            for (const chunk of chunks) {
              if (socket.destroyed) {
                break;
              }
              await new Promise<void>((resolve) => socket.write(chunk, () => resolve()));
            }
            if (!keepOpen) {
              socket.end();
            }
          } finally {
            markWritten();
          }
        })(),
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    const abort = new AbortController();
    const messages: AcpJsonRpcMessage[] = [];
    let result: Promise<SessionSendOutcome | undefined> | undefined;
    try {
      await listenServer(server, lease.socketPath);
      result = trySubmitToRunningOwner({
        sessionId: lease.sessionId,
        requestId: "response-request",
        message: "small prompt",
        permissionMode: "deny-all",
        waitForCompletion: true,
        signal: abort.signal,
        outputFormatter: {
          setContext() {},
          onAcpMessage(message) {
            messages.push(message);
          },
          onError() {},
          onPermissionEscalation() {},
          flush() {},
        },
      });
      void result.catch(() => {});
      await inspect({ result, messages, written, abort, cwd });
      assert.equal(requestCount, 1, "transport failure must not resubmit the request");
    } finally {
      abort.abort();
      await result?.catch(() => {});
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(writes);
      await closeServer(server);
      await releaseQueueOwnerLease(lease);
    }
  });
}

for (const kind of ["event", "unicode-event", "result"] as const) {
  test(`queue receives an exact large ${kind} above the former response ceiling`, async () => {
    const text =
      kind === "unicode-event" ? "🦞".repeat(6 * 1024 * 1024) : "x".repeat(11 * 1024 * 1024);
    const event: AcpJsonRpcMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "native-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    };
    await withResponse(
      ({ requestId, cwd, ownerGeneration }) => {
        const response = completedResult(cwd, kind === "result" ? text : "small");
        const frame =
          kind === "result"
            ? line({ type: "result", requestId, ownerGeneration, result: response })
            : line({ type: "event", requestId, ownerGeneration, message: event });
        assert(frame.length > FORMER_RESPONSE_LIMIT);
        assert(frame.toString("utf8").length > FORMER_RESPONSE_LIMIT);
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < frame.length; offset += 65_537) {
          chunks.push(frame.subarray(offset, offset + 65_537));
        }
        if (kind !== "result") {
          chunks.push(line({ type: "result", requestId, ownerGeneration, result: response }));
        }
        return chunks;
      },
      async ({ result, messages, cwd }) => {
        assert.equal(
          JSON.stringify(await result),
          JSON.stringify(completedResult(cwd, kind === "result" ? text : "small")),
        );
        assert.deepEqual(messages, kind === "result" ? [] : [event]);
      },
    );
  });
}

test("queue preserves blank lines, fragmented Unicode and coalesced ordered responses", async () => {
  const events: AcpJsonRpcMessage[] = [
    { jsonrpc: "2.0", id: "first", result: { text: "a🦞z" } },
    { jsonrpc: "2.0", id: "second", result: { text: "second" } },
  ];
  await withResponse(
    ({ requestId, cwd, ownerGeneration }) => {
      const first = line({ type: "event", requestId, ownerGeneration, message: events[0] });
      const split = first.indexOf(Buffer.from("🦞")) + 1;
      return [
        Buffer.from("\n \r\n"),
        first.subarray(0, split),
        first.subarray(split, split + 1),
        Buffer.concat([
          first.subarray(split + 1),
          line({ type: "event", requestId, ownerGeneration, message: events[1] }),
          line({ type: "result", requestId, ownerGeneration, result: completedResult(cwd) }),
          Buffer.from("ignored after terminal result\n"),
        ]),
      ];
    },
    async ({ result, messages, cwd }) => {
      assert.equal(JSON.stringify(await result), JSON.stringify(completedResult(cwd)));
      assert.deepEqual(messages, events);
    },
  );
});

for (const ending of ["EOF", "abort"] as const) {
  test(`queue keeps incomplete large responses unsuccessful on ${ending}`, async () => {
    const reason = new Error("observer stopped waiting");
    await withResponse(
      () => [Buffer.from("x".repeat(FORMER_RESPONSE_LIMIT + 1))],
      async ({ result, messages, written, abort }) => {
        if (ending === "abort") {
          await written;
          abort.abort(reason);
          await assert.rejects(result, (error: unknown) => error === reason);
        } else {
          await assert.rejects(result, {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
            retryable: false,
          });
        }
        assert.deepEqual(messages, []);
      },
      ending === "abort",
    );
  });
}
