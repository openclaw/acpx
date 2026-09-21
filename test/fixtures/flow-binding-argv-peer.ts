import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

type Request = {
  id?: string | number;
  method?: string;
  params?: {
    sessionId?: string;
    prompt?: Array<{ type?: string; text?: string }>;
  };
};

const [receiptPath, stateDirectory, ...invocation] = process.argv.slice(2);
if (!receiptPath || !stateDirectory || invocation.length === 0) {
  throw new Error("Expected receipt path, state directory and invocation marker");
}
const key = createHash("sha256").update(JSON.stringify(invocation)).digest("hex");
const statePath = path.join(stateDirectory, `${key}.json`);

function record(details: Record<string, unknown>): void {
  fs.appendFileSync(
    receiptPath,
    `${JSON.stringify({ pid: process.pid, invocation, ...details })}\n`,
  );
}

async function send(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function existingSession(): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(statePath, "utf8")) as { sessionId: string }).sessionId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function handle(request: Request): Promise<void> {
  const prompt = (request.params?.prompt ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  record({
    kind: "request",
    method: request.method,
    sessionId: request.params?.sessionId,
    ...(request.method === "session/prompt" ? { prompt } : {}),
  });
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    await send({
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "synthetic-argv-peer", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "session/new") {
    const sessionId = `argv-${randomUUID()}`;
    fs.writeFileSync(statePath, JSON.stringify({ sessionId }), { mode: 0o600 });
    record({ kind: "created", sessionId });
    await send({ id: request.id, result: { sessionId } });
    return;
  }
  if (request.method === "session/load" || request.method === "session/prompt") {
    const sessionId = existingSession();
    if (!sessionId || request.params?.sessionId !== sessionId) {
      await send({ id: request.id, error: { code: -32002, message: "Resource not found" } });
      return;
    }
    if (request.method === "session/load") {
      await send({ id: request.id, result: {} });
      return;
    }
    await send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ invocation, sessionId, prompt }) },
        },
      },
    });
    await send({ id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  await send({ id: request.id, error: { code: -32601, message: "Method not found" } });
}

async function main(): Promise<void> {
  record({ kind: "started" });
  setTimeout(() => process.exit(91), 60_000).unref();
  for await (const line of readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    await handle(JSON.parse(line) as Request);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(92);
});
