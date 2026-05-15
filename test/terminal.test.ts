import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/acp/terminal-manager.js";
import { PermissionPromptUnavailableError } from "../src/errors.js";

test("terminal manager create/output/wait/release lifecycle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "console.log('hello-terminal')"],
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /hello-terminal/);
    assert.equal(outputResult.truncated, false);

    await manager.releaseTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    await assert.rejects(
      manager.terminalOutput({
        sessionId: "session-1",
        terminalId: created.terminalId,
      }),
      /Unknown terminal/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager runs a no-arg shell command line from command", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "printf 'one\\ntwo\\nthree\\n' | wc -l",
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /^\s*3\b/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager runs no-arg command lines with path arguments", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "echo hello /tmp",
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /hello \/tmp/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager runs no-arg command lines with shell quoting", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: 'printf "%s\\n" ok',
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(outputResult.output.trim(), "ok");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager runs no-arg command lines with env assignments", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "FOO=bar env",
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /^FOO=bar$/m);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager runs no-arg command lines with redirection", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "echo redirected > out.txt",
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);
    assert.equal((await fs.readFile(path.join(tmp, "out.txt"), "utf8")).trim(), "redirected");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager runs no-arg command lines with newline separators", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "echo one\necho two",
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(outputResult.output.trim(), "one\ntwo");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager preserves explicit empty argv", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable path assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const executable = path.join(tmp, "tool with space");
    await fs.writeFile(executable, "#!/bin/sh\necho empty-argv\n", { mode: 0o755 });
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: executable,
      args: [],
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /empty-argv/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager preserves omitted argv for executable paths", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable path assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const executable = path.join(tmp, "tool with space");
    await fs.writeFile(executable, "#!/bin/sh\necho omitted-argv\n", { mode: 0o755 });
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: executable,
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /omitted-argv/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager parses quoted no-arg executable paths", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable path assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const executable = path.join(tmp, "tool with space");
    await fs.writeFile(executable, "#!/bin/sh\necho quoted-no-arg-path\n", { mode: 0o755 });
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: JSON.stringify(executable),
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /quoted-no-arg-path/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager parses no-arg executable path command lines", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable path assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const executable = path.join(tmp, "tool");
    await fs.writeFile(executable, "#!/bin/sh\necho parsed-arg=$1\n", { mode: 0o755 });
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: `${JSON.stringify(executable)} hello`,
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /parsed-arg=hello/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager does not shell fallback executable path spawn errors", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shebang assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const executable = path.join(tmp, "badinterp");
    await fs.writeFile(executable, "#!/no/such/interpreter\necho should-not-run\n", {
      mode: 0o755,
    });
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    await assert.rejects(
      manager.createTerminal({
        sessionId: "session-1",
        command: executable,
      }),
      (error) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager does not split existing executable paths after spawn errors", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shebang assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  const markerPath = path.join(tmp, "prefix-ran");
  try {
    await fs.writeFile(
      path.join(tmp, "tool"),
      `#!/bin/sh\necho prefix > ${JSON.stringify(markerPath)}\n`,
      { mode: 0o755 },
    );
    const executable = path.join(tmp, "tool with space");
    await fs.writeFile(executable, "#!/no/such/interpreter\necho should-not-run\n", {
      mode: 0o755,
    });
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    await assert.rejects(
      manager.createTerminal({
        sessionId: "session-1",
        command: executable,
      }),
      (error) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    await assert.rejects(fs.access(markerPath));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager kills descendants of no-arg shell command lines", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process group assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  const childPidPath = path.join(tmp, "child.pid");
  const termCountPath = path.join(tmp, "child-term-count");

  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      killGraceMs: 200,
    });

    const childScript = [
      "const fs = require('node:fs');",
      "let termCount = 0;",
      `process.on('SIGTERM', () => { termCount += 1; fs.writeFileSync(${JSON.stringify(termCountPath)}, String(termCount)); });`,
      `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & wait`,
    });

    const childPid = await waitForPidFile(childPidPath);
    await manager.killTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.ok(waitResult.exitCode !== null || waitResult.signal !== null);
    assert.equal(await fs.readFile(termCountPath, "utf8"), "1");
    await assertPidExits(childPid);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager releases shell command groups after wrapper exit", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process group assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  const childPidPath = path.join(tmp, "child.pid");

  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      killGraceMs: 200,
    });

    const childScript = [
      "process.on('SIGTERM', () => {});",
      `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & echo done`,
    });

    const childPid = await waitForPidFile(childPidPath);
    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    await manager.releaseTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    await assertPidExits(childPid);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager preserves SIGTERM grace for shell groups after wrapper exit", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process group assertion");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  const childPidPath = path.join(tmp, "child.pid");
  const exitPath = path.join(tmp, "child-exit");
  const termPath = path.join(tmp, "child-term");

  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      killGraceMs: 1_000,
    });

    const childScript = [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(termPath)}, 'term'); setTimeout(() => process.exit(0), 150); });`,
      `process.on('exit', () => { fs.writeFileSync(${JSON.stringify(exitPath)}, 'exit'); });`,
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & echo done`,
    });

    const childPid = await waitForPidFile(childPidPath);
    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    await manager.releaseTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    await waitForFile(exitPath);
    assert.equal(await fs.readFile(termPath, "utf8"), "term");
    await assertPidExits(childPid);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager kill sends termination and process exits", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      killGraceMs: 200,
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    await manager.killTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.ok(waitResult.exitCode !== null || waitResult.signal !== null);

    await manager.releaseTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPidFile(pidPath: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number(await fs.readFile(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // keep waiting
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child pid file: ${pidPath}`);
    }
    await sleep(20);
  }
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      // keep waiting
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await sleep(20);
  }
}

async function assertPidExits(pid: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isPidAlive(pid)) {
      return;
    }

    if (Date.now() >= deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best-effort cleanup
      }
      assert.fail(`Found orphan child process: ${pid}`);
    }

    await sleep(100);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("terminal manager prompts in approve-reads mode and can deny", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    let confirmations = 0;
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-reads",
      confirmExecute: async () => {
        confirmations += 1;
        return false;
      },
    });

    await assert.rejects(
      manager.createTerminal({
        sessionId: "session-1",
        command: process.execPath,
        args: ["-e", "console.log('blocked')"],
      }),
      /Permission denied for terminal\/create/,
    );
    assert.equal(confirmations, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager fails when prompt is unavailable and policy is fail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
    });

    await assert.rejects(
      manager.createTerminal({
        sessionId: "session-1",
        command: process.execPath,
        args: ["-e", "console.log('blocked')"],
      }),
      PermissionPromptUnavailableError,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
