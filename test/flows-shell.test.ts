import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import {
  formatShellActionSummary,
  renderShellCommand,
  resolveShellActionTimeoutMs,
  runShellAction,
} from "../src/flows/executors/shell.js";
import {
  actorStopped,
  bounded,
  HOST_STOP,
  type FlowHostMode,
  type FlowHostReport,
} from "./fixtures/flow-shell-host.js";

type HostResult = {
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutEof: boolean;
  stderrEof: boolean;
};

class HostDeadlineError extends Error {
  constructor(
    message: string,
    options: ErrorOptions,
    readonly receipt: HostResult,
  ) {
    super(message, options);
  }
}

async function runHostScript(
  script: string,
  options: { detached?: boolean; timeoutMs?: number; cleanupMs?: number } = {},
): Promise<HostResult> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: options.detached,
  });
  assert.ok(child.stdout && child.stderr);
  let stdout = "";
  let stderr = "";
  let stdoutEof = false;
  let stderrEof = false;
  let exited = false;
  let childError: Error | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.once("end", () => {
    stdoutEof = true;
  });
  child.stderr.once("end", () => {
    stderrEof = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.on("error", (error) => {
    childError = error;
  });
  const closed = new Promise<HostResult>((resolve) => {
    child.once("close", (exitCode, signal) => {
      resolve({ pid: child.pid, exitCode, signal, stdout, stderr, stdoutEof, stderrEof });
    });
  });
  let result: HostResult;
  try {
    result = await bounded(closed, "host result", options.timeoutMs ?? 20_000);
  } catch (primary) {
    // Ask the live host to cancel through FlowRunner before disposing our handle.
    if (child.connected) {
      child.send(HOST_STOP, () => {});
    }
    try {
      result = await bounded(closed, "host cooperative cleanup", options.cleanupMs ?? 15_000);
    } catch (cleanupError) {
      if (!exited) {
        child.kill("SIGKILL");
      }
      try {
        result = await bounded(closed, "host native close", 5_000);
      } catch (closeError) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.channel?.unref();
        child.unref();
        throw new AggregateError(
          [primary, cleanupError, closeError],
          "Host did not close after cleanup",
          { cause: closeError },
        );
      }
    }
    throw new HostDeadlineError(
      primary instanceof Error ? primary.message : String(primary),
      { cause: primary },
      result,
    );
  }
  assert.ifError(childError);
  assert.ok(result.stdoutEof && result.stderrEof, "host must close both inherited output streams");
  return result;
}

test("host outcome timeout remains a failure after cooperative native close", async () => {
  await assert.rejects(
    runHostScript(
      `
      process.on('message', message => {
        if (message === ${JSON.stringify(HOST_STOP)}) {
          process.stdout.write('stopped', error => process.exit(error ? 1 : 0));
        }
      });
      setInterval(() => {}, 1000);
    `,
      { timeoutMs: 150 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HostDeadlineError);
      assert.match(error.message, /host result did not finish within 150ms/);
      assert.equal(error.receipt.exitCode, 0);
      assert.equal(error.receipt.signal, null);
      assert.equal(error.receipt.stdout, "stopped");
      assert.equal(error.receipt.stdoutEof, true);
      assert.equal(error.receipt.stderrEof, true);
      return true;
    },
  );
});

test("host observation joins inherited output after the original host exits", async () => {
  const host = await runHostScript(`
    import {spawn} from 'node:child_process';
    spawn(process.execPath, ['-e', "setTimeout(()=>{process.stdout.write('late stdout');process.stderr.write('late stderr');},150)"], {stdio:['ignore','inherit','inherit']});
    process.exit(0);
  `);
  assert.equal(host.exitCode, 0);
  assert.equal(host.stdout, "late stdout");
  assert.equal(host.stderr, "late stderr");
});

test("renderShellCommand quotes arguments consistently", () => {
  assert.equal(renderShellCommand("echo", ["hello", "two words"]), 'echo "hello" "two words"');
});

test("formatShellActionSummary prefixes rendered commands", () => {
  assert.equal(
    formatShellActionSummary({
      command: "git",
      args: ["status", "--short"],
    }),
    'shell: git "status" "--short"',
  );
});

