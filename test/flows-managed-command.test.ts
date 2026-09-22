import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FlowShellResult } from "../src/flows/types.js";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/flow-managed-command.js", import.meta.url));
type Report = {
  ending: string;
  result?: FlowShellResult;
  firstError?: string;
  nextError?: string;
  nextDispatched: boolean;
  signalAborted: boolean;
  acknowledgedTermination: boolean;
  aliveAtReturn: number[];
  ownedPids: number[];
  aliveBeforeDeadline: number[];
  runStatus?: string;
  nodeOutcome?: string;
};

async function nativeCase(mode: string): Promise<Report> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-managed-command-"));
  let report: Report | undefined;
  let failed = false;
  let originalFailure: unknown;
  try {
    const { stdout } = await exec(process.execPath, [fixture, root, mode], {
      cwd: root,
      // Preserve native Windows process-discovery variables as well as PATH.
      env: { ...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root },
      timeout: 15_000,
    });
    report = JSON.parse(stdout) as Report;
    assert.equal(
      await fs.stat(path.join(root, "late-command")).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
          }
          throw error;
        },
      ),
      false,
    );
  } catch (error) {
    failed = true;
    originalFailure = error;
  }
  const retired = new Set<number>();
  if (report) {
    for (const pid of report.ownedPids) {
      if (!report.aliveAtReturn.includes(pid)) {
        retired.add(pid);
      }
    }
  }
  try {
    await cleanupNativeChildren(root, retired);
    await fs.rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      failed ? [originalFailure, cleanupError] : [cleanupError],
      "Managed command fixture cleanup failed",
      { cause: cleanupError },
    );
  }
  if (failed) {
    throw originalFailure;
  }
  assert.ok(report);
  return report;
}

async function cleanupNativeChildren(root: string, retired: ReadonlySet<number>): Promise<void> {
  // Do not signal a PID already proved gone by this case's pre-rescue observation.
  const pids = await fs.readFile(path.join(root, "owned-pids"), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  for (const value of pids.trim().split("\n")) {
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 0 && !retired.has(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
        continue;
      }
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
          break;
        }
        assert.ok(Date.now() < deadline, `fixture rescue did not retire PID ${pid}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}

test(
  "function command deadline escalates TERM and returns partial diagnostics",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const report = await nativeCase("own-deadline");
    assert.equal(report.ending, "ok");
    assert.equal(
      report.acknowledgedTermination,
      true,
      "child must actually observe and ignore TERM",
    );
    assert.equal(report.result?.timedOut, true);
    assert.equal(report.result?.stdout, "partial stdout");
    assert.equal(report.result?.stderr, "partial stderr");
    assert.equal(report.result?.exitCode, null);
    assert.equal(report.result?.signal, "SIGKILL");
    assert.deepEqual(
      report.aliveAtReturn,
      [],
      "native cleanup must finish before the flow settles",
    );
  },
);

test(
  "outer node timeout joins native cleanup and denies a caught callback's next command",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const report = await nativeCase("outer-timeout");
    assert.equal(report.ending, "TimeoutError");
    assert.equal(report.firstError, "TimeoutError");
    assert.equal(report.nextError, "TimeoutError");
    assert.equal(report.nextDispatched, false);
    assert.equal(report.signalAborted, true);
    assert.equal(report.acknowledgedTermination, true);
    assert.deepEqual(
      report.aliveAtReturn,
      [],
      "runner failure cannot leave the owned command alive",
    );
  },
);

test(
  "successful function command waits for inherited streams after wrapper exit",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const report = await nativeCase("stdio-close");
    assert.equal(report.ending, "ok");
    assert.equal(report.result?.stdout, "early stdoutlate stdout");
    assert.equal(report.result?.stderr, "late stderr");
    assert.equal(report.result?.exitCode, 0);
    assert.equal(report.result?.timedOut, false);
  },
);

test("function command returns ordinary nonzero diagnostics without ending the node", async () => {
  const report = await nativeCase("nonzero");
  assert.equal(report.ending, "ok");
  assert.equal(report.result?.stdout, "ordinary stdout");
  assert.equal(report.result?.stderr, "ordinary stderr");
  assert.equal(report.result?.exitCode, 7);
  assert.equal(report.result?.signal, null);
  assert.equal(report.result?.timedOut, false);
});

test("FlowRunner reaps shell child when outer node deadline expires", async () => {
  const report = await nativeCase("shell-outer-timeout");
  assert.equal(report.ownedPids.length, 1);
  assert.deepEqual(report.aliveBeforeDeadline, report.ownedPids);
  assert.equal(report.ending, "TimeoutError");
  assert.equal(report.runStatus, "timed_out");
  assert.equal(report.nodeOutcome, "timed_out");
  assert.deepEqual(
    report.aliveAtReturn,
    [],
    "outer deadline must reap the real ready child before return",
  );
  if (process.platform !== "win32") {
    assert.equal(
      report.acknowledgedTermination,
      true,
      "POSIX child must observe TERM before escalation",
    );
  }
});
