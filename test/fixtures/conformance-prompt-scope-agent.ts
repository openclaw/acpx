import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import readline from "node:readline";

type Request = {
  id: number;
  method: string;
  params?: { sessionId?: string; prompt?: Array<{ text?: string }> };
};
const mode = process.argv[2];
const tracePath = process.argv[3];
function record(kind: string, detail: object): void {
  if (tracePath) {
    appendFileSync(tracePath, `${JSON.stringify({ pid: process.pid, kind, ...detail })}\n`, {
      mode: 0o600,
    });
  }
}
assert.ok(
  [
    "preprompt",
    "turn1-only",
    "turn2-only",
    "before",
    "after",
    "before-after",
    "duplicates",
    "invalid",
    "normalized",
    "wrong-session",
    "reject",
    "overlap",
    "reorder",
    "pending",
  ].includes(mode),
);
let sessions = 0;
let turns = 0;
let olderReleased = false;
const waiting: Request[] = [];
const result = (request: Request) => ({
  jsonrpc: "2.0",
  id: request.id,
  result: { stopReason: "end_turn" },
});
const update = (sessionId: string | undefined, text: unknown) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  },
});
function send(frames: object[]): void {
  const raw = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
  record("send", { raw });
  process.stdout.write(raw, (error) => record("write-callback", { error: error?.message ?? null }));
}
function answer(request: Request): void {
  turns += 1;
  const sessionId = request.params?.sessionId;
  const terminal = result(request);
  const text = request.params?.prompt?.[0]?.text;
  if (mode === "overlap" || mode === "reorder") {
    waiting.push(request);
    if (waiting.length < 2) {
      return;
    }
    const [first, second] = waiting;
    if (mode === "reorder") {
      send([update(second.params?.sessionId, "new-one"), result(second)]);
    } else {
      send([
        update(first.params?.sessionId, "first"),
        ...(first.params?.sessionId === second.params?.sessionId
          ? []
          : [
              update("unowned-session", "wrong-session"),
              update(second.params?.sessionId, "second"),
            ]),
        result(first),
        result(second),
      ]);
    }
    return;
  }
  if (mode === "pending") {
    return;
  }
  if (
    mode === "preprompt" ||
    (mode === "turn1-only" && turns === 2) ||
    (mode === "turn2-only" && turns === 1)
  ) {
    send([terminal]);
  } else if (mode === "after") {
    send([terminal, update(sessionId, "late")]);
  } else if (mode === "before-after") {
    send([update(sessionId, "early"), terminal, update(sessionId, "late")]);
  } else if (mode === "duplicates") {
    send([update(sessionId, "identical"), terminal, update(sessionId, "identical")]);
  } else if (mode === "invalid") {
    send([update(sessionId, 42), terminal]);
  } else if (mode === "normalized") {
    const notification = update(sessionId, "normalized");
    send([
      update(sessionId, 42),
      { ...notification, params: { ...notification.params, _meta: 17 } },
      terminal,
    ]);
  } else if (mode === "wrong-session") {
    send([update("unowned-session", "wrong"), terminal]);
  } else if (mode === "reject") {
    send([
      update(sessionId, "before-error"),
      { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Synthetic rejection" } },
      update(sessionId, "after-error"),
    ]);
  } else {
    const count = mode === "turn1-only" || mode === "turn2-only" || text === "two" ? 2 : 1;
    send([...Array.from({ length: count }, (_, i) => update(sessionId, `reply-${i}`)), terminal]);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.once("end", () => record("stdin-eof", {}));
process.once("exit", (code) => record("exit", { code }));
lines.on("line", (line) => {
  record("receive-line", { raw: line });
  const request = JSON.parse(line) as Request;
  if (request.method === "initialize") {
    send([
      { jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } },
    ]);
  } else if (request.method === "session/new") {
    const sessionId = `scope-session-${++sessions}`;
    if (mode === "reorder" && waiting.length === 2 && !olderReleased) {
      olderReleased = true;
      const first = waiting[0];
      send([
        update(first.params?.sessionId, "old-one"),
        update(first.params?.sessionId, "old-two"),
        result(first),
      ]);
    }
    send([
      ...(mode === "preprompt"
        ? [update(sessionId, "initial-one"), update(sessionId, "initial-two")]
        : []),
      { jsonrpc: "2.0", id: request.id, result: { sessionId } },
    ]);
  } else if (request.method === "session/prompt") {
    answer(request);
  }
});
