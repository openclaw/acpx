import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveClaudeCodeExecutable } from "../src/acp/agent-command.js";
import {
  PROCESS_HELPER_MAX_BUFFER_BYTES,
  resolveAgentSessionCwd,
  runTimedExecFile,
} from "../src/acp/client-process.js";
import { buildAgentSpawnOptions, buildSpawnCommandOptions } from "../src/acp/client.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";
import { withTimeout } from "../src/async-control.js";
import { observeProcessIncarnation, parseProcessBirthIdentity } from "../src/process-identity.js";
import {
  buildAgentSpawnCommand,
  buildTerminalShellSpawnCommand,
  buildTerminalSpawnCommand,
  resolveWindowsExecutablePath,
} from "../src/spawn-command-options.js";
import type { ReadyRecord } from "./fixtures/flow-shell-retirement.js";

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

test("buildAgentSpawnOptions merges session env into the agent child environment", () => {
  const previous = process.env.ACPX_TEST_SESSION_ENV_PARENT;
  process.env.ACPX_TEST_SESSION_ENV_PARENT = "parent-value";
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      ACPX_TEST_SESSION_ENV_INJECTED: "injected-value",
      ACPX_TEST_SESSION_ENV_PARENT: "overridden-by-session",
    });

    assert.equal(options.env.ACPX_TEST_SESSION_ENV_INJECTED, "injected-value");
    assert.equal(
      options.env.ACPX_TEST_SESSION_ENV_PARENT,
      "overridden-by-session",
      "session env must override the parent process env for colliding keys",
    );
  } finally {
    if (previous == null) {
      delete process.env.ACPX_TEST_SESSION_ENV_PARENT;
    } else {
      process.env.ACPX_TEST_SESSION_ENV_PARENT = previous;
    }
  }
});

test("buildAgentSpawnOptions leaves the agent env untouched when no session env is configured", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, undefined);
  assert.equal(options.env.ACPX_TEST_SESSION_ENV_INJECTED, undefined);
});

test("runtime environment overrides session values without changing protected credentials or parent", () => {
  const options = buildAgentSpawnOptions(
    os.tmpdir(),
    { "runtime-token": "synthetic-credential" },
    { ACPX_TEST_RUNTIME_OVERLAY: "session", RUNTIME_TOKEN: "session-credential" },
    {
      ACPX_TEST_RUNTIME_OVERLAY: "runtime",
      RUNTIME_TOKEN: "runtime-credential",
      ACPX_AUTH_RUNTIME_TOKEN: "runtime-prefixed",
    },
  );
  assert.equal(options.env.ACPX_TEST_RUNTIME_OVERLAY, "runtime");
  assert.equal(options.env.RUNTIME_TOKEN, "synthetic-credential");
  assert.equal(options.env.ACPX_AUTH_RUNTIME_TOKEN, "synthetic-credential");
  assert.equal(process.env.ACPX_TEST_RUNTIME_OVERLAY, undefined);
});

test("runtime environment uses Windows case collision and credential protection rules", () => {
  withPlatform("win32", () => {
    const options = buildAgentSpawnOptions(
      os.tmpdir(),
      { "runtime-token": "synthetic-credential" },
      { ACPX_TEST_RUNTIME_OVERLAY: "session" },
      { acpx_test_runtime_overlay: "runtime", runtime_token: "override" },
    );
    assert.equal(options.env.ACPX_TEST_RUNTIME_OVERLAY, undefined);
    assert.equal(options.env.acpx_test_runtime_overlay, "runtime");
    assert.equal(options.env.RUNTIME_TOKEN, "synthetic-credential");
    assert.equal(options.env.runtime_token, undefined);
  });
});

test("invalid runtime environment fails without echoing the supplied value", () => {
  assert.throws(
    () =>
      buildAgentSpawnOptions(os.tmpdir(), undefined, undefined, {
        VALID_NAME: "private-marker\u0000",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid agentProcessEnv/);
      assert.equal(error.message.includes("private-marker"), false);
      return true;
    },
  );
});

