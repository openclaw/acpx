import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [mode, terminalPidFile, triggerFile] = process.argv.slice(2);
if (!mode || !terminalPidFile || !triggerFile) {
  throw new Error("Expected disconnect mode, terminal PID file and trigger file");
}
const sessionId = `idle-${process.pid}`;
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const watcher = fs.watch(path.dirname(triggerFile), () => {
  if (!fs.existsSync(triggerFile)) {
    return;
  }
  watcher.close();
  if (mode === "idle-exit") {
    process.exit(0);
  }
  if (mode === "idle-eof") {
    process.stdout.end();
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(2048) },
      },
    },
  });
});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line) as { id?: string | number; method?: string };
  if (message.id === "idle-terminal") {
    fs.writeFileSync(`${triggerFile}.ready`, "ready");
    return;
  }
  if (message.id == null) {
    return;
  }
  const result =
    message.method === "initialize"
      ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : message.method === "session/new"
        ? { sessionId }
        : message.method === "session/prompt"
          ? { stopReason: "end_turn" }
          : {};
  send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: "idle-terminal",
      method: "terminal/create",
      params: {
        sessionId,
        command: process.execPath,
        args: [
          "--eval",
          `require("node:fs").writeFileSync(${JSON.stringify(terminalPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
      },
    });
  }
});
lines.on("close", () => process.exit(0));
