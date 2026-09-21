import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

for (const crashFirst of [false, true]) {
  test(`turn ownership excludes stale reclaimers until the owner ${crashFirst ? "dies" : "releases"}`, async () => {
    await withTempHome(async (home) => {
      const marker = sessionEventLockPath("stale-processes");
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, JSON.stringify({ pid: 2147483647, created_at: "2000-01-01" }));
      const source = `
      import fs from 'node:fs/promises';
      import {acquireSessionTurn} from ${JSON.stringify(new URL("../src/session/turn-ownership.js", import.meta.url).href)};
      const messages = new Map();
      process.on('message', name => messages.get(name)?.());
      const wait = name => new Promise(resolve => messages.set(name, resolve));
      const release = wait('release');
      if (process.argv[1] === 'pause') {
        const unlink = fs.unlink;
        fs.unlink = async file => {
          if (String(file).endsWith(${JSON.stringify(path.basename(marker))})) {
            const resume = wait('resume');
            process.send('unlink-ready');
            await resume;
            fs.unlink = unlink;
          }
          return await unlink(file);
        };
      }
      process.send('attempting');
      const turn = await acquireSessionTurn('stale-processes', AbortSignal.timeout(10000));
      process.send('admitted');
      await release;
      await turn[Symbol.asyncDispose]();
      process.send('disposed');
      process.disconnect();
    `;
      const start = (mode: string) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", source, mode],
          {
            env: { ...process.env, HOME: home },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        const messages: string[] = [];
        let stderr = "";
        child.stderr!.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        child.on("message", (message) => {
          assert.equal(typeof message, "string");
          if (typeof message === "string") {
            messages.push(message);
          }
        });
        const exited = once(child, "close");
        const waitFor = async (message: string) => {
          const deadline = Date.now() + 10000;
          while (!messages.includes(message)) {
            assert.equal(child.exitCode, null, stderr);
            assert.ok(Date.now() < deadline, `missing ${message}: ${stderr}`);
            await delay(5);
          }
        };
        return { child, messages, exited, waitFor };
      };
      const first = start("pause");
      let second: ReturnType<typeof start> | undefined;
      try {
        await first.waitFor("unlink-ready");
        second = start("normal");
        await second.waitFor("attempting");
        await delay(100);
        assert.equal(
          second.messages.includes("admitted"),
          false,
          "competing stale reclaimer admitted",
        );
        first.child.send("resume");
        await first.waitFor("admitted");
        await delay(100);
        assert.equal(second.messages.includes("admitted"), false, "active turn lost ownership");
        if (crashFirst) {
          first.child.kill("SIGKILL");
          await first.exited;
        } else {
          first.child.send("release");
          await first.waitFor("disposed");
        }
        await second.waitFor("admitted");
        const payload = JSON.parse(await fs.readFile(marker, "utf8")) as { pid: number };
        assert.equal(payload.pid, second.child.pid);
        second.child.send("release");
        await second.waitFor("disposed");
        assert.deepEqual(await first.exited, crashFirst ? [null, "SIGKILL"] : [0, null]);
        assert.deepEqual(await second.exited, [0, null]);
      } finally {
        for (const actor of [first, second]) {
          if (actor && actor.child.exitCode === null && actor.child.signalCode === null) {
            actor.child.kill("SIGKILL");
            await actor.exited;
          }
        }
      }
    });
  });
}

test("removing a compatibility marker does not admit a second turn", async () => {
  await withTempHome(async () => {
    const first = await acquireSessionTurn("removed-marker");
    try {
      await fs.unlink(sessionEventLockPath("removed-marker"));
      await assert.rejects(acquireSessionTurn("removed-marker", AbortSignal.timeout(60)));
    } finally {
      await first[Symbol.asyncDispose]();
    }
    await (await acquireSessionTurn("removed-marker"))[Symbol.asyncDispose]();
  });
});

test("turn disposal keeps ownership until marker deletion finishes", async (t) => {
  await withTempHome(async () => {
    const marker = sessionEventLockPath("release-gap");
    const first = await acquireSessionTurn("release-gap");
    const deleted = gate();
    const resume = gate();
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (file: Parameters<typeof fs.unlink>[0]) => {
      await unlink(file);
      if (String(file).endsWith(path.basename(marker))) {
        deleted.resolve();
        await resume.promise;
      }
    });
    const disposal = first[Symbol.asyncDispose]();
    try {
      await deleted.promise;
      await assert.rejects(acquireSessionTurn("release-gap", AbortSignal.timeout(60)));
    } finally {
      resume.resolve();
      await disposal;
    }
    await (await acquireSessionTurn("release-gap"))[Symbol.asyncDispose]();
  });
});