test("spawned agent child process receives session env with parent-override precedence", async () => {
  const script =
    "process.stdout.write(JSON.stringify({injected:process.env.ACPX_TEST_E2E_INJECTED,parent:process.env.ACPX_TEST_E2E_PARENT}))";
  const options = buildAgentSpawnOptions(os.tmpdir(), undefined, {
    ACPX_TEST_E2E_INJECTED: "e2e-injected",
    ACPX_TEST_E2E_PARENT: "e2e-overridden",
  });

  const result = await new Promise<{ injected?: string; parent?: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`failed to parse child stdout: ${stdout} (${stderr})`));
      }
    });
  });

  assert.equal(
    result.injected,
    "e2e-injected",
    "real child process must receive the injected session env var",
  );
  assert.equal(
    result.parent,
    "e2e-overridden",
    "real child process must see session env override the parent value",
  );
});

test("buildAgentSpawnOptions hides Windows console windows and preserves auth env", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", {
    ACPX_AUTH_TOKEN: "secret-token",
  });

  assert.equal(options.cwd, "/tmp/acpx-agent");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_AUTH_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions prevents session env from overriding injected auth env", () => {
  const options = buildAgentSpawnOptions(
    "/tmp/acpx-agent",
    {
      "api-token": "secret-token",
    },
    {
      ACPX_AUTH_API_TOKEN: "session-prefixed",
      API_TOKEN: "session-normalized",
    },
  );

  assert.equal(options.env.ACPX_AUTH_API_TOKEN, "secret-token");
  assert.equal(options.env.API_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions protects auth env case-insensitively on Windows", () => {
  return withPlatform("win32", () => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      {
        "case-token": "secret-token",
      },
      {
        acpx_auth_case_token: "session-prefixed",
        case_token: "session-normalized",
      },
    );

    assert.equal(options.env.ACPX_AUTH_CASE_TOKEN, "secret-token");
    assert.equal(options.env.CASE_TOKEN, "secret-token");
    assert.equal(options.env.acpx_auth_case_token, undefined);
    assert.equal(options.env.case_token, undefined);
  });
});

test("buildAgentSpawnOptions protects inherited auth env case-insensitively on Windows", () => {
  return withPlatform("win32", () => {
    const previous = process.env.acpx_auth_inherited_token;
    process.env.acpx_auth_inherited_token = "inherited-secret";
    try {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        ACPX_AUTH_INHERITED_TOKEN: "session-prefixed",
        INHERITED_TOKEN: "session-normalized",
      });

      assert.equal(options.env.acpx_auth_inherited_token, "inherited-secret");
      assert.equal(options.env.INHERITED_TOKEN, "inherited-secret");
      assert.equal(options.env.ACPX_AUTH_INHERITED_TOKEN, undefined);
    } finally {
      if (previous == null) {
        delete process.env.acpx_auth_inherited_token;
      } else {
        process.env.acpx_auth_inherited_token = previous;
      }
    }
  });
});

test("buildAgentSpawnOptions replaces inherited env case collisions on Windows", () => {
  return withPlatform("win32", () => {
    const previous = process.env.ACPX_TEST_SESSION_ENV_CASE;
    process.env.ACPX_TEST_SESSION_ENV_CASE = "inherited";
    try {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpx_test_session_env_case: "session",
      });

      assert.equal(options.env.ACPX_TEST_SESSION_ENV_CASE, undefined);
      assert.equal(options.env.acpx_test_session_env_case, "session");
    } finally {
      if (previous == null) {
        delete process.env.ACPX_TEST_SESSION_ENV_CASE;
      } else {
        process.env.ACPX_TEST_SESSION_ENV_CASE = previous;
      }
    }
  });
});

test("buildAgentSpawnOptions promotes explicit ACPX auth env vars into agent auth env", () => {
  const previousPrefixed = process.env.ACPX_AUTH_OPENAI_API_KEY;
  const previousNormalized = process.env.OPENAI_API_KEY;

  process.env.ACPX_AUTH_OPENAI_API_KEY = "sk-explicit";
  delete process.env.OPENAI_API_KEY;

  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined);
    assert.equal(options.env.ACPX_AUTH_OPENAI_API_KEY, "sk-explicit");
    assert.equal(options.env.OPENAI_API_KEY, "sk-explicit");
  } finally {
    if (previousPrefixed == null) {
      delete process.env.ACPX_AUTH_OPENAI_API_KEY;
    } else {
      process.env.ACPX_AUTH_OPENAI_API_KEY = previousPrefixed;
    }

    if (previousNormalized == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousNormalized;
    }
  }
});

