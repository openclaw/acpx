import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

type Message = {
  id?: string | number;
  method?: string;
  params?: { cwd?: string; sessionId?: string };
};
const order = process.argv[2];
let failedLoad: Message | undefined;
let pendingNew: Message | undefined;

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function failLoad(): void {
  send({ id: failedLoad?.id, error: { code: -32002, message: "Resource not found" } });
}
function readWithCollidingId(message: Message): void {
  send({
    id: failedLoad?.id,
    method: "fs/read_text_file",
    params: {
      sessionId: message.params?.sessionId ?? "replacement",
      path: path.join(message.params?.cwd ?? process.cwd(), "collision.txt"),
    },
  });
}
function finishNew(message: Message): void {
  send({ id: message.id, result: { sessionId: randomUUID() } });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as Message;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
      });
      break;
    case "session/load":
      failedLoad = message;
      if (order === "before") {
        readWithCollidingId(message);
      } else {
        failLoad();
      }
      break;
    case "session/new":
      if (failedLoad && order === "after") {
        pendingNew = message;
        readWithCollidingId(message);
      } else {
        finishNew(message);
      }
      break;
    case "session/prompt":
      send({ id: message.id, result: { stopReason: "end_turn" } });
      break;
    case undefined:
      if (message.id === failedLoad?.id) {
        if (order === "before") {
          failLoad();
        } else if (pendingNew) {
          finishNew(pendingNew);
        }
      }
      break;
    default:
      if (message.id !== undefined) {
        send({ id: message.id, result: {} });
      }
  }
}