test("runShellAction captures stdout and stderr", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("ok"); process.stderr.write("warn");'],
  });

  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  assert.equal(result.combinedOutput, "okwarn");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("runShellAction allows non-zero exits when requested", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
    allowNonZeroExit: true,
  });

  assert.equal(result.exitCode, 3);
});

test("runShellAction rejects non-zero exits by default", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("boom"); process.exit(2)'],
      }),
    /Shell action failed/,
  );
});

test("runShellAction times out long-running commands", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 50,
      }),
    (error: unknown) => error instanceof TimeoutError,
  );
});

test("resolveShellActionTimeoutMs treats non-positive as no deadline", () => {
  assert.equal(resolveShellActionTimeoutMs(undefined), undefined);
  assert.equal(resolveShellActionTimeoutMs(0), undefined);
  assert.equal(resolveShellActionTimeoutMs(-1), undefined);
  assert.equal(resolveShellActionTimeoutMs(50), 50);
  assert.throws(() => resolveShellActionTimeoutMs(Number.NaN), /timeoutMs/);
  assert.throws(() => resolveShellActionTimeoutMs(Infinity), /timeoutMs/);
});

test("runShellAction treats timeoutMs 0 as no deadline", async () => {
  const started = Date.now();
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 80)"],
    timeoutMs: 0,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started >= 70, "command should run to completion without a 1ms kill");
});

test("runShellAction reaps child when abort signal fires", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-abort-"));
  const pidFile = path.join(tmpDir, "pid");
  const ac = new AbortController();
  const pending = runShellAction(
    {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000)`,
      ],
    },
    { signal: ac.signal },
  );

  let pid: number | undefined;
  for (let i = 0; i < 50; i += 1) {
    try {
      pid = Number(await fs.readFile(pidFile, "utf8"));
      if (Number.isFinite(pid) && pid > 0) {
        break;
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(pid && pid > 0, "child should write pid");
  const childPid = pid;

  ac.abort();
  await assert.rejects(
    async () => await pending,
    (error: unknown) => error instanceof TimeoutError,
  );

  // Child must be reaped (process gone).
  await new Promise((r) => setTimeout(r, 50));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "aborted shell child should be reaped");
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("runShellAction rejects commands terminated by signal", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: "/bin/sh",
        args: ["-c", 'kill -TERM "$$"'],
      }),
    /signal SIGTERM/,
  );
});

test("runShellAction does not crash the host when the child exits before reading stdin", async () => {
  const moduleUrl = new URL("../src/flows/executors/shell.js", import.meta.url).href;
  const host = await runHostScript(`
    import { runShellAction } from ${JSON.stringify(moduleUrl)};
    const result = await runShellAction({
      command: process.execPath,
      args: ["-e", "setImmediate(() => process.exit(0))"],
      stdin: "x".repeat(1024 * 1024),
      allowNonZeroExit: true,
    });
    process.stdout.write(JSON.stringify({
      exitCode: result.exitCode,
      signal: result.signal,
    }));
  `);

  assert.equal(host.exitCode, 0, host.stderr);
  assert.doesNotMatch(host.stderr, /EPIPE|uncaughtException|Unhandled/);
  const payload = JSON.parse(host.stdout) as { exitCode: number | null; signal: string | null };
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.signal, null);
});

for (const detached of [false, true]) {
  test(`shell abort stops descendants after wrapper exit (detached=${detached})`, async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "acpx-shell-tree space & $dollar 'quote'-"),
    );
    const pidFile = path.join(dir, "descendant.pid");
    const controller = new AbortController();
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const wrapper = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${detached}});setInterval(()=>{},1000)`;
    const wrapperFile = path.join(dir, "wrapper.cjs");
    await fs.writeFile(wrapperFile, wrapper);
    const pending = runShellAction(
      {
        command:
          process.platform === "win32"
            ? '"%ACPX_TEST_NODE%" "%ACPX_TEST_WRAPPER%"'
            : '"$ACPX_TEST_NODE" "$ACPX_TEST_WRAPPER"',
        env: { ACPX_TEST_NODE: process.execPath, ACPX_TEST_WRAPPER: wrapperFile },
        shell: true,
        timeoutMs: 0,
      },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending, TimeoutError);
    let pid: number | undefined;
    t.after(async () => {
      controller.abort();
      await rejected;
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    });
    {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const candidate = Number(await fs.readFile(pidFile, "utf8"));
          if (Number.isInteger(candidate) && candidate > 1) {
            pid = candidate;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(pid && pid > 0, "descendant must start before abort");
      controller.abort();
      await rejected;
      const childPid = pid;
      if (process.platform === "win32") {
        assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
      } else {
        const observed = spawnSync("ps", ["-p", String(childPid), "-o", "stat="], {
          encoding: "utf8",
        });
        assert.ifError(observed.error);
        assert.ok(
          observed.status === 1 || observed.stdout.trim().startsWith("Z"),
          `descendant is still running: ${observed.stdout}`,
        );
      }
    }
  });
}

