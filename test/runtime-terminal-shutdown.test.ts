import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpRuntime, createAgentRegistry } from "../src/runtime.js";
import { InMemorySessionStore } from "./runtime-test-helpers.js";

test(
  "public runtime shutdown joins a terminal awaiting native spawn adoption",
  { timeout: 15_000 },
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-terminal-shutdown-"));
    const pidFile = path.join(cwd, "terminal.pid");
    const peer = path.resolve("dist-test/test/fixtures/idle-disconnect-agent.js");
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: new InMemorySessionStore(),
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [process.execPath, peer, "idle-eof", pidFile, path.join(cwd, "unused-trigger")],
        },
      }),
      permissionMode: "approve-all",
      timeoutMs: 5_000,
    });
    const children: ChildProcess[] = [];
    const closed: Promise<void>[] = [];
    const originalSpawn = childProcess.spawn;
    let terminal: ChildProcess | undefined;
    const adoption = { held: false };
    let release = () => {};
    let closing: Promise<void> | undefined;
    childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
      const child = originalSpawn(command, args, options);
      const isTerminal = command === process.execPath && args.some((arg) => arg.includes(pidFile));
      if (command === process.execPath && (args.includes(peer) || isTerminal)) {
        children.push(child);
        closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
      }
      if (isTerminal && !args.includes(peer)) {
        terminal = child;
        const emit = child.emit;
        child.emit = (event: string | symbol, ...values: unknown[]) => {
          if (event === "spawn") {
            adoption.held = true;
            release = () => {
              child.emit = emit;
              emit.call(child, event, ...values);
              release = () => {};
            };
            return true;
          }
          return emit.call(child, event, ...values);
        };
      }
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    try {
      await runtime.ensureSession({ sessionKey: "shutdown", agent: "fixture", mode: "persistent" });
      const deadline = performance.now() + 5_000;
      while (!adoption.held || !(await fs.stat(pidFile).catch(() => undefined))) {
        assert.ok(performance.now() < deadline, "the real terminal did not reach held adoption");
        await delay(10);
      }
      assert(terminal);
      assert.equal(Number(await fs.readFile(pidFile, "utf8")), terminal.pid);
      assert.equal(terminal.exitCode, null);
      assert.equal(terminal.signalCode, null);
      closing = runtime.shutdown();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([
          closing.then(() => "closed"),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("adoption pending"), 1_000);
          }),
        ]);
        assert.equal(
          state,
          "adoption pending",
          "shutdown returned while its native child was unadopted",
        );
      } finally {
        clearTimeout(timer);
        release();
      }
      await closing;
      assert.ok(terminal.exitCode !== null || terminal.signalCode !== null);
      await Promise.all(closed);
    } finally {
      release();
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      try {
        await (closing ?? runtime.shutdown());
      } finally {
        // The failing baseline may finish late adoption cleanup after shutdown.
        await Promise.race([Promise.all(closed), delay(1_000)]);
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
        await Promise.all(closed);
        await fs.rm(cwd, { recursive: true, force: true });
      }
    }
  },
);
