import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { AcpClient } from "../src/acp/client.js";
import { ProcessDescendants } from "../src/acp/process-descendants.js";
import { TimeoutError, withTimeout } from "../src/async-control.js";
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

function startCleanupSibling() {
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let processFailure: Error | undefined;
  child.on("error", (error) => {
    processFailure ??= error;
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("close", () => {
      if (processFailure) {
        reject(processFailure);
      } else {
        resolve();
      }
    });
  });
  void closed.catch(() => {});
  return { child, closed };
}

function throwFixtureFailures(failures: unknown[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Cleanup fixture teardown failed", { cause: failures[0] });
  }
}

async function cleanupFixture(
  sibling: ReturnType<typeof startCleanupSibling>,
  cleanupAgent: () => Promise<void>,
): Promise<void> {
  const signalFailures: unknown[] = [];
  try {
    if (sibling.child.pid && sibling.child.exitCode === null && sibling.child.signalCode === null) {
      sibling.child.kill("SIGKILL");
    }
  } catch (error) {
    signalFailures.push(error);
  }
  // The unrelated fixture must retire even when agent cleanup rejects or waits.
  const [agentResult, siblingResult] = await Promise.allSettled([
    Promise.resolve().then(cleanupAgent),
    withTimeout(sibling.closed, 3_000),
  ]);
  const failures: unknown[] = [];
  if (agentResult.status === "rejected") {
    failures.push(agentResult.reason);
  }
  failures.push(...signalFailures);
  if (siblingResult.status === "rejected") {
    failures.push(siblingResult.reason);
  }
  throwFixtureFailures(failures);
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
    const sibling = startCleanupSibling();
    t.after(async () => {
      await cleanupFixture(sibling, async () => {
        await client.close();
        const pids = await readPids(pidFile);
        if (isRunning(pids.descendant)) {
          process.kill(pids.descendant, "SIGKILL");
        }
      });
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
    assert.equal(sibling.child.exitCode, null, "unrelated sibling was terminated");
    assert(sibling.child.pid && isRunning(sibling.child.pid));
  });
}