test("buildTerminalSpawnOptions hides Windows console windows and maps env entries", () => {
  const options = buildTerminalSpawnOptions("node", "/tmp/acpx-terminal", [
    { name: "TMUX", value: "/tmp/tmux-1000/default,123,0" },
    { name: "TERM", value: "screen-256color" },
  ]);

  assert.equal(options.cwd, "/tmp/acpx-terminal");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env?.TMUX, "/tmp/tmux-1000/default,123,0");
  assert.equal(options.env?.TERM, "screen-256color");
});

test("buildSpawnCommandOptions enables shell for .cmd/.bat on Windows", () => {
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  const cmdOptions = buildSpawnCommandOptions("C:\\Program Files\\nodejs\\npx.cmd", base, "win32");
  const batOptions = buildSpawnCommandOptions("C:\\tools\\agent.bat", base, "win32");

  assert.equal(cmdOptions.shell, true);
  assert.equal(batOptions.shell, true);
  assert.deepEqual(cmdOptions.stdio, base.stdio);
  assert.equal(cmdOptions.windowsHide, true);
});

test("buildAgentSpawnCommand preserves argv boundaries through cmd.exe", () => {
  const command = buildAgentSpawnCommand(
    "C:\\Program Files\\agent.cmd",
    ["with spaces", "a&b", "C:\\trailing\\"],
    "win32",
    { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
  );

  assert.deepEqual(command, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '"C:\\Program^ Files\\agent.cmd ^"with^ spaces^" ^"a^&b^" ^"C:\\trailing\\\\^""',
    ],
    windowsVerbatimArguments: true,
  });
});

test("buildAgentSpawnCommand normalizes forward-slash batch paths for cmd.exe", () => {
  const command = buildAgentSpawnCommand(
    "C:/tools/agent.cmd",
    ["--profile", "with spaces"],
    "win32",
    {},
  );

  assert.deepEqual(command, {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\tools\\agent.cmd ^"--profile^" ^"with^ spaces^""'],
    windowsVerbatimArguments: true,
  });
});

test("buildSpawnCommandOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildSpawnCommandOptions("npx", base, "win32", env);
    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, base.stdio);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSpawnCommandOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const linuxOptions = buildSpawnCommandOptions("/usr/bin/npx", base, "linux");
    const windowsExeOptions = buildSpawnCommandOptions("node", base, "win32", env);

    assert.equal(linuxOptions.shell, undefined);
    assert.equal(windowsExeOptions.shell, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnCommand preserves explicit argv", () => {
  assert.deepEqual(buildTerminalSpawnCommand("node", ["-e", "console.log('ok')"]), {
    command: "node",
    args: ["-e", "console.log('ok')"],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", []), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", undefined), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
});

test("buildTerminalShellSpawnCommand routes command lines through the shell", () => {
  assert.deepEqual(buildTerminalShellSpawnCommand("echo hello | tr a-z A-Z", "darwin"), {
    command: "/bin/sh",
    args: ["-c", "echo hello | tr a-z A-Z"],
    killProcessGroup: true,
  });
  assert.deepEqual(buildTerminalShellSpawnCommand("dir C:\\Users", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "dir C:\\Users"],
    killProcessGroup: true,
  });
});

test("resolveAgentSessionCwd translates WSL cwd for Windows exe agents", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Users/User/AppData/Local/GitHub CLI/copilot/copilot.exe" --acp --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd leaves non-WSL and non-Windows agents on resolved cwd", async () => {
  const nonWsl = await resolveAgentSessionCwd("relative/project", "/mnt/c/tools/copilot.exe", {
    platform: "linux",
    existsSync: () => false,
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });
  const inputCwd = "/home/user/project";
  const wslNodeAgent = await resolveAgentSessionCwd(inputCwd, "node ./agent.js", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });

  assert.equal(nonWsl, path.resolve("relative/project"));
  assert.equal(wslNodeAgent, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd translates WSL cwd for Windows .cmd wrappers", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Program Files/nodejs/npx.cmd" some-acp-agent --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd translates WSL cwd for Windows agents on non-C drives", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/d/tools/agent.bat --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async (value) => {
      capturedCwd = value;
      return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
    },
  });

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd does not translate WSL cwd for extension-less commands under /mnt/<drive>/", async () => {
  const inputCwd = "/home/user/project";
  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/c/tools/linux-agent --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run for extension-less /mnt/<drive>/ commands");
    },
  });

  assert.equal(cwd, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd rejects empty wslpath output", async () => {
  await assert.rejects(
    resolveAgentSessionCwd("/home/user/project", "/mnt/c/tools/copilot.exe --acp", {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async () => "\n",
    }),
    /wslpath returned an empty Windows path/,
  );
});

