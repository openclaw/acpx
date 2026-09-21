import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionEventLockPath } from "../src/session/event-log.js";
import { acquireSessionTurn } from "../src/session/turn-ownership.js";
import { withTempHome } from "./queue-test-helpers.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("marker and guard failures remain retryable across consecutive acquisitions", async (t) => {
  await withTempHome(async () => {
    const marker = sessionEventLockPath("consecutive-failures");
    const first = await acquireSessionTurn("consecutive-failures");
    const unlink = fs.unlink;
    let markerFailures = 1;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]).endsWith(path.basename(marker)) && markerFailures-- > 0) {
        throw new Error("marker failure");
      }
      return await unlink(...args);
    });
    const rm = fs.rm;
    let guardFailures = 1;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(`${path.basename(marker)}.guard`) && guardFailures-- > 0) {
        throw new Error("guard failure");
      }
      return await rm(...args);
    });
    await assert.rejects(async () => await first[Symbol.asyncDispose](), /marker failure/);
    await assert.rejects(acquireSessionTurn("consecutive-failures"), /guard failure/);
    const next = await acquireSessionTurn("consecutive-failures", AbortSignal.timeout(2000));
    try {
      const payload = await fs.readFile(marker, "utf8");
      await first[Symbol.asyncDispose]();
      assert.equal(await fs.readFile(marker, "utf8"), payload);
      await assert.rejects(acquireSessionTurn("consecutive-failures", AbortSignal.timeout(60)));
    } finally {
      await next[Symbol.asyncDispose]();
    }
  });
});

test("concurrent retries share cleanup and cannot settle an in-flight owner", async (t) => {
  await withTempHome(async () => {
    const marker = sessionEventLockPath("concurrent-cleanup");
    const first = await acquireSessionTurn("concurrent-cleanup");
    const cleaning = gate();
    const resume = gate();
    const unlink = fs.unlink;
    let attempts = 0;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]).endsWith(path.basename(marker))) {
        attempts++;
        if (attempts === 1) {
          throw new Error("marker failure");
        }
        if (attempts === 2) {
          cleaning.resolve();
          await resume.promise;
        }
      }
      return await unlink(...args);
    });
    await assert.rejects(async () => await first[Symbol.asyncDispose](), /marker failure/);
    const acquiring = acquireSessionTurn("concurrent-cleanup", AbortSignal.timeout(2000));
    let retry: Promise<void> | undefined;
    try {
      await cleaning.promise;
      retry = Promise.all([first[Symbol.asyncDispose](), first[Symbol.asyncDispose]()]).then(
        () => {},
      );
      await assert.rejects(acquireSessionTurn("concurrent-cleanup", AbortSignal.timeout(60)));
      assert.equal(attempts, 2);
    } finally {
      resume.resolve();
      await retry;
      const next = await acquiring;
      try {
        await first[Symbol.asyncDispose]();
        assert.equal(attempts, 2);
        await assert.rejects(acquireSessionTurn("concurrent-cleanup", AbortSignal.timeout(60)));
      } finally {
        await next[Symbol.asyncDispose]();
      }
    }
  });
});

for (const releaseFailure of ["none", "before removal", "after removal"]) {
  test(`failed admission recovers marker cleanup with guard failure ${releaseFailure}`, async (t) => {
    await withTempHome(async () => {
      const marker = sessionEventLockPath("failed-admission");
      const controller = new AbortController();
      const primary = new Error("admission cancelled");
      const cleanup = new Error("marker cleanup failed");
      const release = new Error("guard release failed");
      const link = fs.link;
      t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
        await link(...args);
        controller.abort(primary);
      });
      const unlink = fs.unlink;
      let failMarker = true;
      t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
        if (String(args[0]).endsWith(path.basename(marker)) && failMarker) {
          failMarker = false;
          throw cleanup;
        }
        return await unlink(...args);
      });
      const rm = fs.rm;
      let failGuard = releaseFailure !== "none";
      t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (String(args[0]).endsWith(`${path.basename(marker)}.guard`) && failGuard) {
          failGuard = false;
          if (releaseFailure === "after removal") {
            await rm(...args);
          }
          throw release;
        }
        return await rm(...args);
      });
      await assert.rejects(
        acquireSessionTurn("failed-admission", controller.signal),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(
            error.errors,
            releaseFailure === "none" ? [primary, cleanup] : [primary, cleanup, release],
          );
          return true;
        },
      );
      t.mock.restoreAll();
      const payload = await fs.readFile(marker, "utf8");
      if (releaseFailure !== "before removal") {
        await assert.rejects(fs.access(`${marker}.guard`), { code: "ENOENT" });
        // Another process may own the mutation guard after failed admission.
        // Retrying must obtain it before inspecting/removing our old marker.
        await fs.writeFile(`${marker}.guard`, JSON.stringify({ pid: process.pid }), { flag: "wx" });
        await assert.rejects(acquireSessionTurn("failed-admission", AbortSignal.timeout(60)));
        assert.equal(await fs.readFile(marker, "utf8"), payload);
        await fs.unlink(`${marker}.guard`);
      }
      const next = await acquireSessionTurn("failed-admission", AbortSignal.timeout(2000));
      try {
        assert.notEqual(await fs.readFile(marker, "utf8"), payload);
      } finally {
        await next[Symbol.asyncDispose]();
      }
    });
  });
}

test("failed cleanup is shared across canonical directory aliases", async (t) => {
  await withTempHome(async (home) => {
    const first = await acquireSessionTurn("aliased-cleanup");
    const alias = path.join(home, "alias");
    await fs.symlink(home, alias, "junction");
    const unlink = fs.unlink;
    let fail = true;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]).endsWith("aliased-cleanup.stream.lock") && fail) {
        fail = false;
        throw new Error("marker failure");
      }
      return await unlink(...args);
    });
    await assert.rejects(async () => await first[Symbol.asyncDispose](), /marker failure/);
    t.mock.method(os, "homedir", () => alias);
    const next = await acquireSessionTurn("aliased-cleanup", AbortSignal.timeout(2000));
    try {
      const marker = sessionEventLockPath("aliased-cleanup");
      const payload = await fs.readFile(marker, "utf8");
      await first[Symbol.asyncDispose]();
      assert.equal(await fs.readFile(marker, "utf8"), payload);
    } finally {
      await next[Symbol.asyncDispose]();
      t.mock.restoreAll();
    }
  });
});
