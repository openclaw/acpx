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
} from "../src/flows.js";

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
