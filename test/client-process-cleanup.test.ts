import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient } from "../src/acp/client.js";
import { ProcessDescendants } from "../src/acp/process-descendants.js";
import { TimeoutError } from "../src/async-control.js";
import { inspectAgentModels } from "../src/runtime/public/probe.js";

type FixturePids = { bridge: number; descendant: number };

function isRunning(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
      return false;
    }
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  assert.ifError(result.error);
  if (result.status === 1) {
    return false;
  }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().length > 0 && !result.stdout.trim().startsWith("Z");
}

async function readPids(pidFile: string): Promise<FixturePids> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(pidFile, "utf8")) as FixturePids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await delay(10);
    }
  }
  throw new Error("Cleanup fixture did not start");
}

async function assertStopped(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (isRunning(pid) && Date.now() < deadline) {
    await delay(20);
  }
  assert.equal(isRunning(pid), false, `${label} survived teardown`);
}

for (const mode of [
  "close",
  "init-fail",
  "admission-fail",
  "bridge-exit",
  "detached",
  "ignore-term",
]) {
  test(`AcpClient cleans descendants after ${mode}`, {}, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cleanup-"));
    const pidFile = path.join(cwd, "pids.json");
    const sibling = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const admissionError = new Error("synthetic admission failure");
    const client = new AcpClient({
      agentCommand: process.execPath,
      agentArgv: [
        process.execPath,
        path.resolve("dist-test/test/fixtures/process-cleanup-agent.js"),
        mode,
        pidFile,
      ],
      cwd,
      permissionMode: "deny-all",
      processLifecycle:
        mode === "admission-fail"
          ? {
              onSpawned: async () => {
                await readPids(pidFile);
                throw admissionError;
              },
            }
          : undefined,
    });
    t.after(async () => {
      await client.close();
      const pids = await readPids(pidFile);
      if (isRunning(pids.descendant)) {
        process.kill(pids.descendant, "SIGKILL");
      }
      sibling.kill("SIGKILL");
      await fs.rm(cwd, { recursive: true, force: true });
    });

    if (mode === "init-fail") {
      await assert.rejects(() => client.start(), /synthetic initialization failure/);
    } else if (mode === "admission-fail") {
      await assert.rejects(
        () => client.start(),
        (error) => error === admissionError,
      );
    } else {
      await client.start();
    }
    const pids = await readPids(pidFile);
    if (mode === "bridge-exit") {
      await client.createSession();
    } else {
      await Promise.all([client.close(), client.close()]);
    }
    await assertStopped(pids.bridge, "bridge");
    await assertStopped(pids.descendant, "descendant");
    assert.equal(sibling.exitCode, null, "unrelated sibling was terminated");
    assert(sibling.pid && isRunning(sibling.pid));
  });
}

test(
  "descendant cleanup retires disappeared and reused process identities",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-process-identities-"));
    const bin = path.join(cwd, "bin");
    const tableFile = path.join(cwd, "processes");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "ps"),
      '#!/bin/sh\nexec /bin/cat "$ACPX_TEST_PROCESS_TABLE"\n',
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    const previousTable = process.env.ACPX_TEST_PROCESS_TABLE;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    process.env.ACPX_TEST_PROCESS_TABLE = tableFile;
    const root = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const descendants = new ProcessDescendants(root);
    t.after(async () => {
      descendants.retire();
      root.kill("SIGKILL");
      root.unref();
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousTable === undefined) {
        delete process.env.ACPX_TEST_PROCESS_TABLE;
      } else {
        process.env.ACPX_TEST_PROCESS_TABLE = previousTable;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    });
    await once(root, "spawn");
    assert(root.pid);
    const descendantPid = Math.max(process.pid, root.pid) + 1000;
    const signals: Array<{ pid: number; signal?: string | number }> = [];
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      signals.push({ pid, signal });
      return true;
    });
    const birth = "Wed Sep 16 10:00:00 2026";
    await fs.writeFile(
      tableFile,
      `${root.pid} 1 ${root.pid} S ${birth}\n${descendantPid} ${root.pid} ${root.pid} S ${birth}\n${descendantPid + 1} 1 1 S ${birth}\n`,
    );
    await descendants.signal("SIGTERM", 1000);
    assert.deepEqual(signals, [{ pid: descendantPid, signal: "SIGTERM" }]);
    signals.length = 0;

    root.kill("SIGTERM");
    await once(root, "exit");
    await fs.writeFile(tableFile, `${descendantPid} 1 ${root.pid} S Wed Sep 16 10:00:01 2026\n`);
    await descendants.signal("SIGKILL", 1000);
    assert.deepEqual(signals, [], "a reused PID received a signal");

    await fs.writeFile(tableFile, `${descendantPid} 1 ${root.pid} S ${birth}\n`);
    await descendants.signal("SIGKILL", 1000);
    assert.deepEqual(signals, [], "a retired identity was rediscovered without an owned ancestor");
  },
);

