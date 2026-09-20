import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createAgentRegistry,
  inspectAgentModels,
  type AcpRuntimeOptions,
  type AcpRuntimeTurn,
} from "../src/runtime.js";
import { InMemorySessionStore, withTempDir } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type CapabilityRuntime = ReturnType<typeof createAcpRuntime>;

async function turnText(
  turn: AcpRuntimeTurn,
  expectedStatus: "completed" | "failed" = "completed",
): Promise<string> {
  let text = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      text += event.text;
    }
  }
  const result = await turn.result;
  assert.equal(result.status, expectedStatus, JSON.stringify(result));
  return text;
}

function terminalWritePrompt(marker: string): string {
  const script = "require('node:fs').writeFileSync(process.argv[1], 'terminal')";
  return `terminal ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} ${JSON.stringify(marker)}`;
}

function fixtureCommand(root: string, extraArgs: string[] = []): string[] {
  return [
    process.execPath,
    MOCK_AGENT_PATH,
    ...extraArgs,
    "--close-session-marker",
    path.join(root, "closed"),
  ];
}

async function withCapabilityRuntime(
  overrides: Partial<AcpRuntimeOptions> & { extraArgs?: string[] | ((root: string) => string[]) },
  run: (context: {
    runtime: CapabilityRuntime;
    store: InMemorySessionStore;
    options: AcpRuntimeOptions;
    root: string;
    ensure: (sessionKey: string) => ReturnType<CapabilityRuntime["ensureSession"]>;
  }) => Promise<void>,
): Promise<void> {
  const { extraArgs = [], ...runtimeOverrides } = overrides;
  await withTempDir("acpx-runtime-capabilities-", async (directory) => {
    const root = await fs.realpath(directory);
    const resolvedExtraArgs = typeof extraArgs === "function" ? extraArgs(root) : extraArgs;
    const store = new InMemorySessionStore();
    const options: AcpRuntimeOptions = {
      cwd: root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: fixtureCommand(root, resolvedExtraArgs),
        },
      }),
      permissionMode: "approve-all",
      probeAgent: "fixture",
      ...runtimeOverrides,
    };
    const runtime = createAcpRuntime(options);
    try {
      await run({
        runtime,
        store,
        options,
        root,
        ensure: (sessionKey) =>
          runtime.ensureSession({ sessionKey, agent: "fixture", mode: "persistent" }),
      });
    } finally {
      await runtime.shutdown();
    }
  });
}

const prompt = {
  mode: "prompt",
  requestId: "capability-test",
} as const;

for (const [name, options, expectFs, expectTerminal] of [
  ["omitted defaults", {}, true, true],
  ["disabled filesystem", { fs: false }, false, true],
  ["disabled terminal", { terminal: false }, true, false],
  ["disabled filesystem and terminal", { fs: false, terminal: false }, false, false],
] as const) {
  test(`public runtime ${name} enforce callback policy on the initial session`, async () => {
    await withCapabilityRuntime({ ...options }, async ({ runtime, ensure, root }) => {
      const handle = await ensure("initial");
      const readable = path.join(root, "input.txt");
      const written = path.join(root, "output.txt");
      const terminal = path.join(root, "terminal.txt");
      await fs.writeFile(readable, "capability input");

      const readText = await turnText(
        runtime.startTurn({ ...prompt, handle, text: `read ${readable}` }),
      );
      assert.equal(readText.includes("capability input"), expectFs);

      const writeText = await turnText(
        runtime.startTurn({ ...prompt, handle, text: `write ${written} written` }),
      );
      if (expectFs) {
        assert.equal(await fs.readFile(written, "utf8"), "written");
        assert.match(writeText, /wrote /);
      } else {
        await assert.rejects(fs.readFile(written), { code: "ENOENT" });
      }

      const terminalText = await turnText(
        runtime.startTurn({ ...prompt, handle, text: terminalWritePrompt(terminal) }),
      );
      if (expectTerminal) {
        assert.equal(await fs.readFile(terminal, "utf8"), "terminal");
      } else {
        await assert.rejects(fs.readFile(terminal), { code: "ENOENT" });
      }
      assert.equal(typeof terminalText, "string");
    });
  });
}

