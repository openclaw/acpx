import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient } from "../src/acp/client.js";
import { ProcessDescendants } from "../src/acp/process-descendants.js";

type FixturePids = { bridge: number; descendant: number };

function isRunning(pid: number): boolean {
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
  test(
    `AcpClient cleans descendants after ${mode}`,
    { skip: process.platform === "win32" },
    async (t) => {
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
    },
  );
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
      `${root.pid} 1 S ${birth}\n${descendantPid} ${root.pid} S ${birth}\n${descendantPid + 1} 1 S ${birth}\n`,
    );
    await descendants.signal("SIGTERM", 1000);
    assert.deepEqual(signals, [{ pid: descendantPid, signal: "SIGTERM" }]);
    signals.length = 0;

    root.kill("SIGTERM");
    await once(root, "exit");
    await fs.writeFile(tableFile, `${descendantPid} 1 S Wed Sep 16 10:00:01 2026\n`);
    await descendants.signal("SIGKILL", 1000);
    assert.deepEqual(signals, [], "a reused PID received a signal");

    await fs.writeFile(tableFile, `${descendantPid} 1 S ${birth}\n`);
    await descendants.signal("SIGKILL", 1000);
    assert.deepEqual(signals, [], "a retired identity was rediscovered without an owned ancestor");
  },
);
