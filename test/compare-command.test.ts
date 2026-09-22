import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { withTimeout } from "../src/async-control.js";

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

function startCli(args: string[], homeDir: string, cwd: string, input?: string) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
      ACPX_TEST_REPO_ROOT: REPO_ROOT,
    },
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);

  const result = new Promise<CliRunResult>((resolve, reject) => {
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
    child.once("error", reject);
  });
  return { child, result };
}

async function runCli(
  args: string[],
  homeDir: string,
  cwd: string,
  input?: string,
): Promise<CliRunResult> {
  return await startCli(args, homeDir, cwd, input).result;
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
const eventDir = process.argv[3];
if (mode === "next") {
  await fs.writeFile(eventDir + "/next-started", "started");
}
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

  async newSession(params) {
    this.sessionParams = params;
    const sessionId = randomUUID();
    this.sessions.add(sessionId);
    return { sessionId };
  }

  async prompt(params) {
    const text = promptText(params.prompt);
    if (mode === "cwd") {
      const permission = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {toolCallId: "cwd-check", title: "Execute", kind: "execute"},
        options: [{optionId: "allow", name: "Allow", kind: "allow_once"}, {optionId: "reject", name: "Reject", kind: "reject_once"}],
      });
      await fs.writeFile("compare-cwd.json", JSON.stringify({cwd: process.cwd(), session: this.sessionParams, permission, prompt: params.prompt}));
    }
    if (mode === "wait" || mode === "disconnect") {
      await fs.writeFile(eventDir + "/prompt-ready", "ready");
      return await new Promise((resolve) => { this.finish = resolve; });
    }
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

    if (mode === "usage-context" || mode === "usage-partial" || mode === "usage-zero") {
      const usage = mode === "usage-zero"
        ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        : mode === "usage-partial"
          ? { input_tokens: 10, output_tokens: 20 }
          : undefined;
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 123,
          size: 200000,
          ...(usage === undefined ? {} : { _meta: { usage } }),
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
        size: 200000,
        used: 123,
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

  async cancel() {
    if (mode !== "wait" && mode !== "disconnect") return;
    await fs.writeFile(eventDir + "/cancel-observed", "cancelled");
    if (mode === "disconnect") process.exit(0);
    this.finish({stopReason: "cancelled"});
  }
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
          "usage-context": { command: process.execPath, args: [agentPath, "usage-context"] },
          "usage-partial": { command: process.execPath, args: [agentPath, "usage-partial"] },
          "usage-zero": { command: process.execPath, args: [agentPath, "usage-zero"] },
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

test("compare reports explicit token counts without inventing totals from context or partial usage", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      [
        "--format",
        "json",
        "compare",
        "usage-context",
        "usage-partial",
        "usage-zero",
        "fast",
        "summarize",
      ],
      homeDir,
      cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.deepEqual(
      rows.map((row) => ({
        agent: row.agent,
        status: row.status,
        input: row.input_tokens,
        output: row.output_tokens,
        total: row.total_tokens,
      })),
      [
        { agent: "usage-context", status: "ok", input: null, output: null, total: null },
        { agent: "usage-partial", status: "ok", input: 10, output: 20, total: null },
        { agent: "usage-zero", status: "ok", input: 0, output: 0, total: 0 },
        { agent: "fast", status: "ok", input: 10, output: 20, total: 30 },
      ],
    );
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

function compareInvocationError(
  result: CliRunResult,
  exitCode = 1,
): {
  code?: number;
  message?: string;
  data?: { acpxCode?: string };
} {
  assert.equal(result.code, exitCode, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout) as {
    jsonrpc?: string;
    id?: unknown;
    error?: { code?: number; message?: string; data?: { acpxCode?: string } };
  };
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.id, null);
  assert.ok(payload.error);
  assert.equal(typeof payload.error.message, "string");
  return payload.error;
}

for (const scenario of [
  { name: "alias", output: ["--json"], agents: ["fast"], code: 0, statuses: ["ok"] },
  { name: "long form", output: ["--format", "json"], agents: ["fast"], code: 0, statuses: ["ok"] },
  {
    name: "agent failure",
    output: ["--json"],
    agents: ["fast", "error"],
    code: 1,
    statuses: ["ok", "error"],
  },
]) {
  test(`compare strict JSON preserves summary arrays with ${scenario.name}`, async () => {
    await withTempHome(async (homeDir) => {
      const cwd = await setupCompareFixture(homeDir);
      const result = await runCli(
        ["--json-strict", "compare", ...scenario.agents, ...scenario.output, "summarize"],
        homeDir,
        cwd,
      );
      assert.equal(result.code, scenario.code, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      const rows = JSON.parse(result.stdout) as CompareRow[];
      assert.deepEqual(
        rows.map((row) => row.agent),
        scenario.agents,
      );
      assert.deepEqual(
        rows.map((row) => row.status),
        scenario.statuses,
      );
      assert.equal(rows[0]?.final_message, "fast: summarize");
    });
  });
}

test("compare keeps alias, root, local and configured format precedence", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    await fs.writeFile(path.join(cwd, ".acpxrc.json"), JSON.stringify({ format: "quiet" }));
    for (const scenario of [
      {
        args: ["--format", "quiet", "compare", "fast", "--json", "--format", "text", "hello"],
        json: true,
      },
      {
        args: ["--format", "quiet", "compare", "fast", "--format", "text", "--json", "hello"],
        json: true,
      },
      { args: ["--format", "quiet", "compare", "fast", "--format", "json", "hello"], json: false },
      { args: ["compare", "fast", "--format", "json", "hello"], json: true },
    ]) {
      const result = await runCli(scenario.args, homeDir, cwd);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      if (scenario.json) {
        const rows = JSON.parse(result.stdout) as CompareRow[];
        assert.deepEqual(
          rows.map((row) => [row.agent, row.status]),
          [["fast", "ok"]],
        );
      } else {
        assert.equal(result.stdout, "fast\tok\n");
      }
    }
  });
});