test("runTimedExecFile returns helper stdout", async () => {
  const stdout = await runTimedExecFile(process.execPath, [
    "-e",
    "process.stdout.write('helper-ok')",
  ]);
  assert.equal(stdout, "helper-ok");
});

test("runTimedExecFile keeps stdout beyond execFile default maxBuffer", async () => {
  const size = 1024 * 1024 + 64 * 1024;
  const stdout = await runTimedExecFile(process.execPath, [
    "-e",
    `process.stdout.write("x".repeat(${size}))`,
  ]);
  assert.equal(stdout.length, size);
});

test("runTimedExecFile kills a ready helper while its descendant retains the pipes", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-timed-exec-"));
  const nonce = randomUUID();
  const fixture = fileURLToPath(new URL("./fixtures/flow-shell-retirement.js", import.meta.url));
  const args = [fixture, tmp, nonce, "wrapper", "standalone"];
  const options: childProcess.ExecFileOptionsWithStringEncoding = {
    encoding: "utf8",
    maxBuffer: PROCESS_HELPER_MAX_BUFFER_BYTES,
    killSignal: "SIGKILL",
    windowsHide: undefined,
    env: undefined,
  };
  type Callback = (
    error: childProcess.ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void;
  const nativeExecFile = childProcess.execFile;
  let forward: Callback | undefined;
  let callbackCalls = 0;
  let forwardedCalls = 0;
  let callbackDone!: () => void;
  const done = new Promise<void>((resolve) => {
    callbackDone = resolve;
  });
  const child = nativeExecFile(process.execPath, args, options, (error, stdout, stderr) => {
    callbackCalls += 1;
    if (forward) {
      forwardedCalls += 1;
      forward(error, stdout, stderr);
    }
    callbackDone();
  });
  const observed = {
    exit: false,
    signal: null as NodeJS.Signals | null,
    close: false,
    stdoutClose: false,
    stderrClose: false,
  };
  child.once("exit", (_code, signal) => {
    observed.exit = true;
    observed.signal = signal;
  });
  child.once("close", () => {
    observed.close = true;
  });
  child.stdout!.once("close", () => {
    observed.stdoutClose = true;
  });
  child.stderr!.once("close", () => {
    observed.stderrClose = true;
  });
  const until = async (label: string, timeoutMs: number, check: () => Promise<boolean>) => {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
      assert.ok(performance.now() < deadline, `${label}: ${JSON.stringify(observed)}`);
      await delay(20);
    }
  };
  const ready = async (role: string): Promise<ReadyRecord | undefined> => {
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(tmp, `${role}.ready.json`), "utf8"),
      ) as ReadyRecord;
      assert.equal(value.nonce, nonce);
      assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1);
      assert.ok(parseProcessBirthIdentity(value.birth));
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  let descendant: ReadyRecord | undefined;
  const failures: unknown[] = [];
  try {
    await until("helper and descendant readiness", 8_000, async () => {
      assert.equal(callbackCalls, 0, "helper exited during fixture setup");
      assert.equal(observed.exit, false);
      const wrapper = await ready("wrapper");
      descendant = await ready("descendant");
      if (!wrapper || !descendant) {
        return false;
      }
      assert.equal(wrapper.pid, child.pid);
      assert.equal(await observeProcessIncarnation(wrapper.pid, wrapper.birth, 1_000), "matching");
      assert.equal(
        await observeProcessIncarnation(descendant.pid, descendant.birth, 1_000),
        "matching",
      );
      return true;
    });
    // Admit the real, ready child; preserve its native callback after restoring
    // the dependency. The production deadline still uses an actual 200 ms timer.
    const handoff = t.mock.method(childProcess, "execFile", ((
      command,
      actualArgs,
      actualOptions,
      callback: Callback,
    ) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(actualArgs, args);
      assert.deepEqual(actualOptions, options);
      assert.equal(callbackCalls, 0);
      assert.equal(forward, undefined);
      forward = callback;
      return child;
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    let timed: Promise<string>;
    try {
      timed = runTimedExecFile(process.execPath, args, { timeoutMs: 200 });
    } finally {
      handoff.mock.restore();
      syncBuiltinESMExports();
    }
    await assert.rejects(withTimeout(timed, 2_000), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as NodeJS.ErrnoException).code, "ETIMEDOUT");
      assert.ok("killed" in error && error.killed === true);
      assert.ok("signal" in error && error.signal === "SIGKILL");
      assert.match(error.message, /timed out after 200ms/);
      return true;
    });
    await until(
      "native helper and stream closure",
      2_000,
      async () => observed.exit && observed.close && observed.stdoutClose && observed.stderrClose,
    );
    await withTimeout(done, 2_000);
    assert.equal(observed.signal, "SIGKILL");
    assert.equal(child.stdout!.destroyed, true);
    assert.equal(child.stderr!.destroyed, true);
    assert.equal(callbackCalls, 1);
    assert.equal(forwardedCalls, 1);
    assert.ok(descendant);
    assert.equal(
      await observeProcessIncarnation(descendant.pid, descendant.birth, 1_000),
      "matching",
    );
    await fs.writeFile(path.join(tmp, "ping"), nonce);
    await until(
      "live descendant pong",
      2_000,
      async () => (await fs.readFile(path.join(tmp, "pong"), "utf8").catch(() => "")) === nonce,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await fs.writeFile(path.join(tmp, "stop"), nonce);
      await until("cooperative fixture cleanup", 8_000, async () => {
        descendant ??= await ready("descendant");
        if (!observed.close || !observed.exit) {
          return false;
        }
        if (!descendant) {
          return true;
        }
        const state = await observeProcessIncarnation(descendant.pid, descendant.birth, 1_000);
        if (state === "gone") {
          return true;
        }
        if (state !== "matching" || process.platform === "win32") {
          return false;
        }
        return await new Promise<boolean>((resolve) => {
          nativeExecFile(
            "ps",
            ["-p", String(descendant!.pid), "-o", "stat="],
            { encoding: "utf8", timeout: 1_000 },
            (error, stdout) => {
              resolve(error?.code === 1 || (!error && stdout.trim().startsWith("Z")));
            },
          );
        });
      });
      for (const role of ["wrapper", "descendant"]) {
        await assert.rejects(fs.access(path.join(tmp, `${role}.emergency`)), { code: "ENOENT" });
      }
      await fs.rm(tmp, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      t.diagnostic(`Retained timed-helper fixture for cleanup: ${tmp}`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Timed helper proof or cleanup failed");
  }
});

