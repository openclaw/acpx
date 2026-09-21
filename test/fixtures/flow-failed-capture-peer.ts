import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

type Request = {
  id?: string | number;
  method?: string;
  params?: {
    sessionId?: string;
    prompt?: Array<{ type?: string; text?: string }>;
  };
};

const [receiptPath, sessionPath] = process.argv.slice(2);
if (!receiptPath || !sessionPath) {
  throw new Error("Expected receipt and synthetic session-state paths");
}

function receipt(value: Record<string, unknown>): void {
  fs.appendFileSync(receiptPath, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
}

async function send(message: Record<string, unknown>): Promise<void> {
  const wire = { jsonrpc: "2.0", ...message };
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(wire)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  receipt({ kind: "sent", message: wire });
}

function savedSessionId(): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { sessionId: string }).sessionId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function handle(request: Request): Promise<void> {
  receipt({ kind: "received", message: request });
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    await send({
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "flow-failed-capture-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "session/new") {
    const sessionId = `capture-provider-${randomUUID()}`;
    fs.writeFileSync(sessionPath, JSON.stringify({ sessionId }));
    await send({ id: request.id, result: { sessionId } });
    return;
  }
  if (request.method === "session/load" || request.method === "session/prompt") {
    const sessionId = savedSessionId();
    if (!sessionId || request.params?.sessionId !== sessionId) {
      await send({ id: request.id, error: { code: -32002, message: "Resource not found" } });
      return;
    }
    if (request.method === "session/load") {
      await send({ id: request.id, result: {} });
      return;
    }
    const text = (request.params.prompt ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const command = /^(success|rpc-error|disconnect):([a-z-]+)$/u.exec(text);
    if (!command) {
      await send({ id: request.id, error: { code: -32602, message: "Invalid fixture command" } });
      return;
    }
    const [, mode, marker] = command;
    await send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `DIAGNOSTIC_${marker}` },
        },
      },
    });
    if (mode === "rpc-error") {
      await send({
        id: request.id,
        error: { code: -32077, message: `SYNTHETIC_FAILURE_${marker}` },
      });
    } else if (mode === "disconnect") {
      // The diagnostic write has completed before this deliberate transport exit.
      receipt({ kind: "disconnect", sessionId, marker });
      process.exit(23);
    } else {
      await send({ id: request.id, result: { stopReason: "end_turn" } });
    }
    return;
  }
  await send({ id: request.id, error: { code: -32601, message: "Method not found" } });
}

async function main(): Promise<void> {
  receipt({ kind: "started" });
  // A broken test must not retain a peer forever after its parent stops progressing.
  setTimeout(() => process.exit(91), 45_000).unref();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    await handle(JSON.parse(line) as Request);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(92);
});
