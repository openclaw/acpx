import assert from "node:assert/strict";
import childProcess, { spawn, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  isProcessAlive,
  readQueueOwnerRecord,
  resolveUsableQueueOwner,
  terminateQueueOwnerForSession,
} from "../src/session/queue/lease-store.js";
import { queuePaths, withTempHome, writeQueueOwnerLock } from "./queue-test-helpers.js";

async function startOwnerTree() {
  // Every fixture process has its own deadline even if an assertion fails.
  const leaf = "setTimeout(() => process.exit(0), 30_000)";
  const bridge = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {
      stdio: 'ignore', detached: true,
    });
    child.once('spawn', () => process.send([process.pid, child.pid]));
    ${leaf};
  `;
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(bridge)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.once('message', (pids) => process.send([process.pid, ...pids]));
    ${leaf};
  `;
  const owner = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: true,
  });
  const [message] = await once(owner, "message", { signal: AbortSignal.timeout(10_000) });
  assert(Array.isArray(message));
  assert.equal(message.length, 3);
  assert(message.every((pid: unknown) => typeof pid === "number" && pid > 0));
  return { owner, pids: message as number[] };
}

async function stopFixtureProcesses(pids: number[]): Promise<void> {
  for (const pid of pids.toReversed()) {
    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  for (let attempt = 0; attempt < 100 && pids.some(isProcessAlive); attempt += 1) {
    await delay(10);
  }
}

// Non-detached Node children die with their parent's Job Object. Agent-launched
// detached descendants escape that automatic cleanup and need tree retirement.
describe(
  "Windows queue-owner retirement with detached descendants",
  { skip: process.platform !== "win32" },
  () => {
    for (const mode of ["close", "stale", "replacement", "shadow"] as const) {
      test(`${mode} checks the owner generation before retiring its process tree`, async () => {
        await withTempHome(async (homeDir) => {
          const sessionId = `windows-retirement-${mode}`;
          const { owner, pids } = await startOwnerTree();
          const paths = queuePaths(homeDir, sessionId);
          const previousCwd = process.cwd();
          try {
            if (mode === "shadow") {
              await fs.writeFile(path.join(homeDir, "taskkill.exe"), "not a system executable");
              process.chdir(homeDir);
            }
            await writeQueueOwnerLock({
              ...paths,
              sessionId,
              pid: owner.pid,
              heartbeatAt: mode === "stale" ? "2000-01-01T00:00:00.000Z" : undefined,
            });
            const observed = await readQueueOwnerRecord(sessionId);
            assert(observed);
            if (mode === "replacement") {
              await writeQueueOwnerLock({
                ...paths,
                ...observed,
                ownerGeneration: observed.ownerGeneration + 1,
              });
            }
            assert(pids.every(isProcessAlive));
            if (mode === "stale") {
              await resolveUsableQueueOwner(sessionId, observed);
            } else {
              await terminateQueueOwnerForSession(sessionId, observed);
            }
            if (mode === "replacement") {
              assert(pids.every(isProcessAlive), "an old generation must not kill a replacement");
              assert.equal(
                (await readQueueOwnerRecord(sessionId))?.ownerGeneration,
                observed.ownerGeneration + 1,
              );
            } else {
              assert.deepEqual(pids.map(isProcessAlive), [false, false, false]);
              assert.equal(await readQueueOwnerRecord(sessionId), undefined);
            }
          } finally {
            process.chdir(previousCwd);
            await stopFixtureProcesses(pids);
          }
        });
      });
    }

    for (const failure of ["exit", "timeout", "partial"] as const) {
      test(`taskkill ${failure} rejects and retains the owner lease`, async (context) => {
        await withTempHome(async (homeDir) => {
          const sessionId = `windows-retirement-${failure}`;
          const { owner, pids } = await startOwnerTree();
          const paths = queuePaths(homeDir, sessionId);
          const execFile = childProcess.execFile;
          let helper: ReturnType<typeof execFile> | undefined;
          const helperSource =
            failure === "timeout"
              ? "setInterval(() => {}, 1000)"
              : `${failure === "partial" ? `process.kill(${owner.pid});` : ""}process.exit(23)`;
          const stub = context.mock.method(childProcess, "execFile", ((
            command: string,
            args: readonly string[],
            options: ExecFileOptionsWithStringEncoding,
            callback: (error: Error | null, stdout: string, stderr: string) => void,
          ) => {
            assert.equal(
              command,
              path.win32.join(process.env.SystemRoot!, "System32", "taskkill.exe"),
            );
            assert.deepEqual(args, ["/pid", String(owner.pid), "/T", "/F"]);
            helper = execFile(process.execPath, ["-e", helperSource], options, callback);
            return helper;
          }) as typeof childProcess.execFile);
          syncBuiltinESMExports();
          try {
            await writeQueueOwnerLock({ ...paths, sessionId, pid: owner.pid });
            const original = await fs.readFile(paths.lockPath, "utf8");
            await assert.rejects(terminateQueueOwnerForSession(sessionId), {
              code: failure === "timeout" ? "ETIMEDOUT" : 23,
            });
            assert.equal(await fs.readFile(paths.lockPath, "utf8"), original);
            assert.deepEqual(
              pids.map(isProcessAlive),
              [failure !== "partial", failure !== "partial", true],
              "helper failure must retain the lease while a detached descendant survives",
            );
          } finally {
            stub.mock.restore();
            syncBuiltinESMExports();
            await stopFixtureProcesses([...pids, ...(helper?.pid ? [helper.pid] : [])]);
          }
        });
      });
    }
  },
);
