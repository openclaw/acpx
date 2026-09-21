import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/acp/terminal-manager.js";
import { PermissionPromptUnavailableError } from "../src/errors.js";

test(
  "revoked terminal authority prevents a shell fallback spawn",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-fallback-authority-"));
    const manager = new TerminalManager({ cwd, permissionMode: "approve-all" });
    const closed: Array<Promise<void>> = [];
    try {
      const marker = path.join(cwd, "fallback.txt");
      const script = "require('node:fs').writeFileSync(process.argv[1], 'fallback ran')";
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} ${JSON.stringify(marker)}`;
      const params = { sessionId: "synthetic", command };
      const control = await manager.createTerminal(params);
      assert.equal(
        (
          await manager.waitForTerminalExit({
            sessionId: "synthetic",
            terminalId: control.terminalId,
          })
        ).exitCode,
        0,
      );
      assert.equal(await fs.readFile(marker, "utf8"), "fallback ran");
      await manager.releaseTerminal({ sessionId: "synthetic", terminalId: control.terminalId });
      await fs.unlink(marker);

      const controller = new AbortController();
      const revoked = new Error("expired after failed direct launch");
      let attempts = 0;
      await withObservedSpawns(
        (child) => {
          attempts += 1;
          closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
          child.once("error", () => controller.abort(revoked));
        },
        async () => {
          await assert.rejects(
            manager.createTerminal(params, { signal: controller.signal }),
            (error) => error === revoked,
          );
        },
      );
      assert.equal(attempts, 1, "the revoked shell fallback must never be spawned");
      await assert.rejects(fs.access(marker), { code: "ENOENT" });
    } finally {
      await manager.shutdown();
      await Promise.all(closed);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "terminal creation owns and cleans up a process cancelled during spawn adoption",
  { timeout: 10_000 },
  async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-adoption-authority-"));
    const manager = new TerminalManager({ cwd, permissionMode: "approve-all", killGraceMs: 10 });
    let spawned: ChildProcess | undefined;
    let closed: Promise<void> | undefined;
    t.after(async () => {
      if (spawned && spawned.exitCode === null && spawned.signalCode === null) {
        spawned.kill("SIGKILL");
      }
      await closed;
      await manager.shutdown();
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const revoked = new Error("expired during spawn adoption");
    await withObservedSpawns(
      (child) => {
        spawned = child;
        closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.once("spawn", () => controller.abort(revoked));
      },
      async () => {
        await assert.rejects(
          manager.createTerminal(
            {
              sessionId: "synthetic",
              command: process.execPath,
              args: ["-e", "setInterval(() => {}, 1000)"],
            },
            { signal: controller.signal },
          ),
          (error) => error === revoked,
        );
      },
    );
    assert(spawned);
    assert(
      spawned.exitCode !== null || spawned.signalCode !== null,
      "creation must await process cleanup before rejecting",
    );
    await closed;
    assert.equal((manager as unknown as { terminals: Map<string, unknown> }).terminals.size, 0);
  },
);

async function withObservedSpawns(
  observe: (child: ChildProcess) => void,
  run: () => Promise<void>,
): Promise<void> {
  const original = childProcess.spawn;
  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = original(command, args, options);
    observe(child);
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

function getManagedStdio(
  manager: TerminalManager,
  terminalId: string,
): {
  stdout: NodeJS.EventEmitter;
  stderr: NodeJS.EventEmitter;
} {
  const terminals = (
    manager as unknown as {
      terminals: Map<
        string,
        {
          process: {
            stdout: NodeJS.EventEmitter;
            stderr: NodeJS.EventEmitter;
          };
        }
      >;
    }
  ).terminals;
  const terminal = terminals.get(terminalId);
  assert.ok(terminal, `expected managed terminal ${terminalId}`);
  return terminal.process;
}

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

function createManagerWithOutputCeiling(raw: string | undefined): TerminalManager {
  const previous = process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES;
  try {
    if (raw === undefined) {
      delete process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES;
    } else {
      process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES = raw;
    }
    return new TerminalManager({ cwd: os.tmpdir(), permissionMode: "approve-all" });
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES;
    } else {
      process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES = previous;
    }
  }
}

test("terminal manager rejects invalid host ceilings before launching commands", () => {
  for (const raw of ["-1", "1.5", "Infinity", "NaN", "1e3", "0x10", "9007199254740992"]) {
    assert.throws(() => createManagerWithOutputCeiling(raw), /ACPX_TERMINAL_MAX_OUTPUT_BYTES/);
  }
});

for (const scenario of [
  {
    name: "unset host ceiling preserves large requests",
    host: undefined,
    requested: Number.MAX_SAFE_INTEGER,
    bytes: 16 * 1024 * 1024 + 1,
    retained: 16 * 1024 * 1024 + 1,
  },
  {
    name: "zero host ceiling preserves requests",
    host: "0",
    requested: 100_000,
    bytes: 90_000,
    retained: 90_000,
  },
  {
    name: "empty host ceiling preserves requests",
    host: " ",
    requested: 100_000,
    bytes: 90_000,
    retained: 90_000,
  },
  {
    name: "host ceiling clamps huge requests",
    host: " 128 ",
    requested: Number.MAX_SAFE_INTEGER,
    bytes: 192,
    retained: 128,
  },
  { name: "agent zero stores nothing", host: "128", requested: 0, bytes: 32, retained: 0 },
  { name: "smaller agent limit wins", host: "128", requested: 64, bytes: 192, retained: 64 },
  {
    name: "omitted agent limit remains 64 KiB",
    host: "100000",
    requested: undefined,
    bytes: 70_000,
    retained: 64 * 1024,
  },
  {
    name: "smaller host ceiling clamps the default",
    host: "128",
    requested: undefined,
    bytes: 192,
    retained: 128,
  },
]) {
  test(`terminal manager ${scenario.name}`, async () => {
    // Restoring the environment before create also proves client-lifetime snapshotting.
    const manager = createManagerWithOutputCeiling(scenario.host);
    try {
      const { terminalId } = await manager.createTerminal({
        sessionId: "session-1",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        outputByteLimit: scenario.requested,
      });
      const stdio = getManagedStdio(manager, terminalId);
      stdio.stdout.emit("data", Buffer.alloc(scenario.bytes - 1, 0x61));
      stdio.stderr.emit("data", Buffer.from("z"));
      const output = await manager.terminalOutput({ sessionId: "session-1", terminalId });
      assert.equal(Buffer.byteLength(output.output), scenario.retained);
      assert.equal(output.truncated, scenario.bytes > scenario.retained);
      assert.equal(output.output, scenario.retained ? "a".repeat(scenario.retained - 1) + "z" : "");
    } finally {
      await manager.shutdown();
    }
  });
}

test("terminal host ceiling preserves the UTF-8 suffix across stdout and stderr", async () => {
  const manager = createManagerWithOutputCeiling("5");
  try {
    const { terminalId } = await manager.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      outputByteLimit: 1000,
    });
    const stdio = getManagedStdio(manager, terminalId);
    stdio.stdout.emit("data", Buffer.from("aé"));
    stdio.stderr.emit("data", Buffer.from("🙂"));
    const output = await manager.terminalOutput({ sessionId: "session-1", terminalId });
    assert.equal(output.output, "🙂");
    assert.equal(output.truncated, true);
  } finally {
    await manager.shutdown();
  }
});

const terminalUtf8Cases: Array<{
  name: string;
  limit: number;
  host?: string;
  chunks: Array<{ stream: "stdout" | "stderr"; bytes: Buffer }>;
  expected: string;
  truncated: boolean;
}> = [
  ...["é", "€", "🙂"].flatMap((text) =>
    Array.from({ length: Buffer.byteLength(text) - 1 }, (_, index) => ({
      name: `${text} with a ${index + 1}-byte limit`,
      limit: index + 1,
      chunks: [{ stream: "stdout" as const, bytes: Buffer.from(text) }],
      expected: "",
      truncated: true,
    })),
  ),
  {
    name: "an empty suffix when a final code point exceeds the limit",
    limit: 2,
    chunks: [{ stream: "stdout", bytes: Buffer.from("A🙂") }],
    expected: "",
    truncated: true,
  },
  {
    name: "fragmented continuation bytes after the prefix was discarded",
    limit: 2,
    chunks: [
      { stream: "stdout", bytes: Buffer.from([0xf0, 0x9f, 0x99]) },
      { stream: "stdout", bytes: Buffer.from([0x82]) },
    ],
    expected: "",
    truncated: true,
  },
  {
    name: "fragmented continuation bytes under the host ceiling",
    limit: 2,
    host: "2",
    chunks: [
      { stream: "stdout", bytes: Buffer.from([0xf0, 0x9f, 0x99]) },
      { stream: "stdout", bytes: Buffer.from([0x82]) },
    ],
    expected: "",
    truncated: true,
  },
  {
    name: "ASCII arriving after a discarded fragmented code point",
    limit: 2,
    chunks: [
      { stream: "stdout", bytes: Buffer.from([0xf0, 0x9f, 0x99]) },
      { stream: "stdout", bytes: Buffer.from([0x82]) },
      { stream: "stdout", bytes: Buffer.from("A") },
    ],
    expected: "A",
    truncated: true,
  },
  {
    name: "an exactly fitting fragmented code point without truncation",
    limit: 4,
    chunks: [
      { stream: "stdout", bytes: Buffer.from([0xf0, 0x9f, 0x99]) },
      { stream: "stdout", bytes: Buffer.from([0x82]) },
    ],
    expected: "🙂",
    truncated: false,
  },
  {
    name: "complete stdout and stderr code points below the limit",
    limit: 8,
    chunks: [
      { stream: "stdout", bytes: Buffer.from("a") },
      { stream: "stderr", bytes: Buffer.from("é") },
    ],
    expected: "aé",
    truncated: false,
  },
  {
    name: "the complete newest code point across stdout and stderr",
    limit: 4,
    chunks: [
      { stream: "stdout", bytes: Buffer.from("a") },
      { stream: "stderr", bytes: Buffer.from("🙂") },
    ],
    expected: "🙂",
    truncated: true,
  },
];

for (const scenario of terminalUtf8Cases) {
  test(`terminal output retains ${scenario.name}`, async () => {
    const manager = createManagerWithOutputCeiling(scenario.host);
    try {
      const { terminalId } = await manager.createTerminal({
        sessionId: "session-1",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        outputByteLimit: scenario.host === undefined ? scenario.limit : 1000,
      });
      const stdio = getManagedStdio(manager, terminalId);
      for (const chunk of scenario.chunks) {
        stdio[chunk.stream].emit("data", chunk.bytes);
      }
      const output = await manager.terminalOutput({ sessionId: "session-1", terminalId });
      assert.equal(output.output, scenario.expected);
      assert.ok(Buffer.byteLength(output.output, "utf8") <= scenario.limit);
      assert.doesNotMatch(output.output, /\uFFFD/u);
      assert.equal(output.truncated, scenario.truncated);
    } finally {
      await manager.shutdown();
    }
  });
}

test("terminal manager ignores child stdout and stderr pipe-death errors", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    const stdio = getManagedStdio(manager, created.terminalId);
    stdio.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    stdio.stderr.emit("error", Object.assign(new Error("input/output error"), { code: "EIO" }));

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

async function withHangingProcessListCommand<T>(run: () => Promise<T>): Promise<T> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-hanging-ps-"));
  const pidPath = path.join(bin, "ps.pids");
  const previousPath = process.env.PATH ?? "";
  await fs.writeFile(
    path.join(bin, "ps"),
    `#!/bin/sh\nprintf '%s\\n' "$$" >> ${JSON.stringify(pidPath)}\nexec sleep 3600\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previousPath;
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
    await fs.rm(bin, { recursive: true, force: true });
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

test("terminal manager wait_for_exit and release finish when process listing hangs", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process list hang assertion");
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      processHelperTimeoutMs: 200,
    });
    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "echo done",
    });

    await withHangingProcessListCommand(async () => {
      const waitResult = await rejectIfHung(
        manager.waitForTerminalExit({
          sessionId: "session-1",
          terminalId: created.terminalId,
        }),
        "terminal/wait_for_exit hung on process listing",
      );
      assert.equal(waitResult.exitCode, 0);

      await rejectIfHung(
        manager.releaseTerminal({
          sessionId: "session-1",
          terminalId: created.terminalId,
        }),
        "terminal/release hung on process listing",
      );
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager kill finishes when process listing hangs", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process list hang assertion");
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      killGraceMs: 200,
      processHelperTimeoutMs: 200,
    });
    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: "sleep 30",
    });

    await withHangingProcessListCommand(async () => {
      await rejectIfHung(
        manager.killTerminal({
          sessionId: "session-1",
          terminalId: created.terminalId,
        }),
        "terminal/kill hung on process listing",
      );

      const waitResult = await rejectIfHung(
        manager.waitForTerminalExit({
          sessionId: "session-1",
          terminalId: created.terminalId,
        }),
        "terminal/wait_for_exit hung after kill while process listing hangs",
      );
      assert.ok(waitResult.exitCode !== null || waitResult.signal !== null);
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test(
  "terminal shutdown drains every native terminal before reporting a release failure",
  { timeout: 10_000 },
  async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-shutdown-"));
    const manager = new TerminalManager({ cwd, permissionMode: "approve-all", killGraceMs: 10 });
    const children: ChildProcess[] = [];
    const closed: Promise<void>[] = [];
    let enterSecond = () => {};
    const secondEntered = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    let releaseSecond = () => {};
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const failure = new Error("synthetic first-terminal release failure");
    const release = manager.releaseTerminal.bind(manager);
    let running: Promise<unknown> | undefined;
    try {
      const ids: string[] = [];
      await withObservedSpawns(
        (child) => {
          children.push(child);
          closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
        },
        async () => {
          for (let i = 0; i < 2; i += 1) {
            ids.push(
              (
                await manager.createTerminal({
                  sessionId: "synthetic",
                  command: process.execPath,
                  args: ["-e", "setInterval(() => {}, 1000)"],
                })
              ).terminalId,
            );
          }
        },
      );
      t.mock.method(
        manager,
        "releaseTerminal",
        async (params: Parameters<TerminalManager["releaseTerminal"]>[0]) => {
          const result = await release(params);
          if (params.terminalId === ids[0]) {
            throw failure;
          }
          enterSecond();
          await secondReleased;
          return result;
        },
      );
      let settled = false;
      running = manager.shutdown().then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await Promise.race([
        secondEntered,
        running.then(() => {
          throw new Error("shutdown stopped before releasing the second terminal");
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "shutdown must join the held terminal release");
      releaseSecond();
      const error = await running;
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      await Promise.all(closed);
      assert.equal(children.length, 2);
      for (const child of children) {
        assert.ok(child.exitCode !== null || child.signalCode !== null);
      }
    } finally {
      releaseSecond();
      t.mock.restoreAll();
      await running;
      await manager.shutdown();
      await Promise.all(closed);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);