for (const failure of ["agent close rejected", "PID file missing"]) {
  test(`cleanup fixture retires its sibling when ${failure}`, { timeout: 15_000 }, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cleanup-failure-"));
    const sibling = startCleanupSibling();
    let siblingClosed = false;
    sibling.child.once("close", () => {
      siblingClosed = true;
    });
    const closeError = new Error("synthetic close failure");
    const failures: unknown[] = [];
    try {
      await withTimeout(once(sibling.child, "spawn"), 3_000);
      await assert.rejects(
        cleanupFixture(sibling, async () => {
          if (failure === "agent close rejected") {
            throw closeError;
          }
          await readPids(path.join(cwd, "absent-pids.json"));
        }),
        (error) =>
          failure === "agent close rejected"
            ? error === closeError
            : error instanceof Error && error.message === "Cleanup fixture did not start",
      );
      assert.equal(siblingClosed, true, "cleanup returned before its sibling closed");
    } catch (error) {
      failures.push(error);
    }
    // Keep the regression bounded even when the old teardown skips its sibling.
    try {
      if (
        sibling.child.pid &&
        sibling.child.exitCode === null &&
        sibling.child.signalCode === null
      ) {
        sibling.child.kill("SIGKILL");
      }
      await withTimeout(sibling.closed, 3_000);
    } catch (error) {
      failures.push(error);
    }
    try {
      await fs.rm(cwd, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    throwFixtureFailures(failures);
  });
}

test(
  "timestamp descendant cleanup retires disappeared and reused process identities",
  { skip: process.platform === "win32" },
  async (t) => {
    // Exercise macOS timestamp custody; Linux uses a raw proc table instead.
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    t.after(() => {
      if (platform) {
        Object.defineProperty(process, "platform", platform);
      }
    });
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
  return (
    contents
      .split("\n")
      // Only newline-terminated records have finished publishing.
      .slice(0, -1)
      .map((line) => JSON.parse(line)) as Array<{
      id?: string | number;
      method?: string;
      params?: {
        clientCapabilities?: { fs?: unknown; terminal?: boolean };
        mcpServers?: unknown[];
      };
      result?: unknown;
    }>
  );
}

async function withInspectionAssertion(
  controller: AbortController,
  reason: Error,
  rejected: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  const assertionFailures: unknown[] = [];
  const settled = rejected.catch((error: unknown) => {
    assertionFailures.push(error);
  });
  const failures: unknown[] = [];
  try {
    await body();
  } catch (error) {
    failures.push(error);
  } finally {
    // A readiness error still owns the inspection and its rejection assertion.
    try {
      controller.abort(reason);
    } catch (error) {
      failures.push(error);
    }
    await settled;
  }
  for (const error of assertionFailures) {
    if (!failures.includes(error)) {
      failures.push(error);
    }
  }
  throwFixtureFailures(failures);
}

for (const assertionMatches of [true, false]) {
  test(`model inspection owns readiness failure ${assertionMatches ? "without" : "with"} assertion failure`, async () => {
    const controller = new AbortController();
    const reason = new Error("catalog retired");
    const readinessError = new Error("synthetic inspection readiness failure");
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let inspectionSettled = false;
    const pending = (async () => {
      await aborted;
      await cleanup;
      inspectionSettled = true;
      throw reason;
    })();
    const rejected = assert.rejects(pending, (error) => assertionMatches && error === reason);
    // The driver also owns broken controls, including a failing assertion.
    const assertionOutcome = rejected.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let scopeSettled = false;
    const outcome = withInspectionAssertion(controller, reason, rejected, async () => {
      throw readinessError;
    }).then(
      () => {
        scopeSettled = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        scopeSettled = true;
        return { ok: false as const, error };
      },
    );
    const failures: unknown[] = [];
    try {
      await nextTurn();
      assert.equal(controller.signal.aborted, true, "readiness failure did not abort inspection");
      assert.equal(inspectionSettled, false, "inspection ignored its cleanup gate");
      assert.equal(scopeSettled, false, "readiness failure returned before inspection settled");
      releaseCleanup();
      const result = await outcome;
      const assertion = await assertionOutcome;
      assert.equal(inspectionSettled, true);
      assert.ok(!result.ok);
      if (assertionMatches) {
        assert.equal(assertion.ok, true);
        assert.equal(result.error, readinessError);
      } else {
        assert.ok(!assertion.ok);
        assert.ok(result.error instanceof AggregateError);
        assert.equal(result.error.errors.length, 2);
        assert.equal(result.error.errors[0], readinessError);
        assert.equal(result.error.errors[1], assertion.error);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      controller.abort(reason);
      releaseCleanup();
      await Promise.all([outcome, assertionOutcome]);
    }
    throwFixtureFailures(failures);
  });
}

test("model inspection log polling waits for complete records", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-inspection-log-"));
  const pidFile = path.join(cwd, "pids.json");
  const messagesFile = `${pidFile}.messages`;
  try {
    await fs.writeFile(messagesFile, "");
    assert.deepEqual(await inspectionMessages(pidFile), []);
    await fs.appendFile(messagesFile, '{"method":"initialize"}');
    assert.deepEqual(await inspectionMessages(pidFile), []);
    await fs.appendFile(messagesFile, '\n{"method":');
    assert.deepEqual(await inspectionMessages(pidFile), [{ method: "initialize" }]);
    await fs.appendFile(messagesFile, '"session/new"}\n');
    assert.deepEqual(await inspectionMessages(pidFile), [
      { method: "initialize" },
      { method: "session/new" },
    ]);
    await fs.appendFile(messagesFile, "invalid\n");
    await assert.rejects(inspectionMessages(pidFile), SyntaxError);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

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
        await withInspectionAssertion(controller, reason, rejected, async () => {
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
          assert.equal(
            isRunning(pids.descendant),
            false,
            "abort returned before descendant cleanup",
          );
        });
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
