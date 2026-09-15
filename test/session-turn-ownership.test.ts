import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";
import { sessionEventLockPath } from "../src/session/event-log.js";
import { acquireSessionTurn } from "../src/session/turn-ownership.js";
import { startKeeperProcess, withTempHome } from "./queue-test-helpers.js";

test("session turn ownership serializes same-process callers and survives a canceled waiter", async (t) => {
  await withTempHome(async () => {
    const first = await acquireSessionTurn("same-process");
    t.after(() => first[Symbol.asyncDispose]());
    const original = await fs.readFile(sessionEventLockPath("same-process"), "utf8");
    await assert.rejects(acquireSessionTurn("same-process", AbortSignal.timeout(30)));
    assert.equal(await fs.readFile(sessionEventLockPath("same-process"), "utf8"), original);
    await first[Symbol.asyncDispose]();
    const next = await acquireSessionTurn("same-process");
    t.after(() => next[Symbol.asyncDispose]());
  });
});

test("session turn ownership never expires a live writer and recovers after SIGKILL", async (t) => {
  await withTempHome(async () => {
    const keeper = await startKeeperProcess();
    try {
      const first = await acquireSessionTurn("live-writer");
      t.after(() => first[Symbol.asyncDispose]());
      await first[Symbol.asyncDispose]();
      const filePath = sessionEventLockPath("live-writer");
      const payload = `${JSON.stringify({ pid: keeper.pid, created_at: "2026-01-01T00:00:00.000Z" })}\n`;
      await fs.writeFile(filePath, payload);
      await assert.rejects(acquireSessionTurn("live-writer", AbortSignal.timeout(30)));
      assert.equal(await fs.readFile(filePath, "utf8"), payload);
      const exited = once(keeper, "exit");
      keeper.kill("SIGKILL");
      await exited;
      const recovered = await acquireSessionTurn("live-writer");
      t.after(() => recovered[Symbol.asyncDispose]());
    } finally {
      if (keeper.exitCode == null && keeper.signalCode == null) {
        const exited = once(keeper, "exit");
        keeper.kill("SIGKILL");
        await exited;
      }
    }
  });
});

test("session turn release leaves a successor's lock intact", async (t) => {
  await withTempHome(async () => {
    const first = await acquireSessionTurn("successor");
    t.after(() => first[Symbol.asyncDispose]());
    const filePath = sessionEventLockPath("successor");
    await fs.unlink(filePath);
    const successor = await acquireSessionTurn("successor");
    t.after(() => successor[Symbol.asyncDispose]());
    const current = await fs.readFile(filePath, "utf8");
    await first[Symbol.asyncDispose]();
    assert.equal(await fs.readFile(filePath, "utf8"), current);
  });
});

test("session turn ownership preserves incomplete reservations until their grace period expires", async (t) => {
  await withTempHome(async () => {
    const first = await acquireSessionTurn("incomplete");
    t.after(() => first[Symbol.asyncDispose]());
    await first[Symbol.asyncDispose]();
    const filePath = sessionEventLockPath("incomplete");
    await fs.writeFile(filePath, "");
    await assert.rejects(acquireSessionTurn("incomplete", AbortSignal.timeout(30)));
    assert.equal(await fs.readFile(filePath, "utf8"), "");
    await fs.utimes(filePath, 0, 0);
    const recovered = await acquireSessionTurn("incomplete");
    t.after(() => recovered[Symbol.asyncDispose]());
  });
});

test("session turn ownership keeps exclusive creation on filesystems without hardlinks", async (t) => {
  t.mock.method(fs, "link", async () => {
    throw Object.assign(new Error("hardlinks unsupported"), { code: "ENOTSUP" });
  });
  await withTempHome(async () => {
    const first = await acquireSessionTurn("no-hardlinks");
    t.after(() => first[Symbol.asyncDispose]());
    await assert.rejects(acquireSessionTurn("no-hardlinks", AbortSignal.timeout(30)));
    const payload = JSON.parse(await fs.readFile(sessionEventLockPath("no-hardlinks"), "utf8")) as {
      pid: number;
    };
    assert.equal(payload.pid, process.pid);
  });
});

for (const replacement of [undefined, '{"pid":1,"created_at":"replacement"}\n']) {
  test(`session turn admission rejects a ${replacement ? "replaced" : "removed"} reservation`, async (t) => {
    const link = fs.link;
    t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      await link(...args);
      await fs.unlink(args[1]);
      if (replacement) {
        await fs.writeFile(args[1], replacement);
      }
    });
    await withTempHome(async () => {
      await assert.rejects(
        acquireSessionTurn("replaced-admission"),
        /ownership changed before admission/,
      );
      const current = await fs
        .readFile(sessionEventLockPath("replaced-admission"), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          assert.equal(error.code, "ENOENT");
          return undefined;
        });
      assert.equal(current, replacement);
    });
  });
}

test("session turn admission cleans its reservation after observation fails", async (t) => {
  const lstat = fs.lstat;
  let failed = false;
  const failure = new Error("injected observation failure");
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (!failed && String(args[0]).endsWith("observation-failure.stream.lock")) {
      failed = true;
      throw failure;
    }
    return await lstat(...args);
  });
  await withTempHome(async () => {
    await assert.rejects(acquireSessionTurn("observation-failure"), (error) => error === failure);
    await assert.rejects(fs.access(sessionEventLockPath("observation-failure")), {
      code: "ENOENT",
    });
  });
});
