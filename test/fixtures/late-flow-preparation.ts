import fs from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { AcpClient } from "../../src/acp/client.js";
import { FlowRunner, acp, defineFlow } from "../../src/flows/runtime.js";

const [root, mode, phase, ending] = process.argv.slice(2);
const marker = path.join(root, "unexpected-start");
let enter: () => void = () => {};
let release: () => void = () => {};
const entered = new Promise<void>((resolve) => {
  enter = resolve;
});
const held = new Promise<void>((resolve) => {
  release = resolve;
});
const gate = async () => {
  enter();
  await held;
};

// Observe attempted admission without starting an adapter in this process-level regression.
AcpClient.prototype.start = async () => {
  await fs.writeFile(marker, "late adapter admission");
  throw new Error("Synthetic adapter start rejected");
};
const outputRoot = path.join(root, "runs");
const runner = new FlowRunner({
  resolveAgent: () => ({ agentName: "synthetic", agentCommand: "synthetic", cwd: root }),
  permissionMode: "deny-all",
  outputRoot,
});
if (ending === "timeout") {
  mock.timers.enable({ apis: ["setTimeout"] });
}
const flow = defineFlow({
  name: "late-preparation",
  startAt: "held",
  nodes: {
    held: acp({
      session: { isolated: mode === "isolated" },
      timeoutMs: 20_000,
      heartbeatMs: 0,
      ...(phase === "cwd"
        ? {
            cwd: async () => {
              await gate();
              return root;
            },
          }
        : {}),
      prompt: async () => {
        if (phase === "prompt") {
          await gate();
        }
        return "synthetic";
      },
    }),
  },
  edges: [],
});
const outcome = runner.run(flow, {}).then(
  () => "success",
  (error: unknown) => (error instanceof Error ? error.name : String(error)),
);
await entered;
if (ending === "interrupt") {
  process.kill(process.pid, "SIGINT");
} else {
  mock.timers.tick(20_000);
}
const result = await outcome;
if (ending === "timeout") {
  mock.timers.reset();
}
const runDir = path.join(outputRoot, (await fs.readdir(outputRoot))[0]);
const tracePath = path.join(runDir, "trace.ndjson");
const before = await fs.readFile(tracePath, "utf8");
release();

// Natural host exit, after outstanding file work drains, detects late writes without a sleep oracle.
process.once("beforeExit", () => {
  void Promise.all([
    fs.readFile(tracePath, "utf8"),
    fs.stat(marker).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      },
    ),
  ]).then(([after, started]) => {
    process.stdout.write(
      JSON.stringify({ result, started, traceUnchanged: after === before }) + "\n",
    );
  });
});
