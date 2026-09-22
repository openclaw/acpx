import assert from "node:assert/strict";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessDescendants } from "../src/acp/process-descendants.js";
import { TerminalManager } from "../src/acp/terminal-manager.js";

function isRunning(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout.trim().length > 0 && !result.stdout.trim().startsWith("Z");
}

for (const launch of ["argv", "shell"] as const) {
  test(
    `terminal ${launch} cleanup stops owned and escaped children once and releases their pipes`,
    { skip: process.platform === "win32", timeout: 10_000 },
    async (t) => {
      const manager = new TerminalManager({
        cwd: os.tmpdir(),
        permissionMode: "approve-all",
        killGraceMs: 150,
      });
      const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      let children: number[] = [];
      t.after(async () => {
        for (const pid of children) {
          if (isRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        sibling.kill("SIGKILL");
        await manager.shutdown();
      });
      const childCode = [
        "process.on('SIGTERM', () => console.log('TERM=' + process.pid));",
        "setInterval(() => {}, 1000);",
        "process.send('ready');",
      ].join("");
      const commandCode = [
        "const spawn = require('node:child_process').spawn;",
        "process.on('SIGTERM', () => {});",
        `const children = [false, true].map(detached => spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));`,
        "let ready = 0;",
        "for (const child of children) child.once('message', () => { child.disconnect(); if (++ready === children.length) console.log('READY=' + JSON.stringify(children.map(child => child.pid))); });",
        "setInterval(() => {}, 1000);",
      ].join("");
      const { terminalId } = await manager.createTerminal({
        sessionId: "fixture",
        ...(launch === "argv"
          ? { command: process.execPath, args: ["-e", commandCode] }
          : { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(commandCode)}` }),
      });
      const terminal = (
        manager as unknown as {
          terminals: Map<
            string,
            { process: ChildProcess & { stdout: Readable; stderr: Readable } }
          >;
        }
      ).terminals.get(terminalId);
      assert.ok(terminal);
      const params = { sessionId: "fixture", terminalId };
      for (let attempt = 0; children.length === 0; attempt += 1) {
        const { output } = await manager.terminalOutput(params);
        const match = output.match(/READY=(\[[^\n]+\])/u);
        if (match) {
          children = JSON.parse(match[1]) as number[];
        }
        assert.ok(attempt < 200, "fixture children did not become ready");
        await delay(10);
      }

      await manager.killTerminal(params);
      const { output } = await manager.terminalOutput(params);
      for (const pid of children) {
        assert.equal(isRunning(pid), false, "owned child survived terminal/kill");
        assert.equal(output.split("\n").filter((line) => line === `TERM=${pid}`).length, 1);
      }
      await manager.releaseTerminal(params);
      assert.equal(terminal.process.stdout.destroyed, true);
      assert.equal(terminal.process.stderr.destroyed, true);
      assert.ok(sibling.pid && isRunning(sibling.pid), "unrelated sibling was terminated");
      await assert.rejects(manager.terminalOutput(params), /Unknown terminal/u);
    },
  );
}

test(
  "timestamp terminal group ownership forgets reused PIDs and never adopts a recycled group",
  { skip: process.platform === "win32" },
  async (t) => {
    // Exercise macOS timestamp custody; Linux uses a raw proc table instead.
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    t.after(() => {
      if (platform) {
        Object.defineProperty(process, "platform", platform);
      }
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-identities-"));
    const tableFile = path.join(cwd, "processes");
    await fs.writeFile(
      path.join(cwd, "ps"),
      '#!/bin/sh\n[ "$LC_ALL" = C ] || exit 1\nexec /bin/cat "$ACPX_TEST_PROCESS_TABLE"\n',
      {
        mode: 0o755,
      },
    );
    const previousPath = process.env.PATH;
    const previousTable = process.env.ACPX_TEST_PROCESS_TABLE;
    const previousLocale = process.env.LC_ALL;
    process.env.PATH = `${cwd}${path.delimiter}${previousPath ?? ""}`;
    process.env.ACPX_TEST_PROCESS_TABLE = tableFile;
    process.env.LC_ALL = "fr_FR.UTF-8";
    t.after(async () => {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousTable === undefined) {
        delete process.env.ACPX_TEST_PROCESS_TABLE;
      } else {
        process.env.ACPX_TEST_PROCESS_TABLE = previousTable;
      }
      if (previousLocale === undefined) {
        delete process.env.LC_ALL;
      } else {
        process.env.LC_ALL = previousLocale;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const root = new ChildProcess();
    Object.assign(root, { pid: 2_147_480_000 });
    const descendantPid = 2_147_480_001;
    const descendants = new ProcessDescendants(root, { ownProcessGroup: true });
    t.after(() => descendants.retire());
    const signals: Array<{ pid: number; signal?: string | number }> = [];
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      signals.push({ pid, signal });
      return true;
    });
    const birth = "Wed Sep 16 10:00:00 2026";
    await fs.writeFile(tableFile, `${descendantPid} 1 ${root.pid} S ${birth}\n`);
    await descendants.capture();
    Object.assign(root, { exitCode: 0 });
    root.emit("exit", 0, null);
    await fs.writeFile(
      tableFile,
      `${descendantPid} 1 ${root.pid} S ${birth}\n${descendantPid + 2} 1 ${root.pid} S Fri Jan 01 00:00:00 2100\n`,
    );
    await descendants.signal("SIGTERM", 1000);
    assert.deepEqual(signals, [{ pid: descendantPid, signal: "SIGTERM" }]);
    signals.length = 0;

    await fs.writeFile(tableFile, `${descendantPid} 1 ${root.pid} S Wed Sep 16 10:00:01 2026\n`);
    await descendants.signal("SIGKILL", 1000);
    assert.deepEqual(signals, [], "reused PID received a signal");
    assert.equal(descendants.hasTrackedProcesses(), false);

    await fs.writeFile(tableFile, `${descendantPid + 1} 1 ${root.pid} S ${birth}\n`);
    await descendants.signal("SIGKILL", 1000);
    assert.deepEqual(signals, [], "a saved group ID adopted an unrelated process");
  },
);
