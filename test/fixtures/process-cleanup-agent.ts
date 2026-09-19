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

let inspectionRequestId: string | number | undefined;
const inspectedSession = {
  sessionId: "inspection-session",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "inspected",
      options: [
        { value: "inspected", name: process.env.ACPX_INSPECTION_MODEL_NAME ?? "Inspected" },
      ],
    },
  ],
};
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line) as { id?: string | number; method?: string };
  fs.appendFileSync(`${pidFile}.messages`, `${line}\n`);
  if (request.id === "inspection-permission") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: inspectionRequestId, result: inspectedSession }) + "\n",
    );
    return;
  }
  // "silent" models a non-ACP command: it keeps stdio open and never answers.
  if (request.id == null || mode === "silent") {
    return;
  }
  if (
    (mode === "init-hang" && request.method === "initialize") ||
    (mode === "session-hang" && request.method === "session/new")
  ) {
    return;
  }
  if (mode === "inspect" && request.method === "session/new") {
    inspectionRequestId = request.id;
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "inspection-permission",
        method: "session/request_permission",
        params: {
          sessionId: inspectedSession.sessionId,
          toolCall: {
            toolCallId: "inspection-write",
            title: "Write during inspection",
            kind: "edit",
          },
          options: [
            { kind: "allow_once", optionId: "allow", name: "Allow" },
            { kind: "reject_once", optionId: "deny", name: "Deny" },
          ],
        },
      }) + "\n",
    );
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
      : request.method === "session/new" && mode === "session-fail"
        ? { error: { code: -32603, message: "synthetic session failure" } }
        : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\n");
  if (request.method === "session/new" && mode === "bridge-exit") {
    setTimeout(() => process.exit(0), 100);
  }
});
lines.on("close", () => process.exit(0));
