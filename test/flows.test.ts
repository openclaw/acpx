import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FlowRunner,
  acp,
  action,
  checkpoint,
  compute,
  defineFlow,
  extractJsonObject,
  flowRunsBaseDir,
  shell,
} from "../src/flows.js";
import { TimeoutError } from "../src/session-runtime-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

test("extractJsonObject parses direct, fenced, and embedded JSON", () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJsonObject('before {"ok":true} after'), { ok: true });
});

test("FlowRunner executes isolated ACP nodes and branches deterministically", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-cwd-"));

    try {
      const runner = new FlowRunner({
        resolveAgent: () => ({
          agentName: "mock",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd,
        }),
        permissionMode: "approve-all",
        ttlMs: 1_000,
      });

      const flow = defineFlow({
        name: "branch-test",
        startAt: "first",
        nodes: {
          first: acp({
            session: {
              isolated: true,
            },
            async prompt({ input }) {
              const next = (input as { next: string }).next;
              return `echo ${JSON.stringify({ next })}`;
            },
            parse: (text) => extractJsonObject(text),
          }),
          second: acp({
            session: {
              isolated: true,
            },
            async prompt() {
              return 'echo {"seen":"second"}';
            },
            parse: (text) => extractJsonObject(text),
          }),
          route: compute({
            run: ({ outputs }) => ({
              next: String((outputs.first as { next: string }).next),
            }),
          }),
          yes: action({
            run: () => ({ ok: true }),
          }),
          no: action({
            run: () => ({ ok: false }),
          }),
        },
        edges: [
          { from: "first", to: "second" },
          { from: "second", to: "route" },
          {
            from: "route",
            switch: {
              on: "$.next",
              cases: {
                yes: "yes",
                no: "no",
              },
            },
          },
        ],
      });

      const result = await runner.run(flow, { next: "yes" });
      assert.equal(result.state.status, "completed");
      assert.deepEqual(result.state.outputs.yes, { ok: true });
      assert.equal(result.state.outputs.no, undefined);
      assert.match(result.runDir, new RegExp(escapeRegExp(flowRunsBaseDir(homeDir))));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("FlowRunner stops at checkpoint nodes and marks the run as waiting", async () => {
  await withTempHome(async () => {
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "unused",
        agentCommand: "unused",
        cwd: process.cwd(),
      }),
      permissionMode: "approve-all",
      outputRoot: await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-")),
    });

    const flow = defineFlow({
      name: "checkpoint-test",
      startAt: "prepare",
      nodes: {
        prepare: action({
          run: () => ({ prepared: true }),
        }),
        wait_for_human: checkpoint({
          summary: "needs review",
        }),
        after_wait: action({
          run: () => ({ unreachable: true }),
        }),
      },
      edges: [
        { from: "prepare", to: "wait_for_human" },
        { from: "wait_for_human", to: "after_wait" },
      ],
    });

    const result = await runner.run(flow, {});
    assert.equal(result.state.status, "waiting");
    assert.equal(result.state.waitingOn, "wait_for_human");
    assert.deepEqual(result.state.outputs.prepare, { prepared: true });
    assert.equal(result.state.outputs.after_wait, undefined);
  });
});

test("FlowRunner executes native shell actions and parses structured output", async () => {
  await withTempHome(async () => {
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "unused",
        agentCommand: "unused",
        cwd: process.cwd(),
      }),
      permissionMode: "approve-all",
      outputRoot: await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-")),
    });

    const flow = defineFlow({
      name: "shell-test",
      startAt: "transform",
      nodes: {
        transform: shell({
          exec: () => ({
            command: process.execPath,
            args: ["-e", 'process.stdout.write(JSON.stringify({ok:true, value:"shell"}))'],
          }),
          parse: (result) => extractJsonObject(result.stdout),
        }),
      },
      edges: [],
    });

    const result = await runner.run(flow, {});
    assert.equal(result.state.status, "completed");
    assert.deepEqual(result.state.outputs.transform, { ok: true, value: "shell" });
  });
});

test("FlowRunner persists active node state while a shell step is running", async () => {
  await withTempHome(async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-"));
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "unused",
        agentCommand: "unused",
        cwd: process.cwd(),
      }),
      permissionMode: "approve-all",
      outputRoot,
    });

    const flow = defineFlow({
      name: "heartbeat-test",
      startAt: "slow",
      nodes: {
        slow: shell({
          heartbeatMs: 25,
          exec: () => ({
            command: process.execPath,
            args: [
              "-e",
              "setTimeout(() => process.stdout.write(JSON.stringify({done:true})), 150)",
            ],
          }),
          parse: (result) => extractJsonObject(result.stdout),
        }),
      },
      edges: [],
    });

    const runPromise = runner.run(flow, {});
    const runDir = await waitForRunDir(outputRoot, "heartbeat-test");
    const activeState = await waitFor(async () => {
      const state = await readRunJson(runDir);
      if (state.currentNode === "slow" && state.status === "running") {
        return state;
      }
      return null;
    }, 2_000);

    assert.equal(activeState.currentNode, "slow");
    assert.equal(activeState.currentNodeKind, "action");
    assert.ok(typeof activeState.currentNodeStartedAt === "string");
    assert.ok(typeof activeState.lastHeartbeatAt === "string");

    const result = await runPromise;
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.currentNode, undefined);
  });
});

test("FlowRunner marks timed out shell steps explicitly", async () => {
  await withTempHome(async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-"));
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "unused",
        agentCommand: "unused",
        cwd: process.cwd(),
      }),
      permissionMode: "approve-all",
      outputRoot,
    });

    const flow = defineFlow({
      name: "timeout-test",
      startAt: "slow",
      nodes: {
        slow: shell({
          exec: () => ({
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 1000)"],
            timeoutMs: 50,
          }),
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "timeout-test");
    const state = await readRunJson(runDir);
    assert.equal(state.status, "timed_out");
    assert.equal(state.currentNode, "slow");
    assert.match(String(state.error), /Timed out after 50ms/);
  });
});

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-home-"));
  process.env.HOME = homeDir;

  try {
    await run(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForRunDir(outputRoot: string, flowName: string): Promise<string> {
  return await waitFor(async () => {
    const entries = await fs.readdir(outputRoot);
    const match = entries.find((entry) => entry.includes(flowName));
    return match ? path.join(outputRoot, match) : null;
  }, 2_000);
}

async function readRunJson(runDir: string): Promise<Record<string, unknown>> {
  const payload = await fs.readFile(path.join(runDir, "run.json"), "utf8");
  return JSON.parse(payload) as Record<string, unknown>;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value != null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for condition");
}
