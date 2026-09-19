import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient } from "../src/acp/client.js";
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from "../src/runtime.js";

type FixturePids = { bridge: number; descendant: number };

function isRunning(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return (
    result.status === 0 && !result.stdout.trim().startsWith("Z") && result.stdout.trim() !== ""
  );
}

async function assertStopped(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (isRunning(pid) && Date.now() < deadline) {
    await delay(20);
  }
  assert.equal(isRunning(pid), false, `${label} survived the startup timeout`);
}

test(
  "runtime session creation stops a peer that never answers initialize",
  { skip: process.platform === "win32" },
  async (t) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-startup-timeout-"));
    const sibling = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pidFiles: string[] = [];
    t.after(async () => {
      for (const pidFile of pidFiles) {
        const pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as FixturePids;
        for (const pid of [pids.bridge, pids.descendant]) {
          if (isRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
      sibling.kill("SIGKILL");
      await fs.rm(rootDir, { recursive: true, force: true });
    });
    const fixture = path.resolve("dist-test/test/fixtures/process-cleanup-agent.js");
    const overrides: Record<string, string[]> = {};
    for (const attempt of [1, 2]) {
      const pidFile = path.join(rootDir, `pids-${attempt}.json`);
      pidFiles.push(pidFile);
      // Configured arguments can carry private values; none may reach the error.
      overrides[`silent-${attempt}`] = [
        process.execPath,
        fixture,
        "silent",
        pidFile,
        "--profile=argument-must-not-leak",
      ];
    }
    const runtime = createAcpRuntime({
      cwd: rootDir,
      sessionStore: createFileSessionStore({ stateDir: path.join(rootDir, "state") }),
      agentRegistry: createAgentRegistry({ overrides }),
      permissionMode: "deny-all",
      timeoutMs: 500,
    });

    // Every retry must fail on its own and leave nothing behind.
    for (const [index, pidFile] of pidFiles.entries()) {
      const startedAt = Date.now();
      await assert.rejects(
        () =>
          runtime.ensureSession({
            sessionKey: `silent-${index + 1}`,
            agent: `silent-${index + 1}`,
            mode: "persistent",
          }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, "ACP_SESSION_INIT_FAILED");
          assert.match(error.message, /did not complete ACP initialization within 500ms/);
          assert.doesNotMatch(error.message, /argument-must-not-leak/);
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 5_000, "startup timeout did not fail fast");
      const pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as FixturePids;
      await assertStopped(pids.bridge, "agent");
      await assertStopped(pids.descendant, "forked descendant");
    }
    assert.ok(sibling.pid && isRunning(sibling.pid), "unrelated sibling was terminated");
  },
);

test(
  "a client closed before its agent spawns stops the late child instead of adopting it",
  { skip: process.platform === "win32" },
  async (t) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-late-spawn-"));
    const pidFile = path.join(rootDir, "pids.json");
    t.after(async () => {
      const pids = JSON.parse(
        await fs.readFile(pidFile, "utf8").catch(() => "{}"),
      ) as Partial<FixturePids>;
      for (const pid of [pids.bridge, pids.descendant]) {
        if (pid && isRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await fs.rm(rootDir, { recursive: true, force: true });
    });
    let releaseSpawn: () => void = () => {};
    let beforeSpawn: () => void = () => {};
    const spawnHeld = new Promise<void>((resolve) => {
      beforeSpawn = resolve;
    });
    const client = new AcpClient({
      agentCommand: process.execPath,
      agentArgv: [
        process.execPath,
        path.resolve("dist-test/test/fixtures/process-cleanup-agent.js"),
        "silent",
        pidFile,
      ],
      cwd: rootDir,
      permissionMode: "deny-all",
      processLifecycle: {
        // Hold the launch just before spawn, where a startup deadline can expire first.
        onBeforeSpawn: async () => {
          beforeSpawn();
          await new Promise<void>((resolve) => {
            releaseSpawn = resolve;
          });
        },
        // As in the client cleanup tests, admit only once the fixture has forked its descendant.
        onSpawned: async () => {
          while (!(await fs.stat(pidFile).catch(() => undefined))) {
            await delay(10);
          }
        },
      },
    });
    const starting = client.start();
    await spawnHeld;
    await client.close();
    releaseSpawn();
    await assert.rejects(starting, /closed while the agent was starting/);
    const pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as FixturePids;
    await assertStopped(pids.bridge, "late agent");
    await assertStopped(pids.descendant, "late agent's forked descendant");
  },
);