test("shell cancellation before launch preserves the cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new TimeoutError(10);
  controller.abort(reason);
  await assert.rejects(
    runShellAction({ command: "this-must-not-be-spawned" }, { signal: controller.signal }),
    (error) => error === reason,
  );
});

test("shell spawn errors remain authoritative with cancellation enabled", async () => {
  await assert.rejects(
    runShellAction(
      { command: "/nonexistent/acpx-shell-proof" },
      { signal: new AbortController().signal },
    ),
    { code: "ENOENT" },
  );
});

test(
  "failed process inspection still kills the shell and reports the cleanup error",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/executors/shell.js", import.meta.url).href;
    const host = await runHostScript(`
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import {runShellAction} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-shell-probe-failure-'));
    const pidFile=path.join(dir,'pid');
    const controller=new AbortController();
    const script="process.on('SIGTERM',()=>{});require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setInterval(()=>{},1000)";
    const pending=runShellAction({command:process.execPath,args:['-e',script],timeoutMs:0},{signal:controller.signal}).catch(error=>error);
    let pid;
    try {
      for(let i=0;i<250;i++) {
        try {const value=Number(await fs.readFile(pidFile,'utf8'));if(Number.isInteger(value)&&value>1){pid=value;break;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!pid)throw new Error('child did not start');
      process.env.PATH='/nonexistent/acpx-process-probe';
      controller.abort();
      const error=await pending;
      let alive=true;try{process.kill(pid,0);}catch(error){if(error.code!=='ESRCH')throw error;alive=false;}
      process.stdout.write(JSON.stringify({code:error.code,alive}));
    } finally {
      controller.abort();
      await pending;
      if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      await fs.rm(dir,{recursive:true,force:true});
    }
  `);
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), { code: "ENOENT", alive: false });
  },
);

const signalCases: Array<{ name: string; mode: FlowHostMode; expected: Record<string, unknown> }> =
  [
    {
      name: "POSIX flow interruption forwards SIGINT and waits for shell cleanup",
      mode: "interrupt",
      expected: { error: "InterruptedError", alive: false, sigintReceived: "SIGINT" },
    },
    {
      name: "an interrupted pending shell executor cannot launch later",
      mode: "late-executor",
      expected: { error: "InterruptedError", launched: false },
    },
    {
      name: "foreground interruption reaches descendants after normal shell completion",
      mode: "background",
      expected: { error: "InterruptedError", received: true },
    },
    {
      name: "foreground Ctrl-C retains detached descendants when the wrapper exits on SIGINT",
      mode: "wrapper-exit",
      expected: { error: "InterruptedError", alive: false, handled: "SIGINT" },
    },
    {
      name: "one foreground Ctrl-C delivers one graceful interrupt to the shell",
      mode: "one-interrupt",
      expected: { error: "InterruptedError", count: "1" },
    },
  ];

const flowHostModule = new URL("./fixtures/flow-shell-host.js", import.meta.url).href;

