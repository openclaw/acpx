import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractAgentMessageChunkText,
  extractJsonRpcId,
  parseJsonRpcOutputLines,
} from "./jsonrpc-test-helpers.js";
import { queuePaths } from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

test("integration: exec echo baseline", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: timeout emits structured TIMEOUT json error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--timeout", "0.05", "exec", "sleep 500"],
        homeDir,
      );
      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              jsonrpc?: string;
              error?: { code?: number; data?: { acpxCode?: string } };
            },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const timeoutError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && payload.error?.data?.acpxCode === "TIMEOUT",
      );
      assert(timeoutError, `expected timeout error payload in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: gemini ACP startup timeout is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini");
    const previousTimeout = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;

    try {
      await fs.writeFile(fakeGeminiPath, "#!/bin/sh\nsleep 60\n", {
        encoding: "utf8",
        mode: 0o755,
      });
      process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS = "100";

      const result = await runCli(
        [
          "--agent",
          `${JSON.stringify(fakeGeminiPath)} --experimental-acp`,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "say exactly: hi",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const timeoutError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "GEMINI_ACP_STARTUP_TIMEOUT",
      );
      assert(timeoutError, result.stdout);
      assert.equal(timeoutError.error?.data?.acpxCode, "TIMEOUT");
      assert.equal(timeoutError.error?.data?.detailCode, "GEMINI_ACP_STARTUP_TIMEOUT");
      assert.match(timeoutError.error?.message ?? "", /Gemini CLI ACP startup timed out/i);
      assert.match(timeoutError.error?.message ?? "", /API-key-based auth/i);
    } finally {
      if (previousTimeout == null) {
        delete process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
      } else {
        process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: copilot ACP unsupported binary is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-copilot-"));
    const fakeCopilotPath = path.join(fakeBinDir, "copilot");

    try {
      await fs.writeFile(
        fakeCopilotPath,
        '#!/bin/sh\nif [ "$1" = "--help" ]; then\n  echo \'Usage: copilot [options]\'\n  exit 0\nfi\necho "error: unknown option \'$1\'" 1>&2\nexit 0\n',
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        [
          "--agent",
          `${JSON.stringify(fakeCopilotPath)} --acp --stdio`,
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
          "--name",
          "copilot-timeout",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 1, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const unsupportedError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "COPILOT_ACP_UNSUPPORTED",
      );
      assert(unsupportedError, result.stdout);
      assert.equal(unsupportedError.error?.data?.acpxCode, "RUNTIME");
      assert.equal(unsupportedError.error?.data?.detailCode, "COPILOT_ACP_UNSUPPORTED");
      assert.match(
        unsupportedError.error?.message ?? "",
        /Copilot CLI release that supports --acp --stdio/i,
      );
      assert.match(unsupportedError.error?.message ?? "", /Upgrade GitHub Copilot CLI/i);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: claude ACP session creation timeout is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-claude-acp-"));
    const fakeClaudeAcpPath = path.join(fakeBinDir, "claude-agent-acp");
    const previousTimeout = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;

    try {
      await fs.writeFile(
        fakeClaudeAcpPath,
        `#!/bin/sh\nexec node ${JSON.stringify(MOCK_AGENT_PATH)} --hang-on-new-session "$@"\n`,
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );
      process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = "100";

      const result = await runCli(
        [
          "--agent",
          JSON.stringify(fakeClaudeAcpPath),
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
          "--name",
          "claude-timeout",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const timeoutError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
      );
      assert(timeoutError, result.stdout);
      assert.equal(timeoutError.error?.data?.acpxCode, "TIMEOUT");
      assert.equal(timeoutError.error?.data?.detailCode, "CLAUDE_ACP_SESSION_CREATE_TIMEOUT");
      assert.match(timeoutError.error?.message ?? "", /Claude ACP session creation timed out/i);
      assert.match(timeoutError.error?.message ?? "", /nonInteractivePermissions=deny/i);
      assert.match(timeoutError.error?.message ?? "", /acpx claude exec/i);
    } finally {
      if (previousTimeout == null) {
        delete process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
      } else {
        process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: non-interactive fail emits structured permission error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } });
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(permissionError, `expected ACP error response in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict suppresses runtime stderr diagnostics", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--json-strict",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5);
      assert.equal(result.stderr.trim(), "");

      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } });
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(permissionError, `expected ACP error response in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict exec success emits JSON-RPC lines only", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--json-strict", "exec", "echo strict-success"],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr.trim(), "");
      const payloads = parseJsonRpcOutputLines(result.stdout);
      assert(
        payloads.some((payload) => Object.hasOwn(payload, "result")),
        "expected at least one JSON-RPC result payload",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli([...baseExecArgs(cwd), `read ${readPath}`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /mock read content/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/write_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "acpx-test-write.txt");

    try {
      const result = await runCli([...baseExecArgs(cwd), `write ${writePath} hello`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      const content = await fs.readFile(writePath, "utf8");
      assert.equal(content, "hello");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file outside cwd is denied", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli([...baseExecArgs("/tmp"), "read /etc/hostname"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.toLowerCase(), /error:/);
  });
});

test("integration: terminal lifecycle create/output/wait/release", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "terminal echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
      assert.match(result.stdout, /exit: 0/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: terminal kill leaves no orphan sleep process", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const before = await listSleep60Pids();

    try {
      const result = await runCli([...baseExecArgs(cwd), "kill-terminal sleep 60"], homeDir, {
        timeoutMs: 25_000,
      });
      assert.equal(result.code, 0, result.stderr);
      await assertNoNewSleep60Processes(before);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt reuses warm queue owner pid across turns", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdEvent.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const first = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo first"],
        homeDir,
      );
      assert.equal(first.code, 0, first.stderr);
      assert.ok(first.stdout.trim().length > 0, "first quiet prompt output should not be empty");

      const { lockPath } = queuePaths(homeDir, sessionId as string);
      const lockOne = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(typeof lockOne.pid, "number");

      const second = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo second"],
        homeDir,
      );
      assert.equal(second.code, 0, second.stderr);
      assert.ok(second.stdout.trim().length > 0, "second quiet prompt output should not be empty");

      const lockTwo = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(lockTwo.pid, lockOne.pid);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
      if (typeof lockTwo.pid !== "number") {
        throw new Error("queue owner lock missing pid");
      }
      assert.equal(await waitForPidExit(lockTwo.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: config agent command with flags is split correctly and stores protocol version", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
      await fs.writeFile(
        path.join(homeDir, ".acpx", "config.json"),
        `${JSON.stringify(
          {
            agents: {
              codex: {
                command: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const created = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        protocol_version?: unknown;
      };
      assert.equal(storedRecord.protocol_version, 1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt recovers when loadSession fails on empty session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flakyLoadAgentCommand = `${MOCK_AGENT_COMMAND} --load-session-fails-on-empty`;

    try {
      const created = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const originalSessionId = createdEvent.acpxRecordId;
      assert.equal(typeof originalSessionId, "string");

      const prompt = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo recovered",
        ],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const payloads = prompt.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; result?: { stopReason?: string } });
      assert.equal(
        payloads.some((payload) => Object.hasOwn(payload, "error")),
        true,
        prompt.stdout,
      );
      assert.equal(
        payloads.some((payload) => payload.result?.stopReason === "end_turn"),
        true,
        prompt.stdout,
      );

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(originalSessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        acp_session_id?: string;
        messages?: unknown[];
      };

      assert.notEqual(storedRecord.acp_session_id, originalSessionId);
      const messages = Array.isArray(storedRecord.messages) ? storedRecord.messages : [];
      assert.equal(
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "Agent" in (message as Record<string, unknown>),
        ),
        true,
      );

      const closed = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "close",
        ],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: load replay session/update notifications are suppressed from output and event log", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const replayText = "replay-load-chunk";
    const freshText = "fresh-after-load";
    const replayLoadAgentCommand =
      `${MOCK_AGENT_COMMAND} --supports-load-session ` +
      `--replay-load-session-updates --load-replay-text ${replayText}`;
    const replayAgentArgs = ["--agent", replayLoadAgentCommand, "--approve-all", "--cwd", cwd];
    let sessionId: string | undefined;

    try {
      const created = await runCli(
        [...replayAgentArgs, "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const prompt = await runCli(
        [...replayAgentArgs, "--format", "json", "prompt", `echo ${freshText}`],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const outputMessages = parseJsonRpcOutputLines(prompt.stdout);
      const outputChunkTexts = new Set(
        outputMessages
          .map((message) => extractAgentMessageChunkText(message))
          .filter((text): text is string => typeof text === "string"),
      );

      assert.equal(outputChunkTexts.has(replayText), false, prompt.stdout);
      assert.equal(outputChunkTexts.has(freshText), true, prompt.stdout);

      const loadRequest = outputMessages.find((message) => {
        return message.method === "session/load" && extractJsonRpcId(message) !== undefined;
      });
      assert(loadRequest, `expected session/load request in output:\n${prompt.stdout}`);

      const loadRequestId = extractJsonRpcId(loadRequest);
      assert.notEqual(loadRequestId, undefined);
      assert.equal(
        outputMessages.some(
          (message) =>
            extractJsonRpcId(message) === loadRequestId && Object.hasOwn(message, "result"),
        ),
        true,
        prompt.stdout,
      );

      const recordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        event_log?: {
          active_path?: string;
        };
      };
      const activeEventPath = storedRecord.event_log?.active_path;
      assert.equal(typeof activeEventPath, "string");

      const eventLog = await fs.readFile(activeEventPath as string, "utf8");
      const eventMessages = eventLog
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const eventChunkTexts = new Set(
        eventMessages
          .map((message) => extractAgentMessageChunkText(message))
          .filter((text): text is string => typeof text === "string"),
      );

      assert.equal(eventChunkTexts.has(replayText), false, eventLog);
      assert.equal(eventChunkTexts.has(freshText), true, eventLog);
    } finally {
      if (sessionId) {
        const lock = await readQueueOwnerLock(homeDir, sessionId).catch(() => undefined);
        await runCli([...replayAgentArgs, "--format", "json", "sessions", "close"], homeDir);
        if (lock) {
          await waitForPidExit(lock.pid, 5_000);
        }
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: cancel yields cancelled stopReason without queue error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    let sessionId: string | undefined;

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const promptChild = spawn(
        process.execPath,
        [CLI_PATH, ...baseAgentArgs(cwd), "--format", "json", "prompt", "sleep 5000"],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        const doneEventPromise = waitForPromptDoneEvent(promptChild, 20_000, "prompt");

        let cancelled = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const cancelResult = await runCli(
            [...baseAgentArgs(cwd), "--format", "json", "cancel"],
            homeDir,
          );
          assert.equal(cancelResult.code, 0, cancelResult.stderr);

          const payload = JSON.parse(cancelResult.stdout.trim()) as {
            action?: string;
            cancelled?: boolean;
          };
          assert.equal(payload.action, "cancel_result");
          cancelled = payload.cancelled === true;
          if (cancelled) {
            break;
          }

          await sleep(100);
        }

        assert.equal(cancelled, true, "cancel command never reached active queue owner");

        const promptResult = await doneEventPromise;
        assert.equal(
          promptResult.events.some((event) => event.result?.stopReason === "cancelled"),
          true,
          promptResult.stdout,
        );
        assert.equal(
          promptResult.events.some((event) => Object.hasOwn(event, "error")),
          false,
          promptResult.stdout,
        );
      } finally {
        await stopChildProcess(promptChild, 5_000, "prompt");
        if (sessionId) {
          const lock = await readQueueOwnerLock(homeDir, sessionId).catch(() => undefined);
          await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
          if (lock) {
            await waitForPidExit(lock.pid, 5_000);
          }
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt exits after done while detached owner stays warm", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
        acpx_record_id?: string;
        acpSessionId?: string;
        acp_session_id?: string;
        sessionId?: string;
        session_id?: string;
      };
      const sessionId =
        createdPayload.acpxRecordId ??
        createdPayload.acpx_record_id ??
        createdPayload.acpSessionId ??
        createdPayload.acp_session_id ??
        createdPayload.sessionId ??
        createdPayload.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`missing session id in sessions new output: `);
      }

      const firstPromptStartedAt = Date.now();
      const firstPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "3600",
          "prompt",
          "say exactly: warm-owner-ready",
        ],
        homeDir,
      );
      const firstPromptDurationMs = Date.now() - firstPromptStartedAt;
      assert.equal(firstPrompt.code, 0, firstPrompt.stderr);
      assert.match(firstPrompt.stdout, /warm-owner-ready/);
      assert.equal(
        firstPromptDurationMs < 8_000,
        true,
        `expected prompt to return quickly, got ${firstPromptDurationMs}ms`,
      );

      const lock = await readQueueOwnerLock(homeDir, sessionId);
      assert.equal(Number.isInteger(lock.pid) && lock.pid > 0, true);
      assert.equal(isPidAlive(lock.pid), true);

      const secondPrompt = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "say exactly: second-turn"],
        homeDir,
      );
      assert.equal(secondPrompt.code, 0, secondPrompt.stderr);
      assert.match(secondPrompt.stdout, /second-turn/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);

      assert.equal(await waitForPidExit(lock.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: session auto-closes when queue owner exits and agent has exited (#47)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      // 1. Create a persistent session
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      // 2. Send a prompt with a very short TTL so the queue owner exits quickly
      const prompt = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "--ttl", "1", "prompt", "echo oneshot-done"],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);
      assert.match(prompt.stdout, /oneshot-done/);

      // 3. Wait for the queue owner to exit (it should exit after 1s TTL)
      const { lockPath } = queuePaths(homeDir, sessionId as string);
      let ownerPid: number | undefined;
      try {
        const lockPayload = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          pid?: number;
        };
        ownerPid = lockPayload.pid;
      } catch {
        // lock file may already be gone
      }

      if (typeof ownerPid === "number") {
        assert.equal(await waitForPidExit(ownerPid, 10_000), true, "queue owner did not exit");
      }

      // Give a moment for final writes
      await sleep(500);

      // 4. Read the session record from disk
      const recordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        closed?: boolean;
        closed_at?: string;
        last_agent_exit_at?: string;
        last_agent_exit_code?: number | null;
      };

      // 5. After the fix for #47, the queue owner auto-closes the session
      //    when it shuts down and the agent has exited.
      assert.equal(
        storedRecord.last_agent_exit_at != null,
        true,
        "expected last_agent_exit_at to be set (agent has exited)",
      );

      assert.equal(
        storedRecord.closed,
        true,
        "session should be auto-closed after agent exit and queue owner shutdown (#47)",
      );

      assert.equal(
        typeof storedRecord.closed_at,
        "string",
        "closed_at should be set when session is auto-closed",
      );
    } finally {
      // Clean up: close session if it's still around
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir).catch(
        () => {},
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

function baseAgentArgs(cwd: string): string[] {
  return ["--agent", MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

function baseExecArgs(cwd: string): string[] {
  return [...baseAgentArgs(cwd), "--format", "quiet", "exec"];
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

type CliRunOptions = {
  timeoutMs?: number;
};

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

type PromptEvent = {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: {
    stopReason?: string;
  };
  error?: {
    code?: unknown;
    message?: string;
  };
};

type PromptDoneResult = {
  events: PromptEvent[];
  stdout: string;
  stderr: string;
};

async function waitForPromptDoneEvent(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<PromptDoneResult> {
  return await new Promise<PromptDoneResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const events: PromptEvent[] = [];
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      child.off("close", onClose);
      child.off("error", onError);
      run();
    };

    const parseLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }

      let event: PromptEvent;
      try {
        event = JSON.parse(trimmed) as PromptEvent;
      } catch {
        finish(() => {
          reject(
            new Error(
              `${label} emitted invalid JSON line: ${trimmed}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        });
        return;
      }

      events.push(event);
      if (event.result?.stopReason) {
        finish(() => {
          resolve({
            events,
            stdout,
            stderr,
          });
        });
      }
    };

    const flushLineBuffer = (): void => {
      const remainder = lineBuffer.trim();
      if (remainder.length > 0) {
        parseLine(remainder);
      }
      lineBuffer = "";
    };

    const onStdoutData = (chunk: string): void => {
      stdout += chunk;
      lineBuffer += chunk;

      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        parseLine(line);
        if (settled) {
          return;
        }
      }
    };

    const onStderrData = (chunk: string): void => {
      stderr += chunk;
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      flushLineBuffer();
      if (settled) {
        return;
      }
      finish(() => {
        reject(
          new Error(
            `${label} exited before done event (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`${label} process timed out waiting for done event`));
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

async function stopChildProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not exit after SIGKILL within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function listSleep60Pids(): Promise<Set<number>> {
  const output = await runCommand("ps", ["-eo", "pid=,args="]);
  const pids = new Set<number>();

  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const commandLine = match[2].trim();
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (/(^|\s)sleep 60(\s|$)/.test(commandLine)) {
      pids.add(pid);
    }
  }

  return pids;
}

async function assertNoNewSleep60Processes(
  baseline: Set<number>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = await listSleep60Pids();
    const leaked = [...current].filter((pid) => !baseline.has(pid));
    if (leaked.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      for (const pid of leaked) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // best-effort cleanup
        }
      }
      assert.fail(`Found orphan sleep process(es): ${leaked.join(", ")}`);
    }

    await sleep(100);
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
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

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

function queueOwnerLockPath(homeDir: string, sessionId: string): string {
  const queueKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(homeDir, ".acpx", "queues", `${queueKey}.lock`);
}

async function readQueueOwnerLock(homeDir: string, sessionId: string): Promise<{ pid: number }> {
  const lockPath = queueOwnerLockPath(homeDir, sessionId);
  const payload = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(payload) as { pid?: unknown };
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`queue owner lock missing valid pid: ${payload}`);
  }
  return {
    pid,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isPidAlive(pid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
