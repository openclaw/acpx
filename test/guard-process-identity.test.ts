import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sessionEventLockPath } from "../src/session/event-log.js";
import { withQueueLeaseMutation } from "../src/session/queue/lease-mutation.js";
import { queueLockFilePath } from "../src/session/queue/paths.js";
import { acquireSessionTurn } from "../src/session/turn-ownership.js";
import { withTempHome } from "./queue-test-helpers.js";

const ORPHAN_PID = 2147483647;
const surfaces = ["mutation guard", "turn guard", "turn marker"] as const;
const execFileAsync = promisify(execFile);

async function runFixture(surface: string, scenario: string): Promise<void> {
  await withTempHome(async () => {
    await execFileAsync(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/guard-process-identity.js", import.meta.url)),
        surface,
        scenario,
      ],
      { timeout: 10_000 },
    );
  });
}

function lockPath(surface: (typeof surfaces)[number], id: string): string {
  if (surface === "mutation guard") {
    return `${queueLockFilePath(id)}.guard`;
  }
  const marker = sessionEventLockPath(id);
  return surface === "turn guard" ? `${marker}.guard` : marker;
}

for (const surface of surfaces) {
  for (const scenario of [
    "reused",
    "matching",
    "unknown",
    "other-kind",
    "foreign-pid-namespace",
    "foreign-time-namespace",
    "foreign-namespace-missing-pid",
    "prior-boot",
    "reused-unsupported-time-namespace",
    "malformed",
    "changed-during-reclaim",
    "refresh-matching",
    "refresh-unknown",
    "publish",
    "publish-unverified",
    ...(surface === "mutation guard" ? [] : ["abort-probe"]),
  ]) {
    test(`${surface} process identity: ${scenario}`, async () => {
      await runFixture(surface, scenario);
    });
  }
}

test("queue lease refreshes reuse an unavailable captured identity without a helper backlog", async () => {
  await runFixture("mutation guard", "lease-refresh-unknown");
});

test("failed lease admission reuses its unavailable identity while reacquiring its guard", async () => {
  await runFixture("mutation guard", "lease-settlement-unknown");
});

for (const surface of surfaces) {
  for (const initialProbe of ["alive", "unknown"] as const) {
    test(`legacy ${surface} preserves a ${initialProbe} PID until definite exit`, async (t) => {
      await withTempHome(async () => {
        const id = `legacy-${surface.replaceAll(" ", "-")}-${initialProbe}`;
        const file = lockPath(surface, id);
        const payload = JSON.stringify({ pid: ORPHAN_PID, created_at: "2000-01-01" });
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, payload);
        await fs.utimes(file, 0, 0);

        let exited = false;
        const blocked = new Error("observed preserved legacy owner");
        const controller = new AbortController();
        const signals: Array<NodeJS.Signals | number | undefined> = [];
        const kill = process.kill;
        // This is the orphan/reused-PID state without relying on OS PID churn.
        t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
          if (args[0] !== ORPHAN_PID) {
            return kill(...args);
          }
          signals.push(args[1]);
          if (!exited && surface !== "mutation guard") {
            controller.abort(blocked);
          }
          if (exited || initialProbe === "unknown") {
            throw Object.assign(new Error("fixture process probe"), {
              code: exited ? "ESRCH" : "EPERM",
            });
          }
          return true;
        });

        let admitted = 0;
        const acquire = async (signal: AbortSignal) => {
          if (surface === "mutation guard") {
            await withQueueLeaseMutation(id, async () => {
              admitted += 1;
            });
          } else {
            const turn = await acquireSessionTurn(id, signal);
            admitted += 1;
            await turn[Symbol.asyncDispose]();
          }
        };

        await assert.rejects(
          acquire(controller.signal),
          surface === "mutation guard"
            ? { code: "file_lock_timeout" }
            : (error) => error === blocked,
        );
        assert.equal(admitted, 0);
        assert.equal(await fs.readFile(file, "utf8"), payload);
        exited = true;
        await acquire(AbortSignal.timeout(5_000));
        assert.equal(admitted, 1);
        assert.ok(signals.length > 0);
        assert.ok(
          signals.every((signal) => signal === 0),
          "recovery must never signal a PID",
        );
        await assert.rejects(fs.access(file), { code: "ENOENT" });
      });
    });
  }
}