async function assertHostCleaned(host: HostResult): Promise<FlowHostReport> {
  const report = JSON.parse(host.stdout) as FlowHostReport;
  assert.equal(report.cleaned, true, host.stderr);
  await assert.rejects(fs.access(report.dir), { code: "ENOENT" });
  for (const actor of report.actors) {
    assert.ok(
      await actorStopped(actor),
      `${actor.role} must remain stopped after native host close`,
    );
  }
  assert.equal(host.signal, null);
  assert.equal(host.stdoutEof, true);
  assert.equal(host.stderrEof, true);
  return report;
}

for (const { name, mode, expected } of signalCases) {
  test(name, { skip: process.platform === "win32" }, async () => {
    const host = await runHostScript(
      `
      import {runFlowHostCase} from ${JSON.stringify(flowHostModule)};
      await runFlowHostCase(${JSON.stringify(mode)});
    `,
      { detached: true },
    );
    assert.equal(host.exitCode, 0, host.stderr);
    const report = await assertHostCleaned(host);
    assert.deepEqual(report.result, expected);
    assert.equal(
      report.actors.length,
      mode === "late-executor" ? 0 : mode === "background" || mode === "wrapper-exit" ? 2 : 1,
    );
  });
}

for (const failure of ["readiness", "body"] as const) {
  test(
    `flow host preserves ${failure} failure after cancelling owned detached actors`,
    { skip: process.platform === "win32" },
    async () => {
      const host = await runHostScript(
        `
      import {runFlowHostCase} from ${JSON.stringify(flowHostModule)};
      await runFlowHostCase('wrapper-exit', ${JSON.stringify(failure)});
    `,
        { detached: true },
      );
      assert.equal(host.exitCode, 1, host.stderr);
      const report = await assertHostCleaned(host);
      assert.equal(
        report.primaryError,
        failure === "readiness" ? "descendant did not start" : "synthetic body failure",
      );
      assert.equal(report.result, undefined);
      assert.equal(
        report.actors.length,
        2,
        "failure must occur with a real wrapper and detached descendant",
      );
      assert.match(host.stderr, new RegExp(`Error: ${report.primaryError}`));
      assert.doesNotMatch(host.stderr, /AggregateError|cleanup failed|did not finish within/);
    },
  );
}

test(
  "flow host retains body and publication failures after native actor retirement",
  { skip: process.platform === "win32" },
  async () => {
    const host = await runHostScript(
      `
      import {runFlowHostCase} from ${JSON.stringify(flowHostModule)};
      const bodyError = new Error('synthetic body failure');
      try {
        await runFlowHostCase('interrupt', 'publication', bodyError);
      } catch (error) {
        const entries = error instanceof AggregateError ? error.errors : null;
        process.stderr.write(JSON.stringify({
          isAggregateError: error instanceof AggregateError,
          name: error instanceof Error ? error.name : null,
          message: error instanceof Error ? error.message : null,
          bodyIsFirst: entries?.[0] === bodyError,
          causeIsSecond: entries !== null && error.cause === entries[1],
          errors: entries?.map(entry => ({
            isError: entry instanceof Error,
            name: entry instanceof Error ? entry.name : null,
            message: entry instanceof Error ? entry.message : null,
            hasCode: entry instanceof Object && 'code' in entry,
            code: entry instanceof Object && 'code' in entry ? entry.code : null,
            hasCause: entry instanceof Object && 'cause' in entry,
            hasErrors: entry instanceof Object && 'errors' in entry,
          })) ?? null,
        }));
        process.exitCode = 1;
      }
    `,
      { detached: true },
    );
    assert.equal(host.exitCode, 1, host.stderr);
    assert.equal(host.signal, null);
    assert.equal(host.stdoutEof, true);
    assert.equal(host.stderrEof, true);
    const report = JSON.parse(host.stdout) as FlowHostReport;
    assert.equal(report.primaryError, "synthetic body failure", host.stdout);
    assert.equal(report.actors.length, 1);
    for (const actor of report.actors) {
      assert.ok(await actorStopped(actor), `${actor.role} must retire through FlowRunner`);
    }
    assert.equal(report.cleaned, false, "an unexpected runner rejection must retain the fixture");
    try {
      assert.equal((await fs.stat(report.dir)).isDirectory(), true);
      const captured = JSON.parse(host.stderr) as { errors?: Array<{ message?: unknown }> };
      const lifecycleMessage = captured.errors?.[1]?.message;
      assert.ok(typeof lifecycleMessage === "string");
      assert.match(lifecycleMessage, /^EISDIR:.*rename /);
      assert.deepEqual(captured, {
        isAggregateError: true,
        name: "AggregateError",
        message: `Flow fixture cleanup failed; retained ${report.dir}`,
        bodyIsFirst: true,
        causeIsSecond: true,
        errors: [
          {
            isError: true,
            name: "Error",
            message: "synthetic body failure",
            hasCode: false,
            code: null,
            hasCause: false,
            hasErrors: false,
          },
          {
            isError: true,
            name: "Error",
            message: lifecycleMessage,
            hasCode: true,
            code: "EISDIR",
            hasCause: false,
            hasErrors: false,
          },
        ],
      });
      await assert.rejects(fs.access(path.join(report.dir, "rescue")), { code: "ENOENT" });
      assert.ok(
        !(await fs.readdir(report.dir)).some((name) => /\.(?:expired|rescued)$/.test(name)),
        "the filesystem fault must preserve native actor retirement",
      );
    } finally {
      await fs.rm(report.dir, { recursive: true, force: true });
    }
  },
);

