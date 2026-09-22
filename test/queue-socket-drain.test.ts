import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionQueueOwner, type QueueTask } from "../src/session/queue/ipc-server.js";
import type { QueueOwnerMessage } from "../src/session/queue/messages.js";

const STALLED_TIMEOUT_SKIP =
  process.platform === "win32" && "Windows named pipes do not expose partial write progress";

async function withOwner(
  run: (
    owner: SessionQueueOwner,
    connect: () => Promise<{ client: net.Socket; serverSocket: net.Socket }>,
  ) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-drain-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${path.basename(directory)}`
      : path.join(directory, "owner.sock");
  const owner = await SessionQueueOwner.start(
    { socketPath },
    {
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {},
      setSessionModel: async () => undefined,
      setSessionConfigOption: async () => ({ configOptions: [] }),
    },
  );
  const { server } = owner as unknown as { server: net.Server };
  const clients: net.Socket[] = [];
  try {
    await run(owner, async () => {
      const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
      const client = net.createConnection(socketPath);
      clients.push(client);
      client.on("error", () => {});
      await once(client, "connect");
      return { client, serverSocket: await accepted };
    });
  } finally {
    for (const client of clients) {
      client.destroy();
    }
    await owner.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function submit(client: net.Socket, requestId: string): void {
  client.write(
    `${JSON.stringify({ type: "submit_prompt", requestId, message: "fixture", permissionMode: "deny-all", waitForCompletion: true })}\n`,
  );
}

function sendEvents(task: QueueTask, count: number): void {
  for (let index = 0; index < count; index += 1) {
    task.send({
      type: "event",
      requestId: task.requestId,
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(128 * 1024) },
          },
        },
      },
    });
  }
}

function sendOutput(task: QueueTask, count: number): void {
  sendEvents(task, count);
  task.send({ type: "error", requestId: task.requestId, message: "finished fixture" });
}

test(
  "paused queue output has bounded socket memory and replays every byte in order",
  { timeout: 10_000 },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.pause();
      submit(client, "ordered-backlog");
      const task = await owner.nextTask(1_000);
      assert(task);
      const expected = createHash("sha256");
      expected.update(`${JSON.stringify({ type: "accepted", requestId: task.requestId })}\n`);
      for (let index = 0; index < 64; index += 1) {
        const message: QueueOwnerMessage = {
          type: "event",
          requestId: task.requestId,
          message: {
            jsonrpc: "2.0",
            method: "session/update",
            params: { text: `${index}:🍵${"x".repeat(128 * 1024)}` },
          },
        };
        task.send(message);
        expected.update(`${JSON.stringify(message)}\n`);
      }
      const result: QueueOwnerMessage = {
        type: "error",
        requestId: task.requestId,
        message: "fixture complete",
      };
      task.send(result);
      expected.update(`${JSON.stringify(result)}\n`);
      process.stdout.write(
        `QUEUE_BACKLOG ${JSON.stringify({
          writableBytes: serverSocket.writableLength,
          highWaterMark: serverSocket.writableHighWaterMark,
        })}\n`,
      );
      assert.ok(
        serverSocket.writableLength <= serverSocket.writableHighWaterMark + 64 * 1024,
        "synchronous output must stop filling socket memory at backpressure",
      );
      const actual = createHash("sha256");
      client.on("data", (chunk: Buffer) => actual.update(chunk));
      const ended = once(client, "end", { signal: AbortSignal.timeout(5_000) });
      task.close();
      owner.completeTask(task);
      client.resume();
      await ended;
      assert.equal(actual.digest("hex"), expected.digest("hex"));
    });
  },
);

test(
  "active queue sockets release stalled output despite continuing writes",
  { timeout: 8000, skip: STALLED_TIMEOUT_SKIP },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.pause();
      submit(client, "active-stalled");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      const closed = once(serverSocket, "close", { signal: AbortSignal.timeout(4000) });
      sendEvents(task, 16);
      assert.ok(serverSocket.writableLength > 0);
      const writing = setInterval(() => sendEvents(task, 1), 25);
      try {
        await closed;
        assert.equal(serverSocket.writableLength, 0);
      } finally {
        clearInterval(writing);
        task.close();
        owner.completeTask(task);
      }
    });
  },
);

test(
  "active queue sockets preserve quiet turns and progressing reads",
  { timeout: 12_000 },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      submit(client, "active-progressing");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      await delay(1250);
      assert.equal(serverSocket.destroyed, false, "a quiet prompt has no stalled output");

      let receivedBytes = 0;
      const reading = setInterval(() => {
        const chunk = client.read(64 * 1024) as Buffer | null;
        if (chunk) {
          receivedBytes += chunk.length;
        }
      }, 50);
      try {
        const drained = once(serverSocket, "drain", { signal: AbortSignal.timeout(4000) });
        const started = Date.now();
        sendEvents(task, 16);
        assert.ok(serverSocket.writableLength > 0);
        await drained;
        assert.ok(Date.now() - started > 1000, "reading must continue beyond the idle timeout");
        await delay(1250);
        assert.equal(serverSocket.destroyed, false, "a drained prompt may become quiet again");
        assert.ok(receivedBytes >= 2 * 1024 * 1024);
      } finally {
        clearInterval(reading);
        task.close();
        owner.completeTask(task);
      }
    });
  },
);

test(
  "active queue sockets rearm stalled-output cleanup after draining",
  { timeout: 8000, skip: STALLED_TIMEOUT_SKIP },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.resume();
      submit(client, "rearmed");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      const drained = once(serverSocket, "drain", { signal: AbortSignal.timeout(3000) });
      sendEvents(task, 16);
      await drained;
      client.pause();
      const closed = once(serverSocket, "close", { signal: AbortSignal.timeout(4000) });
      sendEvents(task, 128);
      await closed;
      assert.equal(serverSocket.writableLength, 0);
      task.close();
      owner.completeTask(task);
    });
  },
);

test(
  "completed queue sockets release stalled output while the owner stays usable",
  {
    timeout: 10_000,
    skip: STALLED_TIMEOUT_SKIP,
  },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.pause();
      submit(client, "stalled");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      const closed = once(serverSocket, "close", { signal: AbortSignal.timeout(3000) });
      sendOutput(task, 128);
      assert.ok(serverSocket.writableLength > 0, "fixture must fill the socket's output buffer");
      task.close();
      owner.completeTask(task);
      await closed;
      assert.equal(serverSocket.writableLength, 0);

      const next = await connect();
      next.client.resume();
      submit(next.client, "successor");
      const successor = await owner.nextTask(1000);
      assert.ok(successor);
      assert.equal(successor.requestId, "successor");
      successor.close();
      owner.completeTask(successor);
    });
  },
);

test(
  "Windows completed queue output survives a pause until its reader resumes",
  { timeout: 8000, skip: process.platform !== "win32" },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.pause();
      submit(client, "windows-paused");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      sendOutput(task, 16);
      task.close();
      owner.completeTask(task);
      await delay(1500);
      assert.equal(serverSocket.destroyed, false, "opaque pipe progress is not a safe cutoff");
      let receivedBytes = 0;
      let tail = "";
      const ended = once(client, "end", { signal: AbortSignal.timeout(4000) });
      client.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        tail = (tail + chunk.toString("utf8")).slice(-128);
      });
      client.resume();
      await ended;
      assert.ok(receivedBytes > 2 * 1024 * 1024);
      assert.match(tail, /"message":"finished fixture"/u);
    });
  },
);

test(
  "completed queue sockets allow a response that keeps draining past the idle timeout",
  {
    timeout: 10_000,
  },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client } = await connect();
      let receivedBytes = 0;
      let tail = "";
      const ended = once(client, "end");
      const reading = setInterval(() => {
        const chunk = client.read(64 * 1024) as Buffer | null;
        if (chunk) {
          receivedBytes += chunk.length;
          tail = (tail + chunk.toString("utf8")).slice(-128);
        }
      }, 50);
      try {
        submit(client, "progressing");
        const task = await owner.nextTask(1000);
        assert.ok(task);
        sendOutput(task, 16);
        const started = Date.now();
        task.close();
        owner.completeTask(task);
        await ended;
        assert.ok(Date.now() - started > 1000, "fixture must drain longer than the idle timeout");
        assert.ok(receivedBytes > 2 * 1024 * 1024);
        assert.match(tail, /"message":"finished fixture"/u);
      } finally {
        clearInterval(reading);
      }
    });
  },
);

test(
  "completed queue sockets flush their final response to a reading client",
  {
    timeout: 5000,
  },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      let response = "";
      client.setEncoding("utf8");
      client.on("data", (chunk: string) => {
        response += chunk;
      });
      const ended = once(client, "end");
      const closed = once(serverSocket, "close");
      submit(client, "reading");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      task.send({ type: "error", requestId: task.requestId, message: "finished fixture" });
      task.close();
      owner.completeTask(task);
      await Promise.all([ended, closed]);
      assert.equal(response.trim().split("\n").length, 2);
      assert.match(response, /"type":"accepted"/u);
      assert.match(response, /"message":"finished fixture"/u);
    });
  },
);