for (const failure of ["config", "prompt-file"]) {
  test(`compare alias and local format select JSON for ${failure} errors`, async () => {
    await withTempHome(async (homeDir) => {
      const cwd = await setupCompareFixture(homeDir);
      if (failure === "config") {
        await fs.writeFile(path.join(cwd, ".acpxrc.json"), "{");
      }
      const messages = [];
      for (const output of [["--json"], ["--format", "json"]]) {
        const tail = failure === "config" ? ["hello"] : ["--file", "missing-prompt.txt"];
        const result = await runCli(["compare", "fast", ...output, ...tail], homeDir, cwd);
        const error = compareInvocationError(result);
        assert.equal(error.code, -32603);
        assert.equal(error.data?.acpxCode, "RUNTIME");
        messages.push(error.message);
      }
      assert.equal(messages[0], messages[1]);
    });
  });
}

test("compare alias preserves strict validation and remains command-local", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(
      ["--json-strict", "--verbose", "compare", "fast", "--json", "hello"],
      homeDir,
      cwd,
    );
    const error = compareInvocationError(result, 2);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(error.message ?? "", /--json-strict cannot be combined with --verbose/);
    const globalAlias = await runCli(
      ["--json-strict", "--json", "compare", "fast", "hello"],
      homeDir,
      cwd,
    );
    const unsupported = compareInvocationError(globalAlias, 2);
    assert.equal(unsupported.data?.acpxCode, "USAGE");
    assert.match(unsupported.message ?? "", /unknown option '--json'/);
  });
});

test("compare error policy ignores format-looking values and delimiter text", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    await fs.writeFile(path.join(cwd, ".acpxrc.json"), JSON.stringify({ disableExec: true }));
    for (const args of [
      ["compare", "fast", "--file", "--json"],
      ["compare", "fast", "--", "--json"],
      ["--system-prompt", "--json", "compare", "fast", "hello"],
    ]) {
      const result = await runCli(args, homeDir, cwd);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /compare subcommand is disabled/);
    }
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

