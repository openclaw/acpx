import assert from "node:assert/strict";
import childProcess, {
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { withTimeout } from "../src/async-control.js";
import {
  closeSession,
  sessionControlTestInternals,
} from "../src/session/execution/session-control.js";
import { splitWindowsProcessCommandLine } from "../src/session/execution/windows-process-command.js";
import { buildAgentSpawnCommand, type AgentSpawnCommand } from "../src/spawn-command-options.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

test("Windows process observations preserve executable and argument backslashes", () => {
  assert.deepEqual(
    splitWindowsProcessCommandLine(
      '"C:\\Program Files\\agent.exe" --pipe \\\\.\\pipe\\agent "C:\\with spaces\\\\" "" a^b',
    ),
    [
      "C:\\Program Files\\agent.exe",
      "--pipe",
      "\\\\.\\pipe\\agent",
      "C:\\with spaces\\",
      "",
      "a^b",
    ],
  );
  assert.deepEqual(splitWindowsProcessCommandLine('C:\\agent.exe "a\\"b" "a\\\\\\"b" "a""b"'), [
    "C:\\agent.exe",
    'a"b',
    'a\\"b',
    'a"b',
  ]);
});

test("the canonical saved argv takes precedence over display identity parsing", () => {
  const argv = ["C:\\Program Files\\agent.exe", "--acp"];
  assert.equal(
    sessionControlTestInternals.firstAgentCommandToken("different-agent", argv),
    argv[0],
  );
  assert.equal(sessionControlTestInternals.firstAgentCommandToken("agent", []), undefined);
  assert.equal(
    sessionControlTestInternals.firstAgentCommandToken('"/Applications/My Agent.app/agent" --acp'),
    "/Applications/My Agent.app/agent",
  );
});

test("Windows command delimiters preserve nonbreaking spaces inside tokens", () => {
  assert.deepEqual(
    splitWindowsProcessCommandLine("C:\\other.exe \u00a0agent.exe agent.exe\u00a0"),
    ["C:\\other.exe", "\u00a0agent.exe", "agent.exe\u00a0"],
  );
});

for (const command of [
  "C:\\Program Files\\agent.cmd",
  "C:\\tools & helpers\\agent.bat",
  "C:\\repo\\node_modules\\.bin\\agent.cmd",
]) {
  test("Windows process observations decode the batch launch producer for " + command, () => {
    const launch = buildAgentSpawnCommand(
      command,
      ["with spaces", "a&b", "C:\\trailing\\"],
      "win32",
      { COMSPEC: "cmd.exe" },
    );
    assert.equal(launch.windowsVerbatimArguments, true);
    assert.deepEqual(splitWindowsProcessCommandLine([launch.command, ...launch.args].join(" ")), [
      "cmd.exe",
      command,
    ]);
  });
}

test("missing and incomplete Windows observations cannot supply matching argv", () => {
  for (const value of [undefined, "", '"C:\\incomplete path', 'agent.exe "incomplete']) {
    assert.deepEqual(sessionControlTestInternals.splitCommandLineLike(value, "win32"), []);
  }
  for (const line of [
    'cmd.exe /c "C:\\agent.cmd"',
    'cmd.exe /d /s /c "C:\\agent.cmd^"',
    'cmd.exe /d /s /c "C:\\agent.exe"',
  ]) {
    assert.deepEqual(splitWindowsProcessCommandLine(line), ["cmd.exe"]);
  }
  assert.deepEqual(
    sessionControlTestInternals.splitCommandLineLike(
      '"/Applications/My Agent.app/agent" --profile "with spaces"',
      "darwin",
    ),
    ["/Applications/My Agent.app/agent", "--profile", "with spaces"],
  );
});

async function withOwnedProcess(
  launch: AgentSpawnCommand,
  run: (child: ChildProcess, closed: Promise<void>) => Promise<void>,
): Promise<void> {
  const child = childProcess.spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const spawned = once(child, "spawn");
  const ready = once(child.stdout, "data");
  child.stderr?.resume();
  try {
    await withTimeout(Promise.all([spawned, ready]), 5_000);
    assert(child.pid);
    await run(child, closed);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      assert(child.kill("SIGTERM"), "owned fixture cleanup must be dispatched");
    }
    await withTimeout(closed, 5_000);
  }
}

