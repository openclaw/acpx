import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionEventLockPath } from "../src/session/event-log.js";
import { listSessions } from "../src/session/persistence.js";
import { acquireSessionImport, acquireSessionTurn } from "../src/session/turn-ownership.js";
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
    await first[Symbol.asyncDispose]();
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

test("import admission and opaque record turns keep independent ownership", async () => {
  await withTempHome(async (home) => {
    await using admission = await acquireSessionImport(AbortSignal.timeout(2_000));
    const marker = path.join(home, ".acpx", "sessions", ".import-admission.lock");
    const admissionPayload = await fs.readFile(marker, "utf8");
    await fs.access(`${marker}.guard`);
    for (const id of [".import-admission", ".import-admission.lock", "import:admission"]) {
      const turn = await acquireSessionTurn(id, AbortSignal.timeout(2_000));
      const turnMarker = sessionEventLockPath(id);
      try {
        assert.notEqual(turnMarker, marker);
        assert.notEqual(`${turnMarker}.guard`, `${marker}.guard`);
        await fs.access(turnMarker);
      } finally {
        await turn[Symbol.asyncDispose]();
      }
      assert.equal(await fs.readFile(marker, "utf8"), admissionPayload);
      await fs.access(`${marker}.guard`);
    }
    assert.deepEqual(await listSessions(), []);

    const id = ".import-admission.lock";
    const turn = await acquireSessionTurn(id, AbortSignal.timeout(2_000));
    const turnMarker = sessionEventLockPath(id);
    try {
      const turnPayload = await fs.readFile(turnMarker, "utf8");
      await admission[Symbol.asyncDispose]();
      await assert.rejects(fs.access(marker), { code: "ENOENT" });
      await assert.rejects(fs.access(`${marker}.guard`), { code: "ENOENT" });
      assert.equal(await fs.readFile(turnMarker, "utf8"), turnPayload);
      await fs.access(`${turnMarker}.guard`);
      await assert.rejects(acquireSessionTurn(id, AbortSignal.timeout(60)));
    } finally {
      await turn[Symbol.asyncDispose]();
    }
  });
});

test("import admission shares canonical store aliases and separates independent stores", async (t) => {
  await withTempHome(async (home) => {
    await using admission = await acquireSessionImport(AbortSignal.timeout(2_000));
    void admission;
    const directory = path.join(home, ".acpx", "sessions");
    const marker = path.join(directory, ".import-admission.lock");
    const payload = await fs.readFile(marker, "utf8");
    const homeAlias = path.join(home, "alias");
    await fs.symlink(home, homeAlias, "junction");
    const storeAliasHome = path.join(home, "store-alias");
    await fs.mkdir(path.join(storeAliasHome, ".acpx"), { recursive: true });
    await fs.symlink(directory, path.join(storeAliasHome, ".acpx", "sessions"), "junction");
    for (const alias of [homeAlias, storeAliasHome]) {
      const homedir = t.mock.method(os, "homedir", () => alias);
      try {
        const waiting = AbortSignal.timeout(60);
        await assert.rejects(acquireSessionImport(waiting));
        assert.equal(waiting.aborted, true);
        assert.equal(await fs.readFile(marker, "utf8"), payload);
      } finally {
        homedir.mock.restore();
      }
    }
    await withTempHome(async (otherHome) => {
      await using independent = await acquireSessionImport(AbortSignal.timeout(2_000));
      void independent;
      await fs.access(path.join(otherHome, ".acpx", "sessions", ".import-admission.lock"));
      assert.equal(await fs.readFile(marker, "utf8"), payload);
    });
  });
});