for (const flag of ["--file", "-f", "--prompt-file"]) {
  test(`compare ${flag} keeps delimiter text out of agent selection`, async () => {
    await withTempHome(async (homeDir) => {
      const cwd = await setupCompareFixture(homeDir);
      await fs.writeFile(path.join(cwd, "brief.txt"), "file prompt");
      const marker = path.join(homeDir, "unintended-agent-started");
      const unintendedAgent = path.join(homeDir, "unintended-agent.mjs");
      await fs.writeFile(
        unintendedAgent,
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      );
      const literalPrompt = `${JSON.stringify(process.execPath)} ${JSON.stringify(unintendedAgent)}`;
      const result = await runCli(
        ["compare", "fast", "--json", flag, "brief.txt", "--", literalPrompt],
        homeDir,
        cwd,
      );
      await assert.rejects(fs.access(marker), { code: "ENOENT" });
      assert.equal(result.code, 0, result.stderr);
      const rows = JSON.parse(result.stdout) as CompareRow[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agent, "fast");
      assert.match(rows[0].final_message, /file prompt/);
    });
  });
}

test("compare local cwd selects project configuration before loading the caller config", async () => {
  await withTempHome(async (homeDir) => {
    const source = await setupCompareFixture(homeDir);
    const target = path.join(homeDir, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(source, ".acpxrc.json"), "malformed caller configuration");
    await fs.writeFile(path.join(target, ".acpxrc.json"), JSON.stringify({ disableExec: true }));
    for (const output of [["--json"], ["--format", "json"]]) {
      const result = await runCli(
        ["compare", "fast", "--cwd", target, ...output, "hello"],
        homeDir,
        source,
      );
      const error = compareInvocationError(result);
      assert.equal(error.code, -32603);
      assert.equal(error.data?.acpxCode, "RUNTIME");
      assert.match(error.message ?? "", /compare subcommand is disabled/);
      assert.doesNotMatch(error.message ?? "", /parse|malformed/i);
    }
  });
});

for (const localForm of ["before-agent", "after-agent", "inline", "relative", "root-and-local"]) {
  test(`compare ${localForm} cwd owns agent configuration, input files, permissions and MCP`, async () => {
    await withTempHome(async (homeDir) => {
      const source = await setupCompareFixture(homeDir);
      const target = path.join(homeDir, "target");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "brief.txt"), "target-only brief");
      await fs.writeFile(
        path.join(target, "mcp.json"),
        JSON.stringify({
          mcpServers: [{ name: "synthetic-target", command: "unused-mcp", args: [] }],
        }),
      );
      await fs.writeFile(
        path.join(target, ".acpxrc.json"),
        JSON.stringify({
          defaultPermissions: "approve-all",
          agents: {
            "target-only": {
              command: process.execPath,
              args: [path.join(homeDir, "compare-agent.mjs"), "cwd"],
            },
          },
        }),
      );
      const cwdFlags =
        localForm === "inline"
          ? [`--cwd=${target}`]
          : ["--cwd", localForm === "relative" ? path.relative(source, target) : target];
      const operands =
        localForm === "before-agent" ? [...cwdFlags, "target-only"] : ["target-only", ...cwdFlags];
      const rootFlags = localForm === "root-and-local" ? ["--cwd", source] : [];
      const promptTail = localForm === "after-agent" ? ["--", "--cwd", source] : [];
      const result = await runCli(
        [
          ...rootFlags,
          "--mcp-config",
          "mcp.json",
          "compare",
          ...operands,
          "--file",
          "brief.txt",
          "--json",
          ...promptTail,
        ],
        homeDir,
        source,
      );
      assert.equal(result.code, 0, result.stderr);
      const observed = JSON.parse(
        await fs.readFile(path.join(target, "compare-cwd.json"), "utf8"),
      ) as {
        cwd: string;
        session: { cwd: string; mcpServers: Array<{ name: string }> };
        permission: { outcome: { optionId: string } };
        prompt: Array<{ text: string }>;
      };
      assert.equal(await fs.realpath(observed.cwd), await fs.realpath(target));
      assert.equal(await fs.realpath(observed.session.cwd), await fs.realpath(target));
      assert.equal(observed.session.mcpServers[0]?.name, "synthetic-target");
      assert.equal(observed.permission.outcome.optionId, "allow");
      assert.deepEqual(observed.prompt, [
        { type: "text", text: "target-only brief" },
        ...(promptTail.length > 0 ? [{ type: "text", text: `--cwd ${source}` }] : []),
      ]);
      await assert.rejects(fs.access(path.join(source, "compare-cwd.json")), { code: "ENOENT" });
    });
  });
}