async function saveProcess(home: string, pid: number, argv: string[]): Promise<string> {
  const sessionId = "observed-process";
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      ...normalizeAgentCommandInput(argv),
      cwd: home,
      pid,
    }),
  );
  return sessionId;
}

const keeperArgs = ["-e", "process.stdout.write('ready\\n');process.stdin.resume()"];

test("closeSession leaves a nonmatching owned process alive", async () => {
  await withTempHome("acpx-close-mismatch-", async (home) => {
    await withOwnedProcess({ command: process.execPath, args: keeperArgs }, async (child) => {
      const sessionId = await saveProcess(home, child.pid!, [
        path.join(home, "different-agent.exe"),
      ]);
      const closed = await closeSession(sessionId);
      assert.equal(closed.closed, true);
      assert.equal(closed.pid, undefined);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
    });
  });
});

for (const argument of ["\u00a0agent.exe", "agent.exe\u00a0"]) {
  test(
    "closeSession preserves a nonmatching Windows argument " + JSON.stringify(argument),
    { skip: process.platform !== "win32" },
    async () => {
      await withTempHome("acpx-close-whitespace-", async (home) => {
        await withOwnedProcess(
          { command: process.execPath, args: [...keeperArgs, argument] },
          async (child) => {
            const sessionId = await saveProcess(home, child.pid!, [path.join(home, "agent.exe")]);
            assert.equal((await closeSession(sessionId)).closed, true);
            assert.equal(child.exitCode, null);
            assert.equal(child.signalCode, null);
            assert.doesNotThrow(() => process.kill(child.pid!, 0));
          },
        );
      });
    },
  );
}

for (const extension of ["cmd", "bat"]) {
  test(
    "closeSession terminates the actual Windows ." + extension + " launch wrapper",
    { skip: process.platform !== "win32" },
    async () => {
      await withTempHome("acpx-close-batch-", async (home) => {
        const command = path.join(home, "agent with spaces." + extension);
        // Both commands are cmd builtins: no unowned descendant survives the wrapper.
        await fs.writeFile(command, "@echo ready\r\n@set /p fixture_input=\r\n");
        const launch = buildAgentSpawnCommand(command, [], "win32");
        await withOwnedProcess(launch, async (child, closed) => {
          const sessionId = await saveProcess(home, child.pid!, [command]);
          const record = await closeSession(sessionId);
          assert.equal(record.closed, true);
          assert.equal(record.pid, undefined);
          await withTimeout(closed, 3_000);
        });
      });
    },
  );
}

for (const outcome of ["missing", "denied"]) {
  test(
    "closeSession does not signal after a " + outcome + " Windows process query",
    { skip: process.platform !== "win32" },
    async (t) => {
      await withTempHome("acpx-close-query-", async (home) => {
        await withOwnedProcess({ command: process.execPath, args: keeperArgs }, async (child) => {
          const sessionId = await saveProcess(home, child.pid!, [process.execPath, ...keeperArgs]);
          const execFile = childProcess.execFile;
          const helpers: Promise<void>[] = [];
          const stub = t.mock.method(childProcess, "execFile", ((
            command: string,
            args: readonly string[],
            options: ExecFileOptionsWithStringEncoding,
            callback: (error: Error | null, stdout: string, stderr: string) => void,
          ) => {
            if (
              command !== "powershell.exe" ||
              !args.some((arg) => arg.includes("ProcessId = " + child.pid))
            ) {
              return execFile(command, [...args], options, callback);
            }
            const helper = execFile(
              process.execPath,
              ["-e", outcome === "denied" ? "process.exit(7)" : ""],
              options,
              callback,
            );
            helpers.push(new Promise<void>((resolve) => helper.once("close", () => resolve())));
            return helper;
          }) as typeof childProcess.execFile);
          syncBuiltinESMExports();
          try {
            const record = await closeSession(sessionId);
            assert.equal(record.closed, true);
            assert.equal(helpers.length, 1);
            assert.equal(child.exitCode, null);
            assert.equal(child.signalCode, null);
            assert.doesNotThrow(() => process.kill(child.pid!, 0));
          } finally {
            stub.mock.restore();
            syncBuiltinESMExports();
            await withTimeout(Promise.all(helpers), 5_000);
          }
        });
      });
    },
  );
}
