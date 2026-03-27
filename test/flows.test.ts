import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractJsonObject, parseJsonObject, parseStrictJsonObject } from "../src/flows/json.js";
import {
  FlowRunner,
  acp,
  action,
  checkpoint,
  compute,
  defineFlow,
  shell,
} from "../src/flows/runtime.js";
import type { ShellActionExecution } from "../src/flows/runtime.js";
import { flowRunsBaseDir } from "../src/flows/store.js";
import { TimeoutError } from "../src/session-runtime-helpers.js";
import type { PromptInput } from "../src/types.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const TEST_CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TEST_QUEUE_OWNER_ARGS = JSON.stringify([TEST_CLI_PATH, "__queue-owner"]);

test("extractJsonObject parses direct, fenced, and embedded JSON", () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJsonObject('before {"ok":true} after'), { ok: true });
  assert.deepEqual(extractJsonObject('status {not json} then {"ok":true}'), { ok: true });
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

test("FlowRunner writes isolated ACP bundle traces and artifacts", async () => {
  await withTempHome(async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-isolated-trace-"));

    try {
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-"));
      const runner = new FlowRunner({
        resolveAgent: () => ({
          agentName: "mock",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd,
        }),
        permissionMode: "approve-all",
        outputRoot,
      });

      const flow = defineFlow({
        name: "isolated-trace-test",
        startAt: "only",
        nodes: {
          only: acp({
            session: {
              isolated: true,
            },
            prompt: () => 'echo {"ok":true}',
            parse: (text) => extractJsonObject(text),
          }),
        },
        edges: [],
      });

      const result = await runner.run(flow, {});
      const manifest = JSON.parse(
        await fs.readFile(path.join(result.runDir, "manifest.json"), "utf8"),
      ) as {
        sessions: Array<{ id: string; recordPath: string; eventsPath: string }>;
      };
      const steps = JSON.parse(
        await fs.readFile(path.join(result.runDir, "projections", "steps.json"), "utf8"),
      ) as Array<{
        attemptId: string;
        trace?: {
          sessionId?: string;
          promptArtifact?: { path: string };
          rawResponseArtifact?: { path: string };
          conversation?: {
            messageStart: number;
            messageEnd: number;
            eventStartSeq: number;
            eventEndSeq: number;
          };
        };
      }>;
      const traceEvents = (await fs.readFile(path.join(result.runDir, "trace.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });

      assert.equal(result.state.status, "completed");
      assert.equal(manifest.sessions.length, 1);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.attemptId, "only#1");
      assert.equal(steps[0]?.trace?.sessionId, manifest.sessions[0]?.id);
      assert.equal(steps[0]?.trace?.conversation?.messageStart, 0);
      assert.equal(steps[0]?.trace?.conversation?.eventStartSeq, 1);
      assert.ok(steps[0]?.trace?.promptArtifact?.path);
      assert.ok(steps[0]?.trace?.rawResponseArtifact?.path);
      assert.ok(traceEvents.some((event) => event.type === "acp_prompt_prepared"));
      assert.ok(traceEvents.some((event) => event.type === "acp_response_parsed"));

      const record = JSON.parse(
        await fs.readFile(path.join(result.runDir, manifest.sessions[0]!.recordPath), "utf8"),
      ) as { messages: unknown[]; lastSeq: number };
      const bundledEvents = (
        await fs.readFile(path.join(result.runDir, manifest.sessions[0]!.eventsPath), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq?: number; direction?: string });

      assert.ok(record.messages.length >= 2);
      assert.equal(record.lastSeq, bundledEvents.length);
      assert.equal(bundledEvents[0]?.seq, 1);
      assert.ok(
        bundledEvents.every(
          (event) => event.direction === "inbound" || event.direction === "outbound",
        ),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("FlowRunner writes persistent ACP bundle traces and session bindings", async () => {
  await withTempHome(async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-persistent-trace-"));

    try {
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-"));
      const runner = new FlowRunner({
        resolveAgent: () => ({
          agentName: "mock",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd,
        }),
        permissionMode: "approve-all",
        outputRoot,
      });

      const flow = defineFlow({
        name: "persistent-trace-test",
        startAt: "only",
        nodes: {
          only: acp({
            prompt: () => 'echo {"ok":true}',
            parse: (text) => extractJsonObject(text),
          }),
        },
        edges: [],
      });

      const result = await runner.run(flow, {});
      const manifest = JSON.parse(
        await fs.readFile(path.join(result.runDir, "manifest.json"), "utf8"),
      ) as {
        sessions: Array<{ id: string; recordPath: string; eventsPath: string }>;
      };
      const steps = JSON.parse(
        await fs.readFile(path.join(result.runDir, "projections", "steps.json"), "utf8"),
      ) as Array<{
        session?: { bundleId?: string };
        trace?: {
          sessionId?: string;
          conversation?: {
            messageStart: number;
            messageEnd: number;
            eventStartSeq: number;
            eventEndSeq: number;
          };
        };
      }>;
      const traceEvents = (await fs.readFile(path.join(result.runDir, "trace.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; sessionId?: string });

      assert.equal(result.state.status, "completed");
      assert.equal(manifest.sessions.length, 1);
      assert.equal(Object.values(result.state.sessionBindings).length, 1);
      assert.equal(steps[0]?.session?.bundleId, manifest.sessions[0]?.id);
      assert.equal(steps[0]?.trace?.sessionId, manifest.sessions[0]?.id);
      assert.ok(steps[0]?.trace?.conversation?.eventEndSeq);
      assert.ok(traceEvents.some((event) => event.type === "session_bound"));
      assert.ok(traceEvents.some((event) => event.type === "acp_response_parsed"));

      const record = JSON.parse(
        await fs.readFile(path.join(result.runDir, manifest.sessions[0]!.recordPath), "utf8"),
      ) as { messages: unknown[]; lastSeq: number };
      const bundledEvents = (
        await fs.readFile(path.join(result.runDir, manifest.sessions[0]!.eventsPath), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq?: number });

      assert.ok(record.messages.length >= 2);
      assert.equal(record.lastSeq, bundledEvents.length);
      assert.equal(bundledEvents[0]?.seq, 1);
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

test("FlowRunner rejects multiple outgoing edges from the same node", async () => {
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
      name: "ambiguous-edges",
      startAt: "start",
      nodes: {
        start: compute({
          run: () => ({ ok: true }),
        }),
        one: action({
          run: () => ({ branch: 1 }),
        }),
        two: action({
          run: () => ({ branch: 2 }),
        }),
      },
      edges: [
        { from: "start", to: "one" },
        { from: "start", to: "two" },
      ],
    });

    await assert.rejects(
      async () => await runner.run(flow, {}),
      /Flow node must not declare multiple outgoing edges: start/,
    );
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
    assert.equal(activeState.currentNodeType, "action");
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
    assert.match(String(state.error), /Timed out after 50ms/);
    const slowResult = (state.results as Record<string, Record<string, unknown>>).slow;
    assert.equal(slowResult.nodeId, "slow");
    assert.equal(slowResult.nodeType, "action");
    assert.equal(slowResult.outcome, "timed_out");
    assert.equal(slowResult.error, "Timed out after 50ms");
    assert.equal(typeof slowResult.startedAt, "string");
    assert.equal(typeof slowResult.finishedAt, "string");
    assert.equal(typeof slowResult.durationMs, "number");
  });
});

test("FlowRunner can route timed out nodes by outcome", async () => {
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
      name: "timeout-route-test",
      startAt: "slow",
      nodes: {
        slow: shell({
          exec: () => ({
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 1000)"],
            timeoutMs: 50,
          }),
        }),
        after_timeout: action({
          run: ({ results }) => ({
            routed: true,
            outcome: results.slow?.outcome,
          }),
        }),
      },
      edges: [
        {
          from: "slow",
          switch: {
            on: "$result.outcome",
            cases: {
              timed_out: "after_timeout",
            },
          },
        },
      ],
    });

    const result = await runner.run(flow, {});
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.results.slow?.outcome, "timed_out");
    assert.deepEqual(result.state.outputs.after_timeout, {
      routed: true,
      outcome: "timed_out",
    });
  });
});

test("FlowRunner times out async shell exec callbacks", async () => {
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
      name: "shell-exec-timeout-test",
      startAt: "slow",
      nodes: {
        slow: shell({
          timeoutMs: 50,
          exec: async () => await new Promise<ShellActionExecution>(() => {}),
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "shell-exec-timeout-test");
    const state = await readRunJson(runDir);
    const slowResult = (state.results as Record<string, Record<string, unknown>>).slow;
    assert.equal(slowResult.outcome, "timed_out");
  });
});

test("FlowRunner times out async shell parse callbacks", async () => {
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
      name: "shell-parse-timeout-test",
      startAt: "slow",
      nodes: {
        slow: shell({
          timeoutMs: 50,
          exec: () => ({
            command: process.execPath,
            args: ["-e", 'process.stdout.write("ok")'],
          }),
          parse: async () => await new Promise(() => {}),
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "shell-parse-timeout-test");
    const state = await readRunJson(runDir);
    const slowResult = (state.results as Record<string, Record<string, unknown>>).slow;
    assert.equal(slowResult.outcome, "timed_out");
  });
});

test("FlowRunner times out async ACP prompt callbacks", async () => {
  await withTempHome(async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-"));
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "mock",
        agentCommand: MOCK_AGENT_COMMAND,
        cwd: process.cwd(),
      }),
      permissionMode: "approve-all",
      outputRoot,
    });

    const flow = defineFlow({
      name: "acp-prompt-timeout-test",
      startAt: "slow",
      nodes: {
        slow: acp({
          session: {
            isolated: true,
          },
          timeoutMs: 50,
          prompt: async () => await new Promise<PromptInput>(() => {}),
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "acp-prompt-timeout-test");
    const state = await readRunJson(runDir);
    const slowResult = (state.results as Record<string, Record<string, unknown>>).slow;
    assert.equal(slowResult.outcome, "timed_out");
  });
});

test("FlowRunner times out async ACP parse callbacks", async () => {
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
    const runnerHarness = runner as unknown as {
      runIsolatedPrompt: () => Promise<string>;
    };
    runnerHarness.runIsolatedPrompt = async () => "hello";

    const flow = defineFlow({
      name: "acp-parse-timeout-test",
      startAt: "slow",
      nodes: {
        slow: acp({
          session: {
            isolated: true,
          },
          timeoutMs: 50,
          prompt: () => "hello",
          parse: async () => await new Promise(() => {}),
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "acp-parse-timeout-test");
    const state = await readRunJson(runDir);
    const slowResult = (state.results as Record<string, Record<string, unknown>>).slow;
    assert.equal(slowResult.outcome, "timed_out");
  });
});

test("FlowRunner respects per-node timeouts while creating persistent ACP sessions", async () => {
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
    const runnerHarness = runner as unknown as {
      ensureSessionBinding: () => Promise<unknown>;
    };
    runnerHarness.ensureSessionBinding = async () => await new Promise(() => {});

    const flow = defineFlow({
      name: "acp-session-create-timeout-test",
      startAt: "slow",
      nodes: {
        slow: acp({
          timeoutMs: 50,
          prompt: () => "hello",
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "acp-session-create-timeout-test");
    const state = await readRunJson(runDir);
    const slowResult = (state.results as Record<string, Record<string, unknown>>).slow;
    assert.equal(slowResult.outcome, "timed_out");
  });
});

test("FlowRunner times out async checkpoint callbacks", async () => {
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
      name: "checkpoint-timeout-test",
      startAt: "wait",
      nodes: {
        wait: checkpoint({
          timeoutMs: 50,
          run: async () => await new Promise(() => {}),
        }),
      },
      edges: [],
    });

    await assert.rejects(async () => await runner.run(flow, {}), TimeoutError);
    const runDir = await waitForRunDir(outputRoot, "checkpoint-timeout-test");
    const state = await readRunJson(runDir);
    const waitResult = (state.results as Record<string, Record<string, unknown>>).wait;
    assert.equal(waitResult.outcome, "timed_out");
  });
});

test("FlowRunner stores successful node results separately from outputs", async () => {
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
      name: "result-state-test",
      startAt: "first",
      nodes: {
        first: compute({
          run: () => ({ next: "done" }),
        }),
        done: action({
          run: ({ results }) => ({
            firstOutcome: results.first?.outcome,
          }),
        }),
      },
      edges: [{ from: "first", to: "done" }],
    });

    const result = await runner.run(flow, {});
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.results.first?.outcome, "ok");
    assert.deepEqual(result.state.outputs.first, { next: "done" });
    assert.deepEqual(result.state.outputs.done, { firstOutcome: "ok" });
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
  const payload = await fs.readFile(path.join(runDir, "projections", "run.json"), "utf8");
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
