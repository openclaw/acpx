import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalManager } from "../src/acp/terminal-manager.js";

function createCleanupHarness(killGraceMs = 10) {
  const manager = new TerminalManager({
    cwd: process.cwd(),
    permissionMode: "approve-all",
    killGraceMs,
  });
  const terminal = {
    process: {},
    killProcessGroup: false,
    descendantPids: new Set<number>(),
    exitCode: 0 as number | null | undefined,
    signal: null as NodeJS.Signals | null | undefined,
    exitPromise: Promise.resolve({ exitCode: 0, signal: null }),
    processGroupSnapshotPromise: undefined as Promise<void> | undefined,
  };
  const cleanup = manager as unknown as {
    waitForCleanupAfterSignal(value: typeof terminal): Promise<boolean>;
  };
  return { terminal, wait: () => cleanup.waitForCleanupAfterSignal(terminal) };
}

test("terminal cleanup stops probing descendants when its deadline expires", async (t) => {
  const { terminal, wait } = createCleanupHarness();
  const pid = 2147483000;
  terminal.descendantPids.add(pid);
  const kill = process.kill;
  let probes = 0;
  t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
    if (args[0] === pid && args[1] === 0) {
      probes += 1;
      return true;
    }
    return kill(...args);
  });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(await wait(), false);
    }
    const probesAtReturn = probes;
    assert.ok(probesAtReturn > 0);
    await delay(75);
    assert.equal(probes, probesAtReturn, "expired cleanup must not leave background pollers");
  } finally {
    terminal.descendantPids.clear();
  }
});

test("terminal cleanup waits for the exit snapshot within the same deadline", async () => {
  const { terminal, wait } = createCleanupHarness();
  let finishSnapshot = () => {};
  terminal.processGroupSnapshotPromise = new Promise<void>((resolve) => {
    finishSnapshot = resolve;
  });
  terminal.exitPromise = terminal.processGroupSnapshotPromise.then(() => ({
    exitCode: 0,
    signal: null,
  }));
  assert.equal(await wait(), false);
  finishSnapshot();
  await terminal.processGroupSnapshotPromise;
  terminal.processGroupSnapshotPromise = undefined;
  assert.equal(await wait(), true);
});

for (const killGraceMs of [Number.NaN, Infinity, 2_147_483_648]) {
  test(`terminal cleanup bounds a ${killGraceMs} grace period`, async () => {
    const { terminal, wait } = createCleanupHarness(killGraceMs);
    terminal.exitCode = undefined;
    terminal.signal = undefined;
    let settled = false;
    const waiting = wait().then((result) => {
      settled = true;
      return result;
    });
    try {
      await delay(50);
      assert.equal(settled, true, "invalid grace must not leave cleanup polling indefinitely");
      assert.equal(await waiting, false);
    } finally {
      terminal.exitCode = 0;
      terminal.signal = null;
      await waiting;
    }
  });
}

test("terminal cleanup deadline ignores backward wall-clock adjustments", async (t) => {
  const { terminal, wait } = createCleanupHarness();
  terminal.exitCode = undefined;
  terminal.signal = undefined;
  let now = 1000;
  t.mock.method(Date, "now", () => (now -= 1000));
  let settled = false;
  const waiting = wait().then((result) => {
    settled = true;
    return result;
  });
  try {
    await delay(50);
    assert.equal(settled, true);
    assert.equal(await waiting, false);
  } finally {
    terminal.exitCode = 0;
    terminal.signal = null;
    await waiting;
  }
});
