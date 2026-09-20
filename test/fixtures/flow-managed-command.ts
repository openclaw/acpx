import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { mock } from "node:test";
import { FlowRunner, action, defineFlow } from "../../src/flows/runtime.js";
import type { FlowNodeContext, FlowShellResult } from "../../src/flows/types.js";

const [root, mode] = process.argv.slice(2);
const pidFile = path.join(root, "owned-pids");
const sockets = new Set<Socket>();
let acceptReady: (socket: Socket) => void = () => {};
const ready = new Promise<Socket>((resolve) => {
  acceptReady = resolve;
});
let acknowledgedTermination = false;
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const split = buffer.indexOf("\n");
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line === "ready") {
        acceptReady(socket);
      } else if (line === "signal") {
        acknowledgedTermination = true;
      }
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const childPrelude = `
  const fs = require("node:fs");
  fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
  const socket = require("node:net").connect(${address.port}, "127.0.0.1");
`;
const resistantChild = `${childPrelude}
  process.on("SIGTERM", () => socket.write("signal\\n"));
  process.stdout.write("partial stdout");
  process.stderr.write("partial stderr");
  socket.once("connect", () => socket.write("ready\\n"));
`;
// This grandchild owns the wrapper's inherited stdio after that wrapper exits.
// Its tail is released only after it has observed that exact wrapper PID gone.
const lateWriter = `${childPrelude}
  const parent = Number(process.argv[1]);
  socket.once("connect", () => {
    function parentExited() {
      try { process.kill(parent, 0); setImmediate(parentExited); }
      catch (error) {
        if (error.code !== "ESRCH") throw error;
        socket.write("ready\\n");
      }
    }
    parentExited();
  });
  socket.once("data", () => {
    process.stdout.write("late stdout", () => {
      process.stderr.write("late stderr", () => socket.end());
    });
  });
`;
const wrapper = `
  require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
  process.stdout.write("early stdout", () => {
    require("node:child_process").spawn(process.execPath,
      ["-e", ${JSON.stringify(lateWriter)}, String(process.pid)],
      { stdio: ["ignore", 1, 2] });
    process.exit(0);
  });
`;

const runner = new FlowRunner({
  resolveAgent: () => ({ agentName: "synthetic", agentCommand: "unused", cwd: root }),
  permissionMode: "deny-all",
  outputRoot: path.join(root, "runs"),
  defaultNodeTimeoutMs: 0,
});
let result: FlowShellResult | undefined;
let firstError: string | undefined;
let nextError: string | undefined;
let nextDispatched = false;
let signalAborted = false;
let callbackFinished: () => void = () => {};
const callbackDone = new Promise<void>((resolve) => {
  callbackFinished = resolve;
});
async function run(context: FlowNodeContext): Promise<void> {
  assert.ok(context.runShell);
  try {
    try {
      result = await context.runShell({
        command: process.execPath,
        args: [
          "-e",
          mode === "stdio-close"
            ? wrapper
            : mode === "nonzero"
              ? 'process.stdout.write("ordinary stdout"); process.stderr.write("ordinary stderr"); process.exitCode = 7;'
              : resistantChild,
        ],
        timeoutMs: mode === "own-deadline" ? 20_000 : 0,
      });
    } catch (error) {
      firstError = error instanceof Error ? error.name : String(error);
      signalAborted = context.signal?.aborted === true;
      try {
        await context.runShell({
          command: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "late-command"))}, "unexpected")`,
          ],
        });
        nextDispatched = true;
      } catch (next) {
        nextError = next instanceof Error ? next.name : String(next);
      }
      throw error;
    }
  } finally {
    callbackFinished();
  }
}

const hasDeadline = mode === "own-deadline" || mode === "outer-timeout";
if (hasDeadline) {
  mock.timers.enable({ apis: ["setTimeout"] });
}
try {
  const outcome = runner
    .run(
      defineFlow({
        name: `managed-${mode}`,
        startAt: "command",
        nodes: {
          command: action({
            run,
            heartbeatMs: 0,
            timeoutMs: mode === "outer-timeout" ? 20_000 : 0,
          }),
        },
        edges: [],
      }),
      {},
    )
    .then(
      () => "ok",
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    );
  if (mode !== "nonzero") {
    const socket = await Promise.race([
      ready,
      outcome.then((ending) => {
        throw new Error(`Flow ended before the native readiness barrier: ${ending}`);
      }),
    ]);
    if (hasDeadline) {
      // Admission and signal handlers are proven ready before either deadline fires.
      mock.timers.tick(20_000);
      mock.timers.reset();
    } else {
      socket.write("release");
    }
  }
  const ending = await outcome;
  await callbackDone;
  const pids = await fs.readFile(pidFile, "utf8").then(
    (text) => text.trim().split("\n").map(Number),
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  const aliveAtReturn = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
      return false;
    }
  });
  process.stdout.write(
    JSON.stringify({
      ending,
      result,
      firstError,
      nextError,
      nextDispatched,
      signalAborted,
      acknowledgedTermination,
      aliveAtReturn,
    }) + "\n",
  );
} finally {
  if (hasDeadline) {
    mock.timers.reset();
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
