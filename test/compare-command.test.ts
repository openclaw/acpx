import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const REPO_ROOT = process.cwd();

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-compare-test-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function runCli(args: string[], homeDir: string, cwd: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
        ACPX_TEST_REPO_ROOT: REPO_ROOT,
      },
      cwd,
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
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function writeCompareAgent(homeDir: string): Promise<string> {
  const agentPath = path.join(homeDir, "compare-agent.mjs");
  await fs.writeFile(
    agentPath,
    `
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";

const require = createRequire(process.env.ACPX_TEST_REPO_ROOT + "/package.json");
const {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} = await import(require.resolve("@agentclientprotocol/sdk"));

const mode = process.argv[2] || "fast";
if (mode === "error") {
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const promptText = (prompt) =>
  prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

class CompareAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Set();
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {},
    };
  }

  async authenticate() {}

  async newSession() {
    const sessionId = randomUUID();
    this.sessions.add(sessionId);
    return { sessionId };
  }

  async prompt(params) {
    const text = promptText(params.prompt);
    if (mode === "lock-a" || mode === "lock-b") {
      let status = "isolated";
      try {
        await fs.mkdir("compare-agent-lock");
      } catch (error) {
        if (error?.code === "EEXIST") {
          status = "overlap";
        } else {
          throw error;
        }
      }
      await sleep(100);
      if (status === "isolated") {
        await fs.rm("compare-agent-lock", { recursive: true, force: true });
      }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: mode + ":" + status },
        },
      });
      return { stopReason: "end_turn" };
    }

    if (mode === "permission" || mode === "permission-mixed") {
      const outcomes = [];
      if (mode === "permission-mixed") {
        const readResponse = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: randomUUID(),
            title: "Read file",
            kind: "read",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        outcomes.push(readResponse.outcome.optionId);
      }
      const response = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: randomUUID(),
          title: "Bash",
          kind: "execute",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      outcomes.push(response.outcome.optionId);
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "permission selected:" + outcomes.join(",") },
        },
      });
      return { stopReason: "end_turn" };
    }

    const delay = mode === "slow" ? 1200 : 10;
    await sleep(delay);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        size: mode === "slow" ? 70 : 30,
        used: mode === "slow" ? 70 : 30,
        _meta: {
          usage: {
            inputTokens: mode === "slow" ? 30 : 10,
            outputTokens: mode === "slow" ? 40 : 20,
            totalTokens: mode === "slow" ? 70 : 30,
          },
        },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: mode + ": " + text },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = ndJsonStream(output, input);
new AgentSideConnection((connection) => new CompareAgent(connection), stream);
`,
    "utf8",
  );
  return agentPath;
}

async function writeCompareConfig(homeDir: string, agentPath: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    JSON.stringify(
      {
        defaultPermissions: "deny-all",
        agents: {
          fast: { command: process.execPath, args: [agentPath, "fast"] },
          slow: { command: process.execPath, args: [agentPath, "slow"] },
          error: { command: process.execPath, args: [agentPath, "error"] },
          permission: { command: process.execPath, args: [agentPath, "permission"] },
          "permission-mixed": { command: process.execPath, args: [agentPath, "permission-mixed"] },
          "lock-a": { command: process.execPath, args: [agentPath, "lock-a"] },
          "lock-b": { command: process.execPath, args: [agentPath, "lock-b"] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function setupCompareFixture(homeDir: string): Promise<string> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const agentPath = await writeCompareAgent(homeDir);
  await writeCompareConfig(homeDir, agentPath);
  return cwd;
}

type CompareRow = {
  agent: string;
  status: "ok" | "cancelled" | "error" | "permission_denied";
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  final_message: string;
  error: string | null;
  permission_requests: number;
  permission_denied: number;
};

test("compare fast slow renders a table with both successful rows", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(["compare", "fast", "slow", "summarize"], homeDir, cwd);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /agent\s+status\s+wall_ms/);
    assert.match(result.stdout, /fast\s+ok/);
    assert.match(result.stdout, /slow\s+ok/);
    assert.match(result.stdout, /end_turn/);
    assert.match(result.stdout, /fast: summarize/);
    assert.match(result.stdout, /slow: summarize/);
  });
});

test("compare --format json emits CompareRow array", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      ["--format", "json", "compare", "fast", "slow", "summarize"],
      homeDir,
      cwd,
    );

    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.deepEqual(
      rows.map((row) => [row.agent, row.status]),
      [
        ["fast", "ok"],
        ["slow", "ok"],
      ],
    );
    assert.equal(rows[0]?.input_tokens, 10);
    assert.equal(rows[0]?.output_tokens, 20);
    assert.equal(rows[0]?.total_tokens, 30);
    assert.equal(rows[1]?.input_tokens, 30);
    assert.equal(rows[1]?.output_tokens, 40);
  });
});

test("compare --json is an alias for machine-readable rows", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(["compare", "fast", "--json", "summarize"], homeDir, cwd);

    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.deepEqual(
      rows.map((row) => [row.agent, row.status]),
      [["fast", "ok"]],
    );
  });
});

test("compare keeps successful rows when one agent errors", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      ["compare", "fast", "slow", "error", "--json", "summarize"],
      homeDir,
      cwd,
    );

    assert.equal(result.code, 1, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.equal(rows.find((row) => row.agent === "fast")?.status, "ok");
    assert.equal(rows.find((row) => row.agent === "slow")?.status, "ok");
    const errorRow = rows.find((row) => row.agent === "error");
    assert.equal(errorRow?.status, "error");
    assert.equal(typeof errorRow?.error, "string");
    assert.notEqual(errorRow?.error, "");
  });
});

test("compare timeout marks slow agents as cancelled", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      ["compare", "fast", "slow", "--timeout", "0.5", "--json", "summarize"],
      homeDir,
      cwd,
    );

    assert.equal(result.code, 3, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.equal(rows.find((row) => row.agent === "fast")?.status, "ok");
    assert.equal(rows.find((row) => row.agent === "slow")?.status, "cancelled");
  });
});

test("compare applies global permission policy to every agent run", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      [
        "--approve-all",
        "--policy",
        '{"autoDeny":["execute"]}',
        "--format",
        "json",
        "compare",
        "permission",
        "summarize",
      ],
      homeDir,
      cwd,
    );

    assert.equal(result.code, 5, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.equal(rows[0]?.agent, "permission");
    assert.equal(rows[0]?.status, "permission_denied");
    assert.equal(rows[0]?.permission_requests, 1);
    assert.equal(rows[0]?.permission_denied, 1);
    assert.match(rows[0]?.final_message ?? "", /permission selected:reject/);
  });
});

test("compare reports partial permission denial as denied", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      [
        "--approve-all",
        "--policy",
        '{"autoApprove":["read"],"autoDeny":["execute"]}',
        "--format",
        "json",
        "compare",
        "permission-mixed",
        "summarize",
      ],
      homeDir,
      cwd,
    );

    assert.equal(result.code, 5, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.equal(rows[0]?.agent, "permission-mixed");
    assert.equal(rows[0]?.status, "permission_denied");
    assert.equal(rows[0]?.permission_requests, 2);
    assert.equal(rows[0]?.permission_denied, 1);
    assert.match(rows[0]?.final_message ?? "", /permission selected:allow,reject/);
  });
});

test("compare runs agents serially in a shared workspace", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      ["compare", "lock-a", "lock-b", "--json", "summarize"],
      homeDir,
      cwd,
    );

    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.deepEqual(
      rows.map((row) => row.final_message),
      ["lock-a:isolated", "lock-b:isolated"],
    );
  });
});
