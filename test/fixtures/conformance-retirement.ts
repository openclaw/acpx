import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getOwnProcessIdentity, type ProcessBirthIdentity } from "../../src/process-identity.js";

export type Mode =
  | "success"
  | "ignore-term"
  | "init-error"
  | "init-wait"
  | "cooperative"
  | "prompt-timeout"
  | "wrapper-exited"
  | "direct";
export type Ready = { nonce: string; pid: number; birth: ProcessBirthIdentity };
export type Receipt = {
  nonce: string;
  role: string;
  kind: string;
  pid: number;
  at: number;
  detail?: unknown;
};

const [root, nonce, role, mode] = process.argv.slice(2);
assert.ok(root && nonce && ["wrapper", "peer", "sibling"].includes(role));
assert.ok(
  [
    "success",
    "ignore-term",
    "init-error",
    "init-wait",
    "cooperative",
    "prompt-timeout",
    "wrapper-exited",
    "direct",
  ].includes(mode),
);
const fixture = fileURLToPath(import.meta.url);
let wrapped: ChildProcess | undefined;

function record(kind: string, detail?: unknown): void {
  appendFileSync(
    path.join(root, `${role}.ndjson`),
    JSON.stringify({ nonce, role, kind, pid: process.pid, at: Date.now(), detail }) + "\n",
  );
}

async function marked(name: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(root, name), "utf8")) === nonce;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitMarker(name: string): Promise<void> {
  while (!(await marked(name))) {
    await delay(20);
  }
}

// Installed before identity discovery. It is rescue, never passing evidence.
const emergency = setTimeout(() => {
  record("emergency");
  writeFileSync(path.join(root, `${role}.emergency`), nonce);
  wrapped?.kill("SIGKILL");
  process.exit(90);
}, 90_000);
let checkingStop = false;
const stopWatcher = setInterval(() => {
  if (checkingStop) {
    return;
  }
  checkingStop = true;
  void marked("stop")
    .then((stop) => {
      if (stop) {
        record("rescue-stop");
        if (role === "sibling") {
          clearTimeout(emergency);
          clearInterval(stopWatcher);
          return;
        }
        // Only this live wrapper's actual ChildProcess handle is used here.
        // The peer also watches the marker if the wrapper has already exited.
        wrapped?.kill("SIGKILL");
        process.exit(0);
      }
    })
    .catch((error: unknown) => {
      record("fixture-error", String(error));
      process.exit(91);
    })
    .finally(() => {
      checkingStop = false;
    });
}, 20);
process.on("exit", (code) => record("exit", { code }));
process.on("SIGTERM", () => {
  record("sigterm");
  if (!(role === "peer" && mode === "ignore-term")) {
    process.exit(0);
  }
});
for (const [name, stream] of [
  ["stdout", process.stdout],
  ["stderr", process.stderr],
] as const) {
  stream.on("error", (error: Error) => record(`${name}-error`, error.message));
}

async function ready(): Promise<void> {
  const birth = await getOwnProcessIdentity();
  assert.ok(birth, "fixture requires native birth identity before readiness");
  const temporary = path.join(root, `${role}.ready.${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify({ nonce, pid: process.pid, birth }));
  await fs.rename(temporary, path.join(root, `${role}.ready.json`));
  record("ready", { birth });
}

async function writeReply(value: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ jsonrpc: "2.0", ...value });
  record("reply-attempt", value);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        record("reply-written", value);
        resolve();
      }
    });
  });
}

async function run(): Promise<void> {
  await ready();
  if (await marked("stop")) {
    return;
  }
  if (role === "sibling") {
    return;
  } // Referenced watchers keep the unrelated sibling alive.
  if (role === "wrapper") {
    wrapped = spawn(process.execPath, [fixture, root, nonce, "peer", mode], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    wrapped.once("spawn", () => record("peer-spawned", { pid: wrapped?.pid }));
    wrapped.once("error", (error) => {
      record("fixture-error", error.message);
      process.exit(91);
    });
    wrapped.once("exit", (code, signal) => record("peer-exit", { code, signal }));
    wrapped.on("message", (message) => {
      if (
        (message === "peer-ready" && mode === "wrapper-exited") ||
        (message === "peer-eof" && mode === "cooperative")
      ) {
        record("planned-wrapper-exit");
        process.exit(0);
      }
    });
    return;
  }

  if (mode === "wrapper-exited") {
    if (typeof process.send !== "function") {
      throw new Error("exited-wrapper fixture requires IPC");
    }
    process.send("peer-ready");
  }
  // For the exited-wrapper case, the controller admits only after native root exit.
  await waitMarker("admit");
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.once("close", () => {
    record("stdin-eof");
    if (mode === "cooperative") {
      process.send?.("peer-eof");
    }
  });
  for await (const line of lines) {
    record("request", { line });
    const request = JSON.parse(line) as { id?: string | number; method?: string };
    if (request.id === undefined) {
      continue;
    }
    if (request.method === "initialize") {
      if (mode === "init-wait") {
        record("initialize-deliberately-unanswered", { id: request.id });
        continue;
      }
      await writeReply(
        mode === "init-error"
          ? {
              id: request.id,
              error: { code: -32077, message: "synthetic F5 initialize rejection" },
            }
          : { id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } },
      );
    } else if (request.method === "session/new") {
      await writeReply({ id: request.id, result: { sessionId: "synthetic-retirement-session" } });
    } else if (request.method === "session/prompt" && mode === "prompt-timeout") {
      record("prompt-deliberately-unanswered", { id: request.id });
    } else {
      await writeReply({
        id: request.id,
        error: { code: -32601, message: "Unexpected fixture operation" },
      });
    }
  }
  if (mode === "cooperative") {
    await delay(200);
    record("cooperative-cleanup-complete");
    clearTimeout(emergency);
    clearInterval(stopWatcher);
    return;
  }
  // Intentionally retain both timers after EOF. Only shutdown/rescue retires this peer.
  record("retaining-after-eof");
}

void run().catch((error: unknown) => {
  record("fixture-error", String(error));
  clearTimeout(emergency);
  clearInterval(stopWatcher);
  wrapped?.kill("SIGKILL");
  process.exit(91);
});