async function inspectionFixture(t: TestContext, mode: string) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-model-inspection-"));
  const pidFile = path.join(cwd, "pids.json");
  t.after(async () => {
    const contents = await fs.readFile(pidFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return undefined;
    });
    if (contents) {
      const pids = JSON.parse(contents) as FixturePids;
      for (const pid of [pids.bridge, pids.descendant]) {
        if (isRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
    }
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    pidFile,
    agentCommand: [
      process.execPath,
      path.resolve("dist-test/test/fixtures/process-cleanup-agent.js"),
      mode,
      pidFile,
    ],
  };
}

async function inspectionMessages(pidFile: string) {
  const contents = await fs.readFile(`${pidFile}.messages`, "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as Array<{
    id?: string | number;
    method?: string;
    params?: { clientCapabilities?: { fs?: unknown; terminal?: boolean }; mcpServers?: unknown[] };
    result?: unknown;
  }>;
}

test(
  "model inspection denies tools, preserves model metadata and environment, and settles cleanup",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await inspectionFixture(t, "inspect");
    const agentProcessEnv = { ACPX_INSPECTION_MODEL_NAME: "Child-only model" };
    const result = inspectAgentModels({ ...fixture, agentProcessEnv });
    agentProcessEnv.ACPX_INSPECTION_MODEL_NAME = "Changed after launch";
    assert.deepEqual(await result, {
      currentModelId: "inspected",
      availableModelIds: ["inspected"],
      availableModels: [{ modelId: "inspected", name: "Child-only model" }],
    });
    const messages = await inspectionMessages(fixture.pidFile);
    assert.deepEqual(
      messages.filter((message) => message.method).map((message) => message.method),
      ["initialize", "session/new"],
    );
    const capabilities = messages[0]?.params?.clientCapabilities;
    assert.ok(!capabilities?.terminal);
    assert.deepEqual(capabilities?.fs, { readTextFile: false, writeTextFile: false });
    assert.deepEqual(messages[1]?.params?.mcpServers, []);
    assert.deepEqual(messages.find((message) => message.id === "inspection-permission")?.result, {
      outcome: { outcome: "selected", optionId: "deny" },
    });
    const pids = await readPids(fixture.pidFile);
    assert.equal(isRunning(pids.bridge), false, "inspection returned before bridge cleanup");
    assert.equal(
      isRunning(pids.descendant),
      false,
      "inspection returned before descendant cleanup",
    );
  },
);

test(
  "model inspection keeps successful metadata when cleanup exceeds the discovery deadline",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await inspectionFixture(t, "inspect");
    const close = AcpClient.prototype.close;
    t.mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
      await delay(3_100);
      await close.call(this);
    });
    const models = await inspectAgentModels({ ...fixture, timeoutMs: 3_000 });
    assert.deepEqual(models?.availableModelIds, ["inspected"]);
    const pids = await readPids(fixture.pidFile);
    assert.equal(isRunning(pids.bridge), false);
    assert.equal(isRunning(pids.descendant), false);
  },
);

for (const mode of ["close", "init-fail", "session-fail"]) {
  test(
    `model inspection settles cleanup after ${mode}`,
    { skip: process.platform === "win32" },
    async (t) => {
      const fixture = await inspectionFixture(t, mode);
      if (mode === "close") {
        assert.equal(await inspectAgentModels(fixture), undefined);
      } else {
        await assert.rejects(
          inspectAgentModels(fixture),
          mode === "init-fail" ? /synthetic initialization failure/ : /synthetic session failure/,
        );
      }
      const pids = await readPids(fixture.pidFile);
      assert.equal(isRunning(pids.bridge), false);
      assert.equal(isRunning(pids.descendant), false);
    },
  );
}

for (const mode of ["init-hang", "session-hang"]) {
  for (const interruption of ["abort", "timeout"]) {
    test(
      `model inspection settles ${mode} before rejecting ${interruption}`,
      { skip: process.platform === "win32" },
      async (t) => {
        const fixture = await inspectionFixture(t, mode);
        const controller = new AbortController();
        const reason = new Error("catalog retired");
        const pending = inspectAgentModels({
          ...fixture,
          signal: controller.signal,
          timeoutMs: interruption === "timeout" ? 2_000 : 10_000,
        });
        const rejected = assert.rejects(pending, (error) =>
          interruption === "timeout" ? error instanceof TimeoutError : error === reason,
        );
        const pids = await readPids(fixture.pidFile);
        if (interruption === "abort") {
          const method = mode === "init-hang" ? "initialize" : "session/new";
          for (let attempt = 0; ; attempt += 1) {
            const messages = await inspectionMessages(fixture.pidFile).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                  throw error;
                }
                return [];
              },
            );
            if (messages.some((message) => message.method === method)) {
              break;
            }
            assert.ok(attempt < 200, `inspection did not reach ${method}`);
            await delay(10);
          }
          controller.abort(reason);
        }
        await rejected;
        assert.equal(isRunning(pids.bridge), false, "abort returned before bridge cleanup");
        assert.equal(isRunning(pids.descendant), false, "abort returned before descendant cleanup");
      },
    );
  }
}

test(
  "model inspection does not launch for pre-aborted or immediately aborted calls",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const preAborted of [true, false]) {
      const fixture = await inspectionFixture(t, "inspect");
      const controller = new AbortController();
      const reason = new Error("catalog retired before launch");
      if (preAborted) {
        controller.abort(reason);
      }
      const pending = inspectAgentModels({ ...fixture, signal: controller.signal });
      controller.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
      assert.deepEqual(await fs.readdir(fixture.cwd), []);
    }
  },
);
