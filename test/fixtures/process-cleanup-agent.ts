import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const [mode, pidFile] = process.argv.slice(2);
if (!mode || !pidFile) {
  throw new Error("Expected cleanup mode and PID file");
}
const child = spawn(
  process.execPath,
  [
    "--eval",
    `${mode === "ignore-term" ? 'process.on("SIGTERM", () => {});' : ""}
     setInterval(() => {}, 1000);
     process.send("ready");`,
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: mode === "detached" },
);
await new Promise<void>((resolve, reject) => {
  child.once("message", () => resolve());
  child.once("error", reject);
});
child.disconnect();
child.unref();
const pendingPidFile = `${pidFile}.pending`;
fs.writeFileSync(pendingPidFile, JSON.stringify({ bridge: process.pid, descendant: child.pid }));
fs.renameSync(pendingPidFile, pidFile);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line) as { id?: string | number; method: string };
  if (request.id == null) {
    return;
  }
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "cleanup-fixture", version: "1" },
        }
      : { sessionId: "cleanup-session" };
  const response =
    request.method === "initialize" && mode === "init-fail"
      ? { error: { code: -32603, message: "synthetic initialization failure" } }
      : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\n");
  if (request.method === "session/new" && mode === "bridge-exit") {
    setTimeout(() => process.exit(0), 100);
  }
});
lines.on("close", () => process.exit(0));
