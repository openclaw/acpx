import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonRpcOutputLines } from "./jsonrpc-test-helpers.js";
import { fileExists } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const FILE_BLOCKS = [
  { type: "text", text: "echo FILE_MARKER" },
  { type: "text", text: "\nFILE_CONTEXT" },
];
const TAIL = "echo POSITIONAL_MARKER";

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type Fixture = {
  cwd: string;
  pidFile: string;
  run: (args: string[], input?: string) => Promise<CliResult>;
  createSession: () => Promise<string>;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function jsonRecord(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  return record(value);
}

function succeeded(result: CliResult): void {
  assert.equal(
    result.code,
    0,
    `signal=${String(result.signal)}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
}

async function runCli(
  homeDir: string,
  cwd: string,
  args: string[],
  input?: string,
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.ACPX_QUEUE_OWNER_ARGS;
  delete env.ACPX_PERF_METRICS_FILE;
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "--format", "json", "--ttl", "1", ...args],
      {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // A watchdog only: assertions never compare elapsed startup or prompt times.
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function fixture(t: TestContext, supportsList = true): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-precedence-"));
  const homeDir = path.join(root, "home");
  let hasSession = false;
  let cwd = path.join(root, "workspace");
  const run = (args: string[], input?: string) => runCli(homeDir, cwd, args, input);
  t.after(async () => {
    // Node reports hook failures alongside the original assertion failure.
    // Preserve the fixture if owner cleanup fails instead of deleting live state.
    if (hasSession) {
      succeeded(await run(["codex", "sessions", "close"]));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.mkdir(path.join(cwd, "chosen"), { recursive: true });
  await fs.mkdir(path.join(cwd, "ignored"), { recursive: true });
  cwd = await fs.realpath(cwd);
  const pidFile = path.join(root, "adapter.pid");
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    JSON.stringify({
      agents: {
        codex: {
          argv: [
            process.execPath,
            MOCK_AGENT_PATH,
            "--supports-load-session",
            ...(supportsList ? ["--supports-list-sessions", "--list-page-size", "1"] : []),
            "--pid-file",
            pidFile,
          ],
        },
      },
    }),
  );
  await fs.writeFile(path.join(cwd, "brief.json"), JSON.stringify(FILE_BLOCKS));
  await fs.writeFile(path.join(cwd, " plain brief.txt "), "echo PLAIN_MARKER");
  return {
    cwd,
    pidFile,
    run,
    async createSession() {
      hasSession = true;
      const created = await run(["codex", "sessions", "new"]);
      succeeded(created);
      const id = jsonRecord(created.stdout).acpxRecordId;
      assert.equal(typeof id, "string");
      assert.ok(id);
      return id as string;
    },
  };
}

const filePlacements = [
  { name: "parent", before: ["--file", "brief.json"], after: [] },
  { name: "child", before: [], after: ["--file", "brief.json"] },
  {
    name: "explicit child overrides parent",
    before: ["--file", "must-not-be-opened.json"],
    after: ["--file", "brief.json"],
  },
];

for (const command of ["exec", "prompt"] as const) {
  for (const placement of filePlacements) {
    test(`${command} preserves ${placement.name} --file blocks and positional input`, async (t) => {
      const context = await fixture(t);
      if (command === "prompt") {
        await context.createSession();
      }
      const result = await context.run([
        "codex",
        ...placement.before,
        command,
        ...placement.after,
        TAIL,
      ]);
      succeeded(result);
      const prompts = parseJsonRpcOutputLines(result.stdout).filter(
        (message) => message.method === "session/prompt",
      );
      assert.equal(prompts.length, 1, result.stdout);
      assert.deepEqual(record(prompts[0]?.params).prompt, [
        ...FILE_BLOCKS,
        { type: "text", text: TAIL },
      ]);
    });
  }
}

for (const args of [
  ["sessions", "--local"],
  ["sessions", "--local", "list"],
  ["sessions", "list", "--local"],
]) {
  test(`${args.join(" ")} returns local records without starting the adapter`, async (t) => {
    const context = await fixture(t);
    const sessionId = await context.createSession();
    // Successful creation proves this configured peer writes its launch sentinel.
    assert.equal(await fileExists(context.pidFile), true);
    await fs.unlink(context.pidFile);
    const result = await context.run(["codex", ...args]);
    succeeded(result);
    const value: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(value), result.stdout);
    assert.deepEqual(
      value.map((entry: unknown) => record(entry).acpxRecordId),
      [sessionId],
    );
    assert.equal(await fileExists(context.pidFile), false, "local listing started the adapter");
  });
}

const listPlacements = [
  ["sessions", "--filter-cwd", "chosen", "--cursor", "1", "list"],
  ["sessions", "list", "--filter-cwd", "chosen", "--cursor", "1"],
  [
    "sessions",
    "--filter-cwd",
    "ignored",
    "--cursor",
    "0",
    "list",
    "--filter-cwd",
    "chosen",
    "--cursor",
    "1",
  ],
];

for (const [index, args] of listPlacements.entries()) {
  test(`sessions list resolves effective filter and cursor (${index})`, async (t) => {
    const context = await fixture(t);
    const result = await context.run(["codex", ...args]);
    succeeded(result);
    const payload = jsonRecord(result.stdout);
    const expectedCwd = path.join(context.cwd, "chosen");
    assert.equal(payload.source, "agent");
    assert.equal(payload.cwd, expectedCwd);
    assert.equal(payload.cursor, "1");
    assert.equal(payload.nextCursor, undefined);
    assert.ok(Array.isArray(payload.sessions));
    assert.deepEqual(
      payload.sessions.map((entry: unknown) => {
        const session = record(entry);
        return { sessionId: session.sessionId, cwd: session.cwd };
      }),
      [{ sessionId: "mock-session-gamma", cwd: expectedCwd }],
    );
  });
}

for (const args of [
  ["sessions", "--local", "list", "--cursor", "1"],
  ["sessions", "--cursor", "1", "list", "--local"],
]) {
  test(`${args.join(" ")} rejects incompatible options before adapter startup`, async (t) => {
    const context = await fixture(t);
    const result = await context.run(["codex", ...args]);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /--cursor cannot be combined with --local/);
    assert.equal(await fileExists(context.pidFile), false, "invalid listing started the adapter");
  });
}

for (const command of ["exec", "prompt"] as const) {
  for (const placement of ["parent", "child"] as const) {
    for (const source of ["plain-file", "structured-stdin"] as const) {
      test(`${command} accepts ${placement} ${source} without losing source or suffix`, async (t) => {
        const context = await fixture(t);
        if (command === "prompt") {
          await context.createSession();
        }
        const file = source === "plain-file" ? " plain brief.txt " : "-";
        const fileArgs = ["-f", file];
        const args = [
          "codex",
          ...(placement === "parent" ? fileArgs : []),
          command,
          ...(placement === "child" ? fileArgs : []),
          ...(source === "structured-stdin" ? [TAIL] : []),
        ];
        const result = await context.run(
          args,
          source === "structured-stdin" ? JSON.stringify(FILE_BLOCKS) : undefined,
        );
        succeeded(result);
        const prompts = parseJsonRpcOutputLines(result.stdout).filter(
          (message) => message.method === "session/prompt",
        );
        assert.equal(prompts.length, 1);
        assert.deepEqual(
          record(prompts[0]?.params).prompt,
          source === "plain-file"
            ? [{ type: "text", text: "echo PLAIN_MARKER" }]
            : [...FILE_BLOCKS, { type: "text", text: TAIL }],
        );
      });
    }
  }
  test(`${command} preserves a literal --file after the prompt delimiter`, async (t) => {
    const context = await fixture(t);
    if (command === "prompt") {
      await context.createSession();
    }
    const result = await context.run([
      "codex",
      "--file",
      "brief.json",
      command,
      "--",
      "--file",
      "literal",
    ]);
    succeeded(result);
    const prompts = parseJsonRpcOutputLines(result.stdout).filter(
      (message) => message.method === "session/prompt",
    );
    assert.equal(prompts.length, 1);
    assert.deepEqual(record(prompts[0]?.params).prompt, [
      ...FILE_BLOCKS,
      { type: "text", text: "--file literal" },
    ]);
  });
}

for (const args of [
  ["codex", "-f", "brief.json"],
  ["prompt", "-f", "brief.json"],
  ["exec", "-f", "brief.json"],
]) {
  test(`existing ${args[0]} prompt form keeps its file input`, async (t) => {
    const context = await fixture(t);
    if (args[0] !== "exec") {
      await context.createSession();
    }
    const result = await context.run([...args, TAIL]);
    succeeded(result);
    const prompts = parseJsonRpcOutputLines(result.stdout).filter(
      (message) => message.method === "session/prompt",
    );
    assert.equal(prompts.length, 1);
    assert.deepEqual(record(prompts[0]?.params).prompt, [
      ...FILE_BLOCKS,
      { type: "text", text: TAIL },
    ]);
  });
}

test("default-agent sessions inherits local before list without starting its adapter", async (t) => {
  const context = await fixture(t);
  const id = await context.createSession();
  await fs.unlink(context.pidFile);
  const result = await context.run(["sessions", "--local", "list"]);
  succeeded(result);
  const entries: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(entries));
  assert.deepEqual(
    entries.map((entry: unknown) => record(entry).acpxRecordId),
    [id],
  );
  assert.equal(await fileExists(context.pidFile), false);
});

for (const placement of ["parent", "child"] as const) {
  test(`unsupported native list rejects ${placement} filters without falling back locally`, async (t) => {
    const context = await fixture(t, false);
    const filter = ["--filter-cwd", "chosen"];
    const result = await context.run([
      "sessions",
      ...(placement === "parent" ? filter : []),
      "list",
      ...(placement === "child" ? filter : []),
    ]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /does not advertise sessionCapabilities.list/);
    assert.equal(
      await fileExists(context.pidFile),
      true,
      "capability must be read from the real adapter",
    );
  });
}

test("unsupported native list still falls back locally without filters", async (t) => {
  const context = await fixture(t, false);
  const id = await context.createSession();
  const result = await context.run(["sessions", "list"]);
  succeeded(result);
  const entries: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(entries));
  assert.deepEqual(
    entries.map((entry: unknown) => record(entry).acpxRecordId),
    [id],
  );
});
