import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "../src/async-control.js";
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
  "paused queue backlog stays bounded after repeated garbage collection",
  { timeout: 15_000, skip: !global.gc && "run with --expose-gc for retained-memory proof" },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.pause();
      submit(client, "retained-backlog");
      const task = await owner.nextTask(1_000);
      assert(task);
      global.gc!();
      const before = process.memoryUsage();
      const samples = [];
      for (let round = 0; round < 4; round += 1) {
        const started = performance.now();
        sendEvents(task, 32);
        const spillMs = performance.now() - started;
        global.gc!();
        global.gc!();
        const after = process.memoryUsage();
        samples.push({
          round,
          spillMs,
          heapGrowth: after.heapUsed - before.heapUsed,
          bufferGrowth: after.arrayBuffers - before.arrayBuffers,
        });
        assert.ok(after.heapUsed - before.heapUsed < 4 * 1024 * 1024);
        assert.ok(after.arrayBuffers - before.arrayBuffers < 2 * 1024 * 1024);
        assert.ok(serverSocket.writableLength <= serverSocket.writableHighWaterMark + 64 * 1024);
      }
      process.stdout.write(`QUEUE_SPOOL_MEMORY ${JSON.stringify(samples)}\n`);
      const next = await connect();
      let response = "";
      next.client.setEncoding("utf8").on("data", (chunk: string) => {
        response += chunk;
      });
      const ended = once(next.client, "end", { signal: AbortSignal.timeout(2_000) });
      const controlStart = performance.now();
      next.client.write(`${JSON.stringify({ type: "cancel_prompt", requestId: "control" })}\n`);
      await ended;
      process.stdout.write(
        `QUEUE_SPOOL_CONTROL ${JSON.stringify({ elapsedMs: performance.now() - controlStart })}\n`,
      );
      assert.match(response, /"cancelled":false/u);
      task.close();
      owner.completeTask(task);
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
      let completeRead!: () => void;
      const received = new Promise<void>((resolve) => {
        completeRead = resolve;
      });
      const reading = setInterval(() => {
        const chunk = client.read(64 * 1024) as Buffer | null;
        if (chunk) {
          receivedBytes += chunk.length;
          if (receivedBytes >= 2 * 1024 * 1024) {
            completeRead();
          }
        }
      }, 50);
      try {
        const started = Date.now();
        sendEvents(task, 16);
        assert.ok(serverSocket.writableLength > 0);
        // A chunk drain is no longer the whole response. Keep reading the same
        // two MiB before checking that the prompt can return to a quiet state.
        await withTimeout(received, 4_000);
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
      let receivedFrames = 0;
      const received = new Promise<void>((resolve) => {
        client.on("data", (chunk: Buffer) => {
          receivedFrames += chunk.toString().split("\n").length - 1;
          if (receivedFrames === 17) {
            resolve();
          }
        });
      });
      client.resume();
      submit(client, "rearmed");
      const task = await owner.nextTask(1000);
      assert.ok(task);
      try {
        sendEvents(task, 16);
        // One drain only releases a spool chunk; receive the accepted frame and
        // every event before testing a new transition from idle to blocked.
        await withTimeout(received, 3000);
        assert.equal(serverSocket.timeout, 0, "first burst must drain before rearming");
        assert.equal(serverSocket.writableLength, 0);
        client.pause();
        const closed = once(serverSocket, "close", { signal: AbortSignal.timeout(4000) });
        sendEvents(task, 16);
        assert.ok(serverSocket.writableLength > 0, "second burst must block the socket");
        assert.equal(serverSocket.timeout, 1000, "blocked output must rearm the timeout");
        await closed;
        assert.equal(serverSocket.writableLength, 0);
      } finally {
        task.close();
        owner.completeTask(task);
      }
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
  "owner shutdown releases completed output spools within its existing grace",
  { timeout: 5_000 },
  async () => {
    await withOwner(async (owner, connect) => {
      const { client, serverSocket } = await connect();
      client.pause();
      submit(client, "shutdown-backlog");
      const task = await owner.nextTask(1_000);
      assert(task);
      sendEvents(task, 16);
      task.close();
      owner.completeTask(task);
      const budget = (owner as unknown as { outputBudget: { files: number; bytes: number } })
        .outputBudget;
      assert.equal(budget.files, 1);
      const closed = once(serverSocket, "close");
      await owner.close();
      await closed;
      assert.equal(budget.files, 0);
      assert.equal(budget.bytes, 0);
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