test("buildTerminalSpawnOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildTerminalSpawnOptions(
      "npx",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const options = buildTerminalSpawnOptions(
      "node",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable finds claude.exe on PATH on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = { PATH: tempDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, path.join(tempDir, "claude.exe"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable ignores a Windows command shim without a native executable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-shim-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.cmd"), '@echo off\r\nnode "%~dp0cli.js" %*\r\n');
    const env = {
      PATH: tempDir,
      PATHEXT: ".CMD;.EXE;.BAT;.PS1",
    } as NodeJS.ProcessEnv;

    assert.equal(resolveClaudeCodeExecutable("win32", env), undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable prefers a native sibling when PATH ordering finds a shim first", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-shim-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.cmd"), "@echo off\r\n");
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".CMD;.EXE;.BAT;.PS1",
    } as NodeJS.ProcessEnv;

    assert.equal(resolveClaudeCodeExecutable("win32", env), path.join(tempDir, "claude.exe"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveWindowsExecutablePath follows a wrapper to a native entrypoint", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-shim-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    const executable = path.join(binDir, "claude.exe");
    await fs.writeFile(executable, "");
    await fs.writeFile(
      path.join(tempDir, "claude.cmd"),
      `@echo off\r\n"%~dp0bin\\claude.exe" %*\r\n`,
    );
    const env = {
      PATH: tempDir,
      PATHEXT: ".CMD;.EXE;.BAT;.PS1",
    } as NodeJS.ProcessEnv;

    assert.equal(resolveWindowsExecutablePath("claude", env), executable);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined when CLAUDE_CODE_EXECUTABLE is already set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable respects case-insensitive env var on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      claude_code_executable: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined on non-Windows platforms", () => {
  const result = resolveClaudeCodeExecutable("linux", { PATH: "/usr/bin" });
  assert.equal(result, undefined);
});

test("resolveClaudeCodeExecutable returns undefined when claude is not on PATH", () => {
  const env = { PATH: "/nonexistent", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
  const result = resolveClaudeCodeExecutable("win32", env);
  assert.equal(result, undefined);
});
