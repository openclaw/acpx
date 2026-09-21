import { appendFileSync } from "node:fs";
import readline from "node:readline";

type Request = {
  id?: string | number;
  method?: string;
  params?: { cwd?: unknown; sessionId?: unknown; prompt?: unknown };
};

const [bootPath, tracePath] = process.argv.slice(2);
if (!bootPath || !tracePath) {
  throw new Error("Expected boot marker and wire trace paths");
}
appendFileSync(bootPath, JSON.stringify({ pid: process.pid, event: "boot" }) + "\n");
const record = (direction: "in" | "out", raw: string) =>
  appendFileSync(tracePath, JSON.stringify({ pid: process.pid, direction, raw }) + "\n");
const send = (message: object) => {
  const raw = JSON.stringify(message);
  record("out", raw);
  process.stdout.write(raw + "\n");
};
const result = (id: Request["id"], value: object) => send({ jsonrpc: "2.0", id, result: value });
const failure = (id: Request["id"], message: string) =>
  send({ jsonrpc: "2.0", id, error: { code: -32602, message } });

function isTextBlock(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

for await (const raw of readline.createInterface({ input: process.stdin })) {
  record("in", raw);
  const request = JSON.parse(raw) as Request;
  const params = request.params ?? {};
  if (request.method === "initialize") {
    result(request.id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (request.method === "session/new") {
    if (typeof params.cwd !== "string") {
      failure(request.id, "Invalid cwd parameter");
    } else {
      result(request.id, { sessionId: "synthetic-session" });
    }
  } else if (request.method === "session/prompt") {
    if (typeof params.sessionId !== "string") {
      failure(request.id, "Invalid session id");
    } else if (!Array.isArray(params.prompt) || !params.prompt.every(isTextBlock)) {
      failure(request.id, "Invalid prompt content");
    } else {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Synthetic response" },
          },
        },
      });
      result(request.id, { stopReason: "end_turn" });
    }
  } else if (request.method !== "session/cancel" && request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
  }
}
