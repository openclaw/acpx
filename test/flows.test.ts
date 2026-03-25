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
  parseJsonObject,
  parseStrictJsonObject,
  shell,
} from "../src/flows.js";
import { TimeoutError } from "../src/session-runtime-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const TEST_CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TEST_QUEUE_OWNER_ARGS = JSON.stringify([TEST_CLI_PATH, "__queue-owner"]);

test("extractJsonObject parses direct, fenced, and embedded JSON", () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJsonObject('before {"ok":true} after'), { ok: true });
});

test("parseJsonObject supports strict and fenced-only modes", () => {
  assert.deepEqual(parseStrictJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonObject('```json\n{"ok":true}\n```', { mode: "fenced" }), {
    ok: true,
  });
  assert.throws(() => parseStrictJsonObject('before {"ok":true} after'), /Could not parse JSON/);
  assert.throws(
    () => parseJsonObject('before {"ok":true} after', { mode: "fenced" }),
    /Could not parse JSON/,
  );
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

test("FlowRunner lets ACP nodes run in a dynamic working directory", async () => {
  await withTempHome(async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-base-cwd-"));
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-worktree-"));

    try {
      const runner = new FlowRunner({
        resolveAgent: () => ({
          agentName: "mock",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd: baseCwd,
        }),
        permissionMode: "approve-all",
        outputRoot: await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-")),
      });

      const flow = defineFlow({
        name: "dynamic-cwd-test",
        startAt: "prepare",
        nodes: {
          prepare: action({
            run: () => ({ worktree }),
          }),
          inspect: acp({
            cwd: ({ outputs }) => (outputs.prepare as { worktree: string }).worktree,
            prompt: () => {
              const script = "process.stdout.write(process.cwd())";
              return `terminal ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
            },
            parse: (text) => text.trim().split("\n")[0] ?? "",
          }),
        },
        edges: [{ from: "prepare", to: "inspect" }],
      });

      const result = await runner.run(flow, {});
      assert.equal(result.state.status, "completed");
      assert.equal(
        await fs.realpath(String(result.state.outputs.inspect)),
        await fs.realpath(worktree),
      );
      const bindings = Object.values(result.state.sessionBindings);
      assert.equal(bindings.length, 1);
      assert.equal(await fs.realpath(bindings[0]?.cwd ?? ""), await fs.realpath(worktree));
    } finally {
      await fs.rm(baseCwd, { recursive: true, force: true });
      await fs.rm(worktree, { recursive: true, force: true });
    }
  });
});

test("FlowRunner keeps same session handles isolated by working directory", async () => {
  await withTempHome(async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-base-cwd-"));
    const worktreeA = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-worktree-a-"));
    const worktreeB = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-worktree-b-"));

    try {
      const runner = new FlowRunner({
        resolveAgent: () => ({
          agentName: "mock",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd: baseCwd,
        }),
        permissionMode: "approve-all",
        outputRoot: await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-")),
      });

      const flow = defineFlow({
        name: "session-cwd-split-test",
        startAt: "first",
        nodes: {
          first: acp({
            session: {
              handle: "main",
            },
            cwd: () => worktreeA,
            prompt: () => 'echo {"where":"A"}',
            parse: (text) => extractJsonObject(text),
          }),
          second: acp({
            session: {
              handle: "main",
            },
            cwd: () => worktreeB,
            prompt: () => 'echo {"where":"B"}',
            parse: (text) => extractJsonObject(text),
          }),
        },
        edges: [{ from: "first", to: "second" }],
      });

      const result = await runner.run(flow, {});
      assert.equal(result.state.status, "completed");
      assert.deepEqual(result.state.outputs.first, { where: "A" });
      assert.deepEqual(result.state.outputs.second, { where: "B" });
      const bindings = Object.values(result.state.sessionBindings);
      assert.equal(bindings.length, 2);
      const bindingCwds = new Set(bindings.map((binding) => binding.cwd));
      assert.deepEqual(bindingCwds, new Set([worktreeA, worktreeB]));
    } finally {
      await fs.rm(baseCwd, { recursive: true, force: true });
      await fs.rm(worktreeA, { recursive: true, force: true });
      await fs.rm(worktreeB, { recursive: true, force: true });
    }
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
  const previousQueueOwnerArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-home-"));
  process.env.HOME = homeDir;
  process.env.ACPX_QUEUE_OWNER_ARGS = TEST_QUEUE_OWNER_ARGS;

  try {
    await run(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousQueueOwnerArgs === undefined) {
      delete process.env.ACPX_QUEUE_OWNER_ARGS;
    } else {
      process.env.ACPX_QUEUE_OWNER_ARGS = previousQueueOwnerArgs;
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
