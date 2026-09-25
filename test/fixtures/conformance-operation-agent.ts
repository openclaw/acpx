import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type Message = {
  id?: number | string;
  method?: string;
  params?: { cwd?: string; prompt?: Array<{ text?: string }> };
  result?: unknown;
  error?: unknown;
};

const [mode, tracePath] = process.argv.slice(2);
const sessionId = "operation-session";
const pending = new Map<number, (message: Message) => void>();
let nextId = 100;
let cwd = "";
let traceQueue = Promise.resolve();

function record(entry: object): Promise<void> {
  traceQueue = traceQueue.then(() => fs.appendFile(tracePath, `${JSON.stringify(entry)}\n`));
  return traceQueue;
}

async function send(message: object): Promise<void> {
  const raw = `${JSON.stringify(message)}\n`;
  await record({ pid: process.pid, direction: "out", raw });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(raw, (error) => (error ? reject(error) : resolve()));
  });
}

async function request(method: string, params: object): Promise<Message> {
  const id = nextId++;
  const response = new Promise<Message>((resolve) => pending.set(id, resolve));
  await send({ jsonrpc: "2.0", id, method, params });
  return response;
}

async function prompt(message: Message): Promise<void> {
  const text = message.params?.prompt?.[0]?.text ?? "";
  if (mode === "held-read") {
    await send({
      jsonrpc: "2.0",
      id: nextId++,
      method: "fs/read_text_file",
      params: { sessionId, path: "README.md" },
    });
    const marker = process.env.ACPX_CONFORMANCE_HELD_MARKER;
    if (!marker) {
      throw new Error("Missing held-read marker");
    }
    const deadline = performance.now() + 5_000;
    while (true) {
      const entry = await fs.readFile(marker, "utf8").catch(() => undefined);
      if (entry) {
        await record({ pid: process.pid, heldRead: JSON.parse(entry) as unknown });
        break;
      }
      if (performance.now() > deadline) {
        throw new Error("Read callback did not reach the held open");
      }
      await delay(10);
    }
  } else if (mode === "permission-only") {
    await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "synthetic-tool", title: "Synthetic request", status: "pending" },
      options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }],
    });
  } else if (mode !== "fake" && mode !== "preprompt") {
    const write = text.startsWith("write ");
    const [, target, ...content] = text.split(" ");
    await request(write ? "fs/write_text_file" : "fs/read_text_file", {
      sessionId: mode === "wrong-session" ? "another-session" : sessionId,
      path: mode === "wrong-path" ? "other.txt" : target,
      ...(write ? { content: mode === "wrong-content" ? "different" : content.join(" ") } : {}),
    });
    if (write) {
      const bytes = await fs.readFile(path.join(cwd, target)).catch(() => undefined);
      await record({ pid: process.pid, effect: target, content: bytes?.toString("utf8") });
    }
  }
  await send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "permission denied; acpx; wrote .acpx-conformance-write.txt",
        },
      },
    },
  });
  await send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}

async function handle(raw: string): Promise<void> {
  await record({ pid: process.pid, direction: "in", raw });
  const message = JSON.parse(raw) as Message;
  if (!message.method && typeof message.id === "number") {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
  } else if (message.method === "initialize") {
    await send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
  } else if (message.method === "session/new") {
    cwd = message.params?.cwd ?? "";
    if (mode === "preprompt") {
      await request("fs/read_text_file", { sessionId, path: "README.md" });
    }
    await send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  } else if (message.method === "session/prompt") {
    await prompt(message);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (raw) => {
  void handle(raw).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
    lines.close();
    process.stdin.destroy();
  });
});