test("public runtime reconnects with the current capability policy, not a stored one", async () => {
  await withCapabilityRuntime(
    { extraArgs: ["--supports-load-session"] },
    async ({ runtime, ensure, root, options, store }) => {
      const handle = await ensure("reconnect");
      const written = path.join(root, "reconnect.txt");
      await turnText(runtime.startTurn({ ...prompt, handle, text: `write ${written} first` }));
      assert.equal(await fs.readFile(written, "utf8"), "first");
      const record = await store.load(handle.acpxRecordId!);
      assert.equal(JSON.stringify(record?.acpx ?? {}).includes('"fs"'), false);
      assert.equal(JSON.stringify(record?.acpx ?? {}).includes('"terminal"'), false);
      await runtime.close({ handle, reason: "drop retained owner" });
      await runtime.shutdown();

      const restarted = createAcpRuntime({ ...options, fs: false, terminal: false });
      try {
        const reconnectFsText = await turnText(
          restarted.startTurn({ ...prompt, handle, text: `write ${written} second` }),
        );
        const reconnectTerminalText = await turnText(
          restarted.startTurn({
            ...prompt,
            handle,
            requestId: "capability-terminal",
            text: terminalWritePrompt(path.join(root, "reconnect-terminal.txt")),
          }),
        );
        assert.match(reconnectFsText, /error|method not found/iu);
        assert.match(reconnectTerminalText, /error|method not found/iu);
        assert.equal(await fs.readFile(written, "utf8"), "first");
        await assert.rejects(fs.readFile(path.join(root, "reconnect-terminal.txt")), {
          code: "ENOENT",
        });
      } finally {
        await restarted.shutdown();
      }
    },
  );
});

for (const [name, fsEnabled] of [
  ["disabled", false],
  ["enabled", true],
] as const) {
  test(`public runtime control reconnects honor filesystem callback policy when ${name}`, async () => {
    await withCapabilityRuntime(
      {
        fs: fsEnabled,
        extraArgs: (root) => [
          "--supports-load-session",
          "--advertise-models",
          "--load-session-action",
          `write ${path.join(root, "control.txt")} loaded`,
        ],
      },
      async ({ runtime, ensure, root }) => {
        const handle = await ensure("control");
        const effect = path.join(root, "control.txt");
        await runtime.close({ handle, reason: "release initialized client" });
        let controlError: unknown;
        try {
          await runtime.setConfigOption({ handle, key: "model", value: "fast-model" });
        } catch (error) {
          controlError = error;
        }
        if (fsEnabled) {
          assert.equal(controlError, undefined);
          assert.equal(await fs.readFile(effect, "utf8"), "loaded");
        } else {
          assert.ok(controlError);
          await assert.rejects(fs.readFile(effect), { code: "ENOENT" });
        }
      },
    );
  });
}

test("public runtime health probes keep filesystem and terminal callbacks disabled", async () => {
  await withCapabilityRuntime(
    {
      fs: true,
      terminal: true,
      extraArgs: (root) => ["--initialize-action", `write ${path.join(root, "probe.txt")} probed`],
    },
    async ({ runtime, root, options }) => {
      const probeFile = path.join(root, "probe.txt");
      const inspected = path.join(root, "inspected.txt");
      const report = await runtime.doctor();
      assert.equal(report.ok, true);
      await assert.rejects(fs.readFile(probeFile), { code: "ENOENT" });

      await inspectAgentModels({
        agentCommand: fixtureCommand(root, [
          "--new-session-action",
          `write ${inspected} inspected`,
        ]),
        cwd: root,
        agentProcessEnv: options.agentProcessEnv,
      });
      await assert.rejects(fs.readFile(inspected), { code: "ENOENT" });
    },
  );
});
