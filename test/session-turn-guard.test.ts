import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sessionEventLockPath } from "../src/session/event-log.js";
import { acquireSessionTurn } from "../src/session/turn-ownership.js";
import { startKeeperProcess, withTempHome } from "./queue-test-helpers.js";

async function seedGuard(id: string, payload: string): Promise<string> {
  const guard = `${sessionEventLockPath(id)}.guard`;
  await fs.mkdir(path.dirname(guard), { recursive: true });
  await fs.writeFile(guard, payload);
  await fs.utimes(guard, 0, 0);
  return guard;
}

for (const payload of ["", "invalid", "{}", JSON.stringify({ pid: process.pid })]) {
  test(`old guard ${JSON.stringify(payload)} cannot be reclaimed by age`, async () => {
    await withTempHome(async () => {
      const guard = await seedGuard("old-guard", payload);
      await assert.rejects(acquireSessionTurn("old-guard", AbortSignal.timeout(60)));
      assert.equal(await fs.readFile(guard, "utf8"), payload);
      await assert.rejects(fs.access(sessionEventLockPath("old-guard")), { code: "ENOENT" });
    });
  });
}

test("an orphan reclamation directory survives cancelled admission", async () => {
  await withTempHome(async () => {
    const reclaim = `${sessionEventLockPath("orphan")}.guard.reclaim`;
    await fs.mkdir(reclaim, { recursive: true });
    await fs.utimes(reclaim, 0, 0);
    await assert.rejects(acquireSessionTurn("orphan", AbortSignal.timeout(60)));
    assert.equal((await fs.stat(reclaim)).isDirectory(), true);
    await assert.rejects(fs.access(sessionEventLockPath("orphan")), { code: "ENOENT" });
  });
});

for (const suffix of ["", ".guard"]) {
  test(`ambiguous PID liveness preserves the ${suffix ? "guard" : "legacy marker"}`, async (t) => {
    await withTempHome(async () => {
      const marker = `${sessionEventLockPath("ambiguous")}${suffix}`;
      await fs.mkdir(path.dirname(marker), { recursive: true });
      const payload = JSON.stringify({ pid: 2147483647 });
      await fs.writeFile(marker, payload);
      await fs.utimes(marker, 0, 0);
      const kill = process.kill;
      t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
        if (args[0] === 2147483647) {
          throw Object.assign(new Error("indeterminate liveness"), { code: "EPERM" });
        }
        return kill(...args);
      });
      await assert.rejects(acquireSessionTurn("ambiguous", AbortSignal.timeout(60)));
      assert.equal(await fs.readFile(marker, "utf8"), payload);
    });
  });
}

test("a live guard survives old age and is recovered after its process exits", async () => {
  await withTempHome(async () => {
    const keeper = await startKeeperProcess();
    const exited = once(keeper, "exit");
    try {
      const payload = JSON.stringify({ pid: keeper.pid });
      const guard = await seedGuard("dead-guard", payload);
      await assert.rejects(acquireSessionTurn("dead-guard", AbortSignal.timeout(60)));
      assert.equal(await fs.readFile(guard, "utf8"), payload);
      keeper.kill("SIGKILL");
      await exited;
      const recovered = await acquireSessionTurn("dead-guard", AbortSignal.timeout(2000));
      try {
        assert.equal(
          (JSON.parse(await fs.readFile(guard, "utf8")) as { pid: number }).pid,
          process.pid,
        );
      } finally {
        await recovered[Symbol.asyncDispose]();
      }
    } finally {
      if (keeper.exitCode === null && keeper.signalCode === null) {
        keeper.kill("SIGKILL");
        await exited;
      }
    }
  });
});

test("cancellation after publication cleans owned state before rejecting", async (t) => {
  await withTempHome(async () => {
    const controller = new AbortController();
    const reason = new Error("stop admission");
    const link = fs.link;
    t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      await link(...args);
      controller.abort(reason);
    });
    await assert.rejects(
      acquireSessionTurn("abort-published", controller.signal),
      (error) => error === reason,
    );
    const marker = sessionEventLockPath("abort-published");
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    await assert.rejects(fs.access(`${marker}.guard`), { code: "ENOENT" });
    t.mock.restoreAll();
    await (await acquireSessionTurn("abort-published"))[Symbol.asyncDispose]();
  });
});

test("an admitted turn retains ownership after its admission signal is aborted", async () => {
  await withTempHome(async () => {
    const controller = new AbortController();
    const first = await acquireSessionTurn("abort-held", controller.signal);
    controller.abort();
    try {
      await assert.rejects(acquireSessionTurn("abort-held", AbortSignal.timeout(60)));
    } finally {
      await first[Symbol.asyncDispose]();
    }
    await (await acquireSessionTurn("abort-held"))[Symbol.asyncDispose]();
  });
});

test("the next acquisition retries failed guard release without the original receipt", async (t) => {
  await withTempHome(async () => {
    const first = await acquireSessionTurn("guard-release");
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith("guard-release.stream.lock.guard") && fail) {
        fail = false;
        throw Object.assign(new Error("injected guard release failure"), { code: "EIO" });
      }
      return await rm(...args);
    });
    await assert.rejects(
      async () => await first[Symbol.asyncDispose](),
      /injected guard release failure/,
    );
    await (
      await acquireSessionTurn("guard-release", AbortSignal.timeout(2000))
    )[Symbol.asyncDispose]();
  });
});

test("failed admission releases its guard after invalid-marker cleanup fails", async () => {
  await withTempHome(async () => {
    const marker = sessionEventLockPath("invalid-marker");
    await fs.mkdir(marker, { recursive: true });
    await assert.rejects(acquireSessionTurn("invalid-marker"), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.ok(
        error.errors.every(
          (failure: unknown) =>
            failure instanceof Error && failure.message.includes("not a regular file"),
        ),
      );
      return true;
    });
    await assert.rejects(fs.access(`${marker}.guard`), { code: "ENOENT" });
    await fs.rmdir(marker);
    await (
      await acquireSessionTurn("invalid-marker", AbortSignal.timeout(2000))
    )[Symbol.asyncDispose]();
  });
});

test("failed publication and cleanup reads preserve both errors without stranding a guard", async (t) => {
  await withTempHome(async () => {
    const primary = new Error("publication failure");
    const cleanup = new Error("cleanup read failure");
    t.mock.method(fs, "link", async () => {
      throw primary;
    });
    const lstat = fs.lstat;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).endsWith("failed-publish.stream.lock")) {
        throw cleanup;
      }
      return await lstat(...args);
    });
    await assert.rejects(acquireSessionTurn("failed-publish"), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    });
    t.mock.restoreAll();
    await (
      await acquireSessionTurn("failed-publish", AbortSignal.timeout(2000))
    )[Symbol.asyncDispose]();
  });
});
