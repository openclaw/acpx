import assert from "node:assert/strict";
import childProcess, { spawn, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runTimedExecFile } from "../src/acp/client-process.js";
import { ProcessDescendants } from "../src/acp/process-descendants.js";
import { readProcessTable } from "../src/process-identity.js";

async function startTicks(pid: number): Promise<string | undefined> {
  const stat = await fs
    .readFile(`/proc/${pid}/stat`, "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") {
        throw error;
      }
      return undefined;
    });
  const fields = stat
    ?.slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  return fields?.[0] === "Z" ? undefined : fields?.[19];
}

function shiftedProcessTable(output: string): string {
  return output.replace(
    /^(\s*\d+\s+\d+\s+\d+\s+\S+\s+)(.+)$/gmu,
    (_line, prefix: string, birth: string) => {
      const shifted = new Date(Date.parse(`${birth} UTC`) + 3_600_000);
      const [weekday, day, month, year, time] = shifted.toUTCString().split(" ");
      return `${prefix}${weekday.slice(0, 3)} ${month} ${day} ${time} ${year}`;
    },
  );
}

test(
  "Linux descendant custody survives a changed lstart after its root exits",
  { skip: process.platform !== "linux", timeout: 15_000 },
  async (t) => {
    const leafCode = "process.send('ready'); setTimeout(() => process.exit(), 30000);";
    const rootCode = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(leafCode)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      "child.once('message', () => { child.disconnect(); child.unref(); process.send(child.pid); });",
      "process.on('message', () => process.exit());",
      "setTimeout(() => process.exit(), 30000);",
    ].join("");
    const root = spawn(process.execPath, ["-e", rootCode], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const rootClosed = once(root, "close");
    const sibling = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const siblingClosed = once(sibling, "close");
    const descendants = new ProcessDescendants(root);
    let leafPid: number | undefined;
    let leafBirth: string | undefined;
    const cleanup = async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      let leafGone = leafPid === undefined;
      try {
        await attempt(() => {
          descendants.retire();
          t.mock.restoreAll();
          syncBuiltinESMExports();
        });
        await attempt(async () => {
          if (leafPid && leafBirth && (await startTicks(leafPid)) === leafBirth) {
            process.kill(leafPid, "SIGKILL");
          }
        });
        for (const child of [root, sibling]) {
          await attempt(() => child.kill("SIGKILL"));
        }
        await attempt(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.all([rootClosed, siblingClosed]),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("fixture children did not close")),
                  2_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        });
        await attempt(async () => {
          if (leafPid) {
            const deadline = performance.now() + 2_000;
            while ((await startTicks(leafPid)) === leafBirth && performance.now() < deadline) {
              await delay(10);
            }
            leafGone = (await startTicks(leafPid)) === undefined;
          }
          assert.equal(leafGone, true, "fixture leaf cleanup did not finish");
        });
      } finally {
        process.stdout.write(
          `ACPX_CLOCK_FIXTURE ${JSON.stringify({
            phase: "cleanup",
            rootPid: root.pid,
            leafPid,
            siblingPid: sibling.pid,
            leafGone,
            cleanupErrors: errors.map(String),
          })}\n`,
        );
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "clock fixture cleanup failed");
      }
    };
    const failures: unknown[] = [];
    try {
      const [ready] = await once(root, "message", { signal: AbortSignal.timeout(5_000) });
      assert.equal(typeof ready, "number");
      leafPid = ready as number;
      assert.ok(sibling.pid);
      const birth = await startTicks(leafPid);
      leafBirth = birth;
      assert.ok(birth);
      process.stdout.write(
        `ACPX_CLOCK_FIXTURE ${JSON.stringify({ phase: "started", rootPid: root.pid, leafPid, siblingPid: sibling.pid, leafBirth })}\n`,
      );

      const execute = childProcess.execFile;
      let clockStepped = false;
      t.mock.method(childProcess, "execFile", ((
        command: string,
        args: readonly string[],
        options: ExecFileOptionsWithStringEncoding,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        execute(command, [...args], options, (error, stdout, stderr) => {
          // Model procps recomputing lstart after a wall-clock step. The real process
          // and its kernel start ticks stay unchanged; never change the host clock.
          const output =
            clockStepped && command === "ps" && args.some((arg) => arg.includes("lstart"))
              ? shiftedProcessTable(stdout)
              : stdout;
          callback(error, output, stderr);
        })) as typeof childProcess.execFile);
      syncBuiltinESMExports();

      assert.equal(await descendants.capture(), true);
      assert.equal(descendants.hasTrackedProcesses(), true);
      root.send("exit");
      await rootClosed;
      clockStepped = true;
      assert.equal(await startTicks(leafPid), birth);

      await descendants.signal("SIGTERM", 2_000);
      const deadline = performance.now() + 1_000;
      while ((await startTicks(leafPid)) && performance.now() < deadline) {
        await delay(10);
      }
      assert.ok(await startTicks(sibling.pid), "unrelated sibling was terminated");
      assert.equal(
        await startTicks(leafPid),
        undefined,
        "witnessed child survived the changed lstart",
      );
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "clock fixture and cleanup failed");
    }
  },
);

test(
  "native Linux table snapshots retain one helper per query without background polling",
  { skip: process.platform !== "linux", timeout: 15_000 },
  async (t) => {
    const execute = childProcess.execFile;
    const queries: string[] = [];
    t.mock.method(childProcess, "execFile", ((
      command: string,
      args: readonly string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queries.push(command);
      return execute(command, [...args], options, callback);
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const samples: Array<{ oldPsMs: number; procMs: number; processCount: number }> = [];
    for (let index = 0; index < 3; index += 1) {
      const beforePs = performance.now();
      await runTimedExecFile("ps", ["-e", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
        timeoutMs: 2_000,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      const beforeProc = performance.now();
      const table = await readProcessTable(2_000, undefined, [process.pid]);
      assert.equal(table.get(process.pid)?.birth.kind, "linux-proc");
      samples.push({
        oldPsMs: Math.round(beforeProc - beforePs),
        procMs: Math.round(performance.now() - beforeProc),
        processCount: table.size,
      });
    }
    assert.deepEqual(queries, Array.from({ length: 3 }, () => ["ps", process.execPath]).flat());
    await delay(150);
    assert.equal(queries.length, 6, "snapshots must not create a background poller");
    t.diagnostic(`native Linux snapshot cost: ${JSON.stringify(samples)}`);
  },
);
