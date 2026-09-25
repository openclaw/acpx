import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlowRunner, acp, defineFlow, type FlowDefinition } from "../../src/flows.js";
import {
  CHECKPOINT_COUNTS,
  TURN_COUNT,
  nodeForTurn,
  promptForTurn,
} from "./viewer-lossless-contract.js";

const root = process.argv[2];
const failureDeadlineAt = Number(process.argv[3]);
if (!root || !path.isAbsolute(root) || !Number.isSafeInteger(failureDeadlineAt)) {
  throw new Error("Expected an absolute owned fixture root and failure deadline");
}
const outputRoot = path.join(root, "runs");
const cwd = path.join(root, "cwd");
await fs.mkdir(cwd, { recursive: true });
const peer = fileURLToPath(new URL("./viewer-lossless-agent.js", import.meta.url));
const runner = new FlowRunner({
  resolveAgent: () => ({
    agentName: "mock",
    agentCommand: "viewer-lossless-synthetic-peer",
    agentArgv: [
      process.execPath,
      peer,
      path.join(root, "peer-receipts.ndjson"),
      String(failureDeadlineAt),
      "--supports-load-session",
    ],
    cwd,
  }),
  permissionMode: "deny-all",
  defaultNodeTimeoutMs: 5_000,
  outputRoot,
});
const nodes: FlowDefinition["nodes"] = {};
const edges: FlowDefinition["edges"] = [];
for (let index = 0; index < TURN_COUNT; index += 1) {
  const completedTurns = index;
  nodes[nodeForTurn(index)] = acp({
    session: { handle: "main" },
    prompt: async ({ state }) => {
      if (CHECKPOINT_COUNTS.some((count) => count === completedTurns)) {
        // Public callback holds the next prompt before any wire submission.
        // Previous outcomes/checkpoint writes have settled; no private store hooks.
        const destination = path.join(root, "checkpoints", String(completedTurns), state.runId);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(path.join(outputRoot, state.runId), destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      return promptForTurn(index);
    },
  });
  if (index > 0) {
    edges.push({ from: nodeForTurn(index - 1), to: nodeForTurn(index) });
  }
}
// FlowRunner.run() has no public cancel()/AbortSignal argument. During execution
// its runWithOwnership() -> withInterrupt() boundary registers SIGTERM itself.
// Do not add a competing process handler that calls process.exit() here.
const result = await runner.run(
  defineFlow({
    name: "viewer-lossless-synthetic-capture",
    startAt: nodeForTurn(0),
    nodes,
    edges,
  }),
  {},
);
assert.equal(result.state.status, "completed");
assert.equal(result.state.steps.length, TURN_COUNT);
assert.equal(Object.keys(result.state.sessionBindings).length, 1);
// Emit only after FlowRunner has settled its public run() cleanup boundary.
process.stdout.write(`${JSON.stringify({ runId: result.state.runId, turnCount: TURN_COUNT })}\n`);