test("shell capture stays unlimited by default and limits streams independently", async () => {
  const unlimited = await runShellAction({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("x".repeat(2*1024*1024))'],
  });
  assert.equal(Buffer.byteLength(unlimited.stdout), 2 * 1024 * 1024);
  const bounded = await runShellAction({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("aaaa");process.stderr.write("bbbb")'],
    maxBufferBytes: 4,
  });
  assert.equal(bounded.combinedOutput, "aaaabbbb");
  const empty = await runShellAction({
    command: process.execPath,
    args: ["-e", ""],
    maxBufferBytes: 0,
  });
  assert.equal(empty.combinedOutput, "");
});

test("shell capture rejects excess stdout and stderr even when nonzero exits are allowed", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(
      runShellAction({
        command: process.execPath,
        args: ["-e", `process.${stream}.write("12345")`],
        maxBufferBytes: 4,
        allowNonZeroExit: true,
      }),
      new RegExp(`maxBuffer.*${stream}`),
    );
  }
  await assert.rejects(
    runShellAction({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("x")'],
      maxBufferBytes: 0,
    }),
    /maxBuffer/,
  );
});

test("shell capture counts split UTF-8 characters without retaining partial prefixes", async () => {
  const args = [
    "-e",
    "process.stdout.write(Buffer.from([0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xa9])),20)",
  ];
  const result = await runShellAction({ command: process.execPath, args, maxBufferBytes: 2 });
  assert.equal(result.stdout, "é");
  await assert.rejects(
    runShellAction({ command: process.execPath, args, maxBufferBytes: 1 }),
    /maxBuffer/,
  );
});

test("shell capture rejects invalid limits before spawning", async () => {
  for (const maxBufferBytes of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      runShellAction({ command: "acpx-invalid-limit-must-not-spawn", maxBufferBytes }),
      /maxBufferBytes must be a non-negative safe integer/,
    );
  }
});

test(
  "shell capture preserves cancellation when a signal handler emits excess output",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cancel-output-"));
    const ready = path.join(dir, "ready");
    let owner: { cancel(signal: NodeJS.Signals): Promise<void> } | undefined;
    const script = `process.on('SIGTERM',()=>{process.stdout.write('x'.repeat(65536),()=>process.exit(0))});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
    const pending = runShellAction(
      { command: process.execPath, args: ["-e", script], maxBufferBytes: 1 },
      {
        registerOwner: (value) => {
          owner = value;
          return () => {};
        },
      },
    );
    const rejected = assert.rejects(pending, TimeoutError);
    try {
      let started = false;
      for (let i = 0; i < 250; i += 1) {
        if (
          await fs.stat(ready).then(
            () => true,
            () => false,
          )
        ) {
          started = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(started, "child must install its signal handler");
      assert.ok(owner);
      await owner.cancel("SIGTERM");
      await rejected;
    } finally {
      await owner?.cancel("SIGKILL");
      await rejected;
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
