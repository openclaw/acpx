import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ensureLifelineHelper, resolveLifelineHelper } from "../src/acp/lifeline.js";
import { isProcessAlive } from "../src/process-liveness.js";
import { getAcpxVersion } from "../src/version.js";
import { LIFELINE_HELPER_ENV, resolveTestLifelineHelper } from "./lifeline-test-helper.js";
import { fileExists, withTempDir } from "./runtime-test-helpers.js";

test("resolveLifelineHelper ignores helper binaries from the current working directory", async () => {
  const previousCwd = process.cwd();
  await withTempDir("acpx-lifeline-cwd-", async (tempDir) => {
    const fakeHelper = path.join(tempDir, "dist", "native", "lifeline-darwin-testarch");
    await fs.mkdir(path.dirname(fakeHelper), { recursive: true });
    await fs.writeFile(fakeHelper, "", "utf8");
    // Make it executable so the assertion proves the CWD is ignored, not merely
    // that the file fails the X_OK resolution check.
    await fs.chmod(fakeHelper, 0o755);

    process.chdir(tempDir);
    try {
      assert.equal(resolveLifelineHelper("darwin", "testarch"), undefined);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("resolveLifelineHelper accepts an existing absolute env override", async () => {
  const previous = process.env[LIFELINE_HELPER_ENV];
  await withTempDir("acpx-lifeline-env-", async (tempDir) => {
    const helper = path.join(tempDir, "lifeline-helper");
    await fs.writeFile(helper, "", "utf8");
    await fs.chmod(helper, 0o755);
    process.env[LIFELINE_HELPER_ENV] = helper;

    try {
      assert.equal(resolveLifelineHelper("darwin", "testarch"), helper);
    } finally {
      if (previous === undefined) {
        delete process.env[LIFELINE_HELPER_ENV];
      } else {
        process.env[LIFELINE_HELPER_ENV] = previous;
      }
    }
  });
});

test("resolveLifelineHelper rejects an existing non-executable absolute env override", async () => {
  await withTempDir("acpx-lifeline-env-nonexec-", async (tempDir) => {
    const helper = path.join(tempDir, "lifeline-helper");
    await fs.writeFile(helper, "", { encoding: "utf8", mode: 0o644 });
    await fs.chmod(helper, 0o644);

    await withEnv({ [LIFELINE_HELPER_ENV]: helper }, async () => {
      assert.equal(resolveLifelineHelper("darwin", "testarch"), undefined);
    });
  });
});

test("ensureLifelineHelper compiles the packaged lifeline source into the user cache", async (t) => {
  if (process.platform === "win32") {
    t.skip("lifeline helper is POSIX-only");
    return;
  }
  if (!(await commandExists(process.env.CC ?? "cc"))) {
    t.skip("cc is unavailable");
    return;
  }

  await withTempDir("acpx-lifeline-cache-", async (homeDir) => {
    const arch = `cache-test-${process.pid}`;
    await withEnv(
      {
        HOME: homeDir,
        [LIFELINE_HELPER_ENV]: undefined,
      },
      async () => {
        const helper = await ensureLifelineHelper({ arch });
        assert(helper, "helper must compile into cache");
        assert.equal(path.dirname(helper), path.join(homeDir, ".acpx", "native"));
        assert.match(
          path.basename(helper),
          new RegExp(`^lifeline-${escapeRegExp(getAcpxVersion())}-`),
        );

        const firstStat = await fs.stat(helper);
        const second = await ensureLifelineHelper({ arch });
        const secondStat = await fs.stat(helper);

        assert.equal(second, helper);
        assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, "cache hit must not recompile");
      },
    );
  });
});

test("ensureLifelineHelper records lazy compile failures and does not retry in process", async (t) => {
  if (process.platform === "win32") {
    t.skip("lifeline helper is POSIX-only");
    return;
  }

  await withTempDir("acpx-lifeline-cache-fail-", async (homeDir) => {
    const arch = `cache-fail-test-${process.pid}`;
    const messages: string[] = [];
    await withEnv(
      {
        CC: path.join(homeDir, "missing-cc"),
        HOME: homeDir,
        [LIFELINE_HELPER_ENV]: undefined,
      },
      async () => {
        assert.equal(
          await ensureLifelineHelper({ arch, log: (message: string) => messages.push(message) }),
          undefined,
        );
        assert.equal(
          await ensureLifelineHelper({ arch, log: (message: string) => messages.push(message) }),
          undefined,
        );

        const nativeDir = path.join(homeDir, ".acpx", "native");
        const markers = (await fs.readdir(nativeDir)).filter((entry) => entry.endsWith(".failed"));
        assert.equal(markers.length, 1);
        assert.equal(messages.length, 1, "compile failure should log once per process");
      },
    );
  });
});

test("native lifeline disarms when the bridge process group disappears before owner EOF", async (t) => {
  if (process.platform === "win32") {
    t.skip("lifeline helper is POSIX-only");
    return;
  }

  const helper = await resolveTestLifelineHelper();
  if (!helper) {
    t.skip("lifeline helper binary is unavailable");
    return;
  }

  const bridge = spawn(process.execPath, ["--eval", "setTimeout(() => process.exit(0), 50);"], {
    detached: true,
    stdio: "ignore",
  });
  assert(bridge.pid, "bridge must receive a PID");
  const bridgeExit = once(bridge, "exit");
  bridge.unref();

  let watchdog: ChildProcess | undefined;

  try {
    watchdog = spawn(helper, [String(bridge.pid)], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(watchdog, "spawn");
    await bridgeExit;

    await waitForChildExit(watchdog, 2_000);
    assert.equal(watchdog.exitCode, 0, "lifeline should exit cleanly after disarming");
  } finally {
    killProcessIfAlive(watchdog?.pid);
    killProcessGroupIfAlive(bridge.pid);
  }
});

test("native lifeline SIGKILLs TERM-resistant descendants after the bridge exits", async (t) => {
  if (process.platform === "win32") {
    t.skip("lifeline helper is POSIX-only");
    return;
  }

  const helper = await resolveTestLifelineHelper();
  if (!helper) {
    t.skip("lifeline helper binary is unavailable");
    return;
  }

  await withTempDir("acpx-lifeline-term-resistant-descendant-", async (tempDir) => {
    const bridgePidFile = path.join(tempDir, "bridge.pid");
    const grandchildPidFile = path.join(tempDir, "grandchild.pid");
    const grandchildScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const bridgeScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], {
  stdio: "ignore",
});
if (!grandchild.pid) {
  process.exit(2);
}
grandchild.unref();
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid) + "\\n", "utf8");
fs.writeFileSync(${JSON.stringify(bridgePidFile)}, String(process.pid) + "\\n", "utf8");
setTimeout(() => process.exit(0), 50);
`;

    const bridge = spawn(process.execPath, ["--eval", bridgeScript], {
      detached: true,
      stdio: "ignore",
    });
    assert(bridge.pid, "bridge must receive a PID");
    const bridgeExit = once(bridge, "exit");
    bridge.unref();

    let grandchildPid: number | undefined;
    let watchdog: ChildProcess | undefined;

    try {
      assert.equal(await waitUntil(() => fileExists(bridgePidFile)), true);
      assert.equal(await waitUntil(() => fileExists(grandchildPidFile)), true);
      grandchildPid = Number((await fs.readFile(grandchildPidFile, "utf8")).trim());
      assert(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild PID must be valid");
      assert.equal(isProcessAlive(grandchildPid), true, "grandchild must start alive");

      watchdog = spawn(helper, [String(bridge.pid)], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      await once(watchdog, "spawn");
      await bridgeExit;
      watchdog.stdin?.end();
      await once(watchdog, "exit");

      assert.equal(
        await waitUntil(() => Promise.resolve(!isProcessAlive(grandchildPid))),
        true,
        "TERM-resistant grandchild must be killed by lifeline SIGKILL fallback",
      );
    } finally {
      killProcessIfAlive(watchdog?.pid);
      killProcessGroupIfAlive(bridge.pid);
      killProcessIfAlive(grandchildPid);
    }
  });
});

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = execFile(command, ["--version"], (error: Error | null) => {
      resolve(!error);
    });
    child.on("error", () => resolve(false));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 2_000,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function killProcessIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort cleanup
  }
}

function killProcessGroupIfAlive(pgid: number | undefined): void {
  if (pgid === undefined) {
    return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // best effort cleanup
  }
}

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