test("compare recognizes only an unconsumed delimiter in its own argument tail", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    await fs.writeFile(path.join(cwd, "--"), "literal delimiter file");
    const result = await runCli(
      [
        "--system-prompt",
        "compare",
        "--allowed-tools",
        "--",
        "compare",
        "fast",
        "--file",
        "--",
        "--json",
        "--",
        "appended text",
      ],
      homeDir,
      cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.equal(rows.length, 1);
    assert.match(rows[0].final_message, /literal delimiter file.*appended text/);
  });
});

for (const flag of ["--file=brief.txt", "-fbrief.txt"]) {
  test(`compare ${flag} preserves an empty prompt delimiter`, async () => {
    await withTempHome(async (homeDir) => {
      const cwd = await setupCompareFixture(homeDir);
      await fs.writeFile(path.join(cwd, "brief.txt"), "file-only prompt");
      const result = await runCli(["compare", "fast", "--json", flag, "--"], homeDir, cwd);
      assert.equal(result.code, 0, result.stderr);
      const rows = JSON.parse(result.stdout) as CompareRow[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].final_message, "fast: file-only prompt");
    });
  });
}

test("compare empty delimiter accepts stdin without consuming an agent as prompt text", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await setupCompareFixture(homeDir);
    const result = await runCli(["compare", "fast", "--json", "--"], homeDir, cwd, "stdin prompt");
    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as CompareRow[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].final_message, "fast: stdin prompt");
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const mode of ["wait", "disconnect"]) {
    test(
      `compare ${signal} stops admission after ${mode} cancellation`,
      { skip: process.platform === "win32", timeout: 20_000 },
      async () => {
        await withTempHome(async (homeDir) => {
          const cwd = await setupCompareFixture(homeDir);
          const agentPath = path.join(homeDir, "compare-agent.mjs");
          await fs.writeFile(
            path.join(homeDir, ".acpx", "config.json"),
            JSON.stringify({
              defaultPermissions: "deny-all",
              agents: {
                waiting: { command: process.execPath, args: [agentPath, mode, homeDir] },
                next: { command: process.execPath, args: [agentPath, "next", homeDir] },
              },
            }),
          );
          const { child, result } = startCli(
            ["compare", "waiting", "next", "--json", "hello"],
            homeDir,
            cwd,
          );
          try {
            const ready = async () => {
              const deadline = Date.now() + 5_000;
              while (Date.now() < deadline) {
                try {
                  await fs.access(path.join(homeDir, "prompt-ready"));
                  return;
                } catch {
                  await delay(10);
                }
              }
              throw new Error("Compare did not reach prompt readiness");
            };
            await withTimeout(
              Promise.race([
                ready(),
                result.then((early) => {
                  throw new Error(
                    `Compare exited before prompt readiness: ${JSON.stringify(early)}`,
                  );
                }),
              ]),
              5_000,
            );
            child.kill(signal);
            const finished = await withTimeout(result, 10_000);
            assert.equal(
              await fs.readFile(path.join(homeDir, "cancel-observed"), "utf8"),
              "cancelled",
            );
            await assert.rejects(fs.access(path.join(homeDir, "next-started")), { code: "ENOENT" });
            assert.equal(finished.code, 130, finished.stderr);
            const rows = JSON.parse(finished.stdout) as CompareRow[];
            assert.deepEqual(
              rows.map((row) => [row.agent, row.status]),
              [["waiting", "cancelled"]],
            );
          } finally {
            if (child.exitCode == null && child.signalCode == null) {
              child.kill("SIGKILL");
            }
          }
        });
      },
    );
  }
}
