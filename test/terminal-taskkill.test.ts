import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { TerminalManager, killWindowsProcessTree } from "../src/acp/terminal-manager.js";

function getManagedPid(manager: TerminalManager, terminalId: string): number | undefined {
  const terminals = (
    manager as unknown as {
      terminals: Map<string, { process: { pid?: number } }>;
    }
  ).terminals;
  return terminals.get(terminalId)?.process.pid;
}

async function rejectIfHung<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs = 1_500,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function killRecordedHelperPids(pidPath: string): Promise<void> {
  try {
    const pids = (await fs.readFile(pidPath, "utf8"))
      .split("\n")
      .map((line) => Number(line))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best-effort cleanup of the hung helper
      }
    }
  } catch {
    // no helper pids recorded
  }
}

function resolveWindowsCscPath(): string | undefined {
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function installWindowsHangingTaskkill(bin: string): Promise<void> {
  const csc = resolveWindowsCscPath();
  if (csc) {
    await fs.writeFile(
      path.join(bin, "hang.cs"),
      [
        "using System.Diagnostics;",
        "using System.IO;",
        "using System.Threading;",
        "class P {",
        "  static void Main() {",
        '    File.AppendAllText("taskkill.pid", Process.GetCurrentProcess().Id + "\\n");',
        "    Thread.Sleep(Timeout.Infinite);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    execFileSync(csc, ["/nologo", "/out:taskkill.exe", "hang.cs"], { cwd: bin, stdio: "ignore" });
    return;
  }

  await fs.copyFile(process.execPath, path.join(bin, "taskkill.exe"));
  await fs.writeFile(
    path.join(bin, "hang.cjs"),
    [
      "const fs = require('node:fs');",
      "fs.appendFileSync('taskkill.pid', String(process.pid) + '\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      "",
    ].join("\n"),
  );
  process.env.NODE_OPTIONS = "--require ./hang.cjs";
}

async function withHangingTaskkillCommand<T>(run: () => Promise<T>): Promise<T> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-hanging-taskkill-"));
  const pidPath = path.join(bin, "taskkill.pid");
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH ?? "";
  const previousNodeOptions = process.env.NODE_OPTIONS;
  try {
    if (process.platform === "win32") {
      await installWindowsHangingTaskkill(bin);
    } else {
      await fs.writeFile(
        path.join(bin, "taskkill"),
        `#!/bin/sh\nprintf '%s\\n' "$$" >> taskkill.pid\nexec sleep 3600\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    }
    process.chdir(bin);
    return await run();
  } finally {
    process.chdir(previousCwd);
    process.env.PATH = previousPath;
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
    await killRecordedHelperPids(pidPath);
    try {
      await fs.rm(bin, { recursive: true, force: true });
    } catch {
      // Windows can keep a brief lock on a just-killed helper executable.
    }
  }
}

describe("hung Windows taskkill", { concurrency: false }, () => {
  test("killWindowsProcessTree returns after hung taskkill times out", async () => {
    const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(target, "spawn");
    const targetPid = target.pid;
    assert.ok(targetPid);
    try {
      await withHangingTaskkillCommand(async () => {
        await rejectIfHung(
          killWindowsProcessTree(targetPid, "SIGKILL", 200),
          "killWindowsProcessTree hung on taskkill",
        );
      });
    } finally {
      if (target.exitCode === null && target.signalCode === null) {
        const closed = once(target, "close");
        target.kill("SIGKILL");
        await closed;
      }
    }
  });

  for (const operation of ["killTerminal", "releaseTerminal"] as const) {
    test(`terminal manager ${operation} rejects and retains cleanup state when taskkill hangs`, async (t) => {
      if (process.platform !== "win32") {
        t.skip("Windows taskkill hang assertion");
        return;
      }

      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
      const manager = new TerminalManager({
        cwd: tmp,
        permissionMode: "approve-all",
        killGraceMs: 200,
        processHelperTimeoutMs: 200,
      });
      let createdTerminalId: string | undefined;
      try {
        const created = await manager.createTerminal({
          sessionId: "session-1",
          command: "ping -t 127.0.0.1",
        });
        createdTerminalId = created.terminalId;
        const pid = getManagedPid(manager, created.terminalId);
        assert.ok(pid);

        await withHangingTaskkillCommand(async () => {
          await assert.rejects(
            rejectIfHung(
              manager[operation]({
                sessionId: "session-1",
                terminalId: created.terminalId,
              }),
              `${operation} hung on taskkill`,
              3_000,
            ),
            /Terminal process cleanup did not finish after SIGKILL/,
          );
          assert.equal(getManagedPid(manager, created.terminalId), pid);
          assert.doesNotThrow(() => process.kill(pid, 0));
        });
        await manager.releaseTerminal({ sessionId: "session-1", terminalId: created.terminalId });
        assert.equal(getManagedPid(manager, created.terminalId), undefined);
        assert.throws(() => process.kill(pid, 0));
      } finally {
        const pid = createdTerminalId ? getManagedPid(manager, createdTerminalId) : undefined;
        if (pid) {
          try {
            execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
          } catch {
            // best-effort cleanup after a stubbed taskkill
          }
        }
        try {
          await fs.rm(tmp, { recursive: true, force: true });
        } catch {
          // The shell child can outlive a hung taskkill and keep the temp dir locked.
        }
      }
    });
  }
});
