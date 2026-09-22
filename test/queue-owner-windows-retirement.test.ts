import assert from "node:assert/strict";
import childProcess, { type ExecFileOptionsWithStringEncoding } from "node:child_process";
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
import {
  startWitnessedTree,
  stopWitnesses,
  witnessStates,
} from "./fixtures/queue-retirement-retry.js";
import {
  queuePaths,
  withTempHome,
  writeQueueOwnerLock,
  verifiedProcessIdentity,
} from "./queue-test-helpers.js";

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
          const tree = await startWitnessedTree();
          const owner = tree.child;
          const pids = tree.witnesses.map((witness) => witness.pid);
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
              processIdentity: await verifiedProcessIdentity(owner.pid),
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
              assert.deepEqual(
                await witnessStates(tree.expectedWitnesses),
                tree.expectedWitnesses.map(() => "matching"),
              );
              assert.equal(
                (await readQueueOwnerRecord(sessionId))?.ownerGeneration,
                observed.ownerGeneration + 1,
              );
            } else {
              assert.deepEqual(pids.map(isProcessAlive), [false, false, false]);
              assert.deepEqual(
                await witnessStates(tree.expectedWitnesses),
                tree.expectedWitnesses.map(() => "gone"),
              );
              assert.equal(await readQueueOwnerRecord(sessionId), undefined);
            }
          } finally {
            process.chdir(previousCwd);
            await stopWitnesses(tree.expectedWitnesses);
            await tree.closed;
          }
        });
      });
    }

    for (const failure of ["exit", "timeout", "partial"] as const) {
      test(`taskkill ${failure} rejects and retains the owner lease`, async (context) => {
        await withTempHome(async (homeDir) => {
          const sessionId = `windows-retirement-${failure}`;
          const tree = await startWitnessedTree();
          const owner = tree.child;
          const pids = tree.witnesses.map((witness) => witness.pid);
          const paths = queuePaths(homeDir, sessionId);
          const execFile = childProcess.execFile;
          const processIdentity = await verifiedProcessIdentity(owner.pid);
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
            if (path.win32.basename(command).toLowerCase() === "powershell.exe") {
              return execFile(command, [...args], options, callback);
            }
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
            await writeQueueOwnerLock({ ...paths, sessionId, pid: owner.pid, processIdentity });
            const original = await readQueueOwnerRecord(sessionId);
            await assert.rejects(terminateQueueOwnerForSession(sessionId), {
              code: failure === "timeout" ? "ETIMEDOUT" : 23,
            });
            const retained = await readQueueOwnerRecord(sessionId);
            assert(retained?.retirement);
            assert.deepEqual(
              { ...retained, retirement: undefined },
              { ...original, retirement: undefined },
            );
            assert.deepEqual(
              retained.retirement.descendants.toSorted((a, b) => a.pid - b.pid),
              tree.expectedWitnesses
                .filter((witness) => witness.pid !== owner.pid)
                .toSorted((a, b) => a.pid - b.pid),
            );
            assert.deepEqual(
              pids.map(isProcessAlive),
              [failure !== "partial", failure !== "partial", true],
              "helper failure must retain the lease while a detached descendant survives",
            );
          } finally {
            stub.mock.restore();
            syncBuiltinESMExports();
            await stopWitnesses(tree.expectedWitnesses);
            await tree.closed;
            await stopFixtureProcesses(helper?.pid ? [helper.pid] : []);
          }
        });
      });
    }
  },
);