test("the next acquisition retries marker cleanup and preserves its successor", async (t) => {
  await withTempHome(async () => {
    const marker = sessionEventLockPath("retry-release");
    const first = await acquireSessionTurn("retry-release");
    const unlink = fs.unlink;
    let fail = true;
    t.mock.method(fs, "unlink", async (file: Parameters<typeof fs.unlink>[0]) => {
      if (String(file).endsWith(path.basename(marker)) && fail) {
        fail = false;
        throw Object.assign(new Error("injected deletion failure"), { code: "EIO" });
      }
      return await unlink(file);
    });
    await assert.rejects(
      async () => await first[Symbol.asyncDispose](),
      /injected deletion failure/,
    );
    const next = await acquireSessionTurn("retry-release", AbortSignal.timeout(2000));
    try {
      const payload = await fs.readFile(marker, "utf8");
      await first[Symbol.asyncDispose]();
      assert.equal(await fs.readFile(marker, "utf8"), payload);
    } finally {
      await next[Symbol.asyncDispose]();
    }
  });
});

test("a partial no-hardlink publication cannot be reclaimed while its writer lives", async (t) => {
  await withTempHome(async () => {
    const published = gate();
    const resume = gate();
    t.mock.method(fs, "link", async () => {
      throw Object.assign(new Error("hardlinks unsupported"), { code: "ENOTSUP" });
    });
    const writeFile = fs.writeFile;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (typeof args[0] === "string" && args[0].endsWith("partial-live.stream.lock")) {
        await writeFile(args[0], "", { flag: "wx", mode: 0o600 });
        await fs.utimes(args[0], 0, 0);
        published.resolve();
        await resume.promise;
        return await writeFile(args[0], args[1], { encoding: "utf8" });
      }
      return await writeFile(...args);
    });
    const acquiring = acquireSessionTurn("partial-live");
    try {
      await published.promise;
      await assert.rejects(acquireSessionTurn("partial-live", AbortSignal.timeout(60)));
      assert.equal(await fs.readFile(sessionEventLockPath("partial-live"), "utf8"), "");
    } finally {
      resume.resolve();
      await (await acquiring)[Symbol.asyncDispose]();
    }
  });
});

test("failed admission excludes successors until owned cleanup finishes", async (t) => {
  await withTempHome(async () => {
    const cleanup = gate();
    const resume = gate();
    const failure = new Error("injected observation failure");
    const lstat = fs.lstat;
    let fail = true;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).endsWith("admission-cleanup.stream.lock") && fail) {
        fail = false;
        throw failure;
      }
      return await lstat(...args);
    });
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (file: Parameters<typeof fs.unlink>[0]) => {
      if (String(file).endsWith("admission-cleanup.stream.lock")) {
        cleanup.resolve();
        await resume.promise;
      }
      return await unlink(file);
    });
    const acquiring = acquireSessionTurn("admission-cleanup");
    const rejected = assert.rejects(acquiring, (error) => error === failure);
    try {
      await cleanup.promise;
      await assert.rejects(acquireSessionTurn("admission-cleanup", AbortSignal.timeout(60)));
    } finally {
      resume.resolve();
      await rejected;
    }
    await (await acquireSessionTurn("admission-cleanup"))[Symbol.asyncDispose]();
  });
});

test("a legacy acquirer winning the recovery handoff remains normal contention", async (t) => {
  await withTempHome(async () => {
    const marker = sessionEventLockPath("legacy-handoff");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ pid: 2147483647 }));
    const legacy = JSON.stringify({ pid: process.pid, created_at: "legacy-acquirer" });
    const collided = gate();
    const link = fs.link;
    let publications = 0;
    t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      publications++;
      if (publications === 2) {
        await fs.writeFile(args[1], legacy, { flag: "wx" });
        collided.resolve();
      }
      return await link(...args);
    });
    let settled = false;
    const acquiring = acquireSessionTurn("legacy-handoff", AbortSignal.timeout(2000));
    void acquiring.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await collided.promise;
      await delay(60);
      assert.equal(settled, false, "a live legacy marker must wait instead of rejecting EEXIST");
      assert.equal(await fs.readFile(marker, "utf8"), legacy);
    } finally {
      await fs.unlink(marker);
      await acquiring.then(
        async (turn) => await turn[Symbol.asyncDispose](),
        () => {},
      );
    }
    await (await acquireSessionTurn("legacy-handoff"))[Symbol.asyncDispose]();
  });
});
