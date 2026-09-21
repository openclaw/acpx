import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, runRunner, parseReport } from "./conformance-test-helpers.js";

const MOCK_AGENT_COMMAND = "node --import tsx test/mock-agent.ts";

test("runner reports initialize failures as failed cases and still writes a report", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const reportPath = path.join(tmp, "report.json");
    const result = await runRunner(
      [
        "--case",
        "acp.v1.initialize.handshake",
        "--agent-command",
        'node -e "setTimeout(() => {}, 20000)"',
        "--format",
        "json",
        "--report",
        reportPath,
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr.trim(), "");

    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 0,
      failed: 1,
    });
    assert.equal(report.results[0]?.id, "acp.v1.initialize.handshake");
    assert.equal(report.results[0]?.passed, false);
    assert.match(report.results[0]?.error ?? "", /initialize timed out/i);

    const savedReport = parseReport(await fs.readFile(reportPath, "utf8"));
    assert.deepEqual(savedReport.totals, report.totals);
    assert.equal(savedReport.results[0]?.passed, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner reports missing adapter commands as failed initialize cases", async () => {
  const result = await runRunner(
    [
      "--case",
      "acp.v1.initialize.handshake",
      "--agent-command",
      "definitely-not-a-real-command",
      "--format",
      "json",
    ],
    { timeoutMs: 20_000 },
  );

  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stderr.trim(), "");

  const report = parseReport(result.stdout);
  assert.deepEqual(report.totals, {
    cases: 1,
    passed: 0,
    failed: 1,
  });
  assert.equal(report.results[0]?.id, "acp.v1.initialize.handshake");
  assert.equal(report.results[0]?.passed, false);
  assert.match(report.results[0]?.error ?? "", /failed to spawn agent process/i);
});

test("runner rejects successful operations when an error is expected", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const { profilePath, casesDir } = await writeFixture(
      tmp,
      [{}, { message_any: ["error"] }].map((expect_error, index) => ({
        id: `custom.expected_error.${index}`,
        steps: [{ action: "new_session", expect_error }],
      })),
    );
    const result = await runRunner([
      "--profile",
      profilePath,
      "--cases-dir",
      casesDir,
      "--cwd",
      tmp,
      "--agent-command",
      MOCK_AGENT_COMMAND,
      "--format",
      "json",
    ]);
    assert.equal(result.code, 1, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, { cases: 2, passed: 0, failed: 2 });
    for (const result of report.results) {
      assert.equal(result.passed, false);
      assert.match(result.error ?? "", /session\/new succeeded but error was expected/);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner resolves relative file reads within session cwd without changing adapter command cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const token = "TOKEN_FROM_SESSION_CWD";
    await fs.writeFile(path.join(tmp, "README.md"), `${token}\n`, "utf8");

    const { profilePath, casesDir } = await writeFixture(tmp, [
      {
        id: "custom.read.session_cwd",
        title: "Read resolves from session cwd",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "read README.md" }],
            save_as: "read_result",
          },
        ],
        checks: [
          {
            type: "saved_stop_reason_in",
            key: "read_result",
            values: ["end_turn"],
          },
          {
            type: "updates_text_includes",
            text: token,
          },
        ],
      },
    ]);

    const result = await runRunner(
      [
        "--profile",
        profilePath,
        "--cases-dir",
        casesDir,
        "--cwd",
        tmp,
        "--agent-command",
        MOCK_AGENT_COMMAND,
        "--format",
        "json",
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 1,
      failed: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner rejects reads outside the session cwd root", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const { profilePath, casesDir } = await writeFixture(tmp, [
      {
        id: "custom.read.outside_root",
        title: "Read outside session cwd root is rejected",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "read /etc/hosts" }],
            save_as: "read_result",
          },
        ],
        checks: [
          {
            type: "saved_stop_reason_in",
            key: "read_result",
            values: ["end_turn"],
          },
          {
            type: "updates_text_includes",
            text: "outside session cwd root",
          },
        ],
      },
    ]);

    const result = await runRunner(
      [
        "--profile",
        profilePath,
        "--cases-dir",
        casesDir,
        "--cwd",
        tmp,
        "--agent-command",
        MOCK_AGENT_COMMAND,
        "--format",
        "json",
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 1,
      failed: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner observes late post-success tool updates after settle timeout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const { profilePath, casesDir } = await writeFixture(tmp, [
      {
        id: "custom.prompt.post_success_drain",
        title: "Late post-success tool updates remain observable",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "late-tool 40 follow-up" }],
            save_as: "prompt_result",
          },
        ],
        checks: [
          {
            type: "saved_stop_reason_in",
            key: "prompt_result",
            values: ["end_turn"],
          },
          {
            type: "updates_text_includes",
            text: "writing now",
          },
          {
            type: "updates_session_update_includes",
            values: ["tool_call", "tool_call_update"],
          },
        ],
        timeouts: {
          settle_timeout_ms: 160,
        },
      },
    ]);

    const result = await runRunner(
      [
        "--profile",
        profilePath,
        "--cases-dir",
        casesDir,
        "--agent-command",
        MOCK_AGENT_COMMAND,
        "--format",
        "json",
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 1,
      failed: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function writeFixture(
  rootDir: string,
  cases: Array<Record<string, unknown>>,
): Promise<{ profilePath: string; casesDir: string }> {
  const casesDir = path.join(rootDir, "cases");
  const profilesDir = path.join(rootDir, "profiles");
  await fs.mkdir(casesDir, { recursive: true });
  await fs.mkdir(profilesDir, { recursive: true });

  const requiredCases: string[] = [];

  for (const [index, definition] of cases.entries()) {
    const id = definition.id;
    assert.equal(typeof id, "string");
    if (typeof id !== "string") {
      throw new TypeError("Conformance case id must be a string.");
    }
    requiredCases.push(id);

    const fileName = `${String(index + 1).padStart(3, "0")}-${id}.json`;
    await fs.writeFile(
      path.join(casesDir, fileName),
      `${JSON.stringify(definition, null, 2)}\n`,
      "utf8",
    );
  }

  const profilePath = path.join(profilesDir, "profile.json");
  await fs.writeFile(
    profilePath,
    `${JSON.stringify(
      {
        id: "custom-profile",
        required_cases: requiredCases,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { profilePath, casesDir };
}

type ProtocolTraceEntry = {
  direction: "in" | "out";
  message: {
    id?: number | string;
    method?: string;
    params?: {
      sessionId?: string;
      prompt?: Array<{ type: string }>;
      update?: { sessionUpdate?: string };
    };
    result?: { stopReason?: string };
    error?: { code?: number };
  };
};

const PROTOCOL_AGENT_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const [tracePath, embeddedContext, behavior] = process.argv.slice(2);
const sessions = new Set();
let nextSession = 0;
let pendingPrompt;

function record(direction, message) {
  appendFileSync(tracePath, JSON.stringify({ direction, message }) + "\n");
}

function send(message) {
  record("out", message);
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  record("in", request);
  if (request.method === "initialize") {
    result(request.id, {
      protocolVersion: 1,
      agentCapabilities: embeddedContext === "omitted"
        ? {}
        : { promptCapabilities: { embeddedContext: embeddedContext === "true" } },
    });
  } else if (request.method === "session/new") {
    if (typeof request.params.cwd !== "string") {
      failure(request.id, -32602, "Invalid cwd parameter");
      continue;
    }
    const sessionId = "protocol-fixture-" + (++nextSession);
    sessions.add(sessionId);
    result(request.id, { sessionId });
  } else if (request.method === "session/prompt") {
    if (typeof request.params.sessionId !== "string") {
      failure(request.id, -32602, "Invalid session id");
      continue;
    }
    if (!sessions.has(request.params.sessionId)) {
      failure(request.id, -32002, "Resource not found");
      continue;
    }
    if (embeddedContext !== "true" && request.params.prompt.some((block) => block.type === "resource")) {
      failure(request.id, -32602, "Embedded resource requires embeddedContext capability");
      continue;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "This is an ordinary protocol response." },
        },
      },
    });
    if (behavior === "cancel") {
      pendingPrompt = request;
    } else {
      result(request.id, behavior === "missing-stop-reason" ? {} : { stopReason: "end_turn" });
    }
  } else if (request.method === "session/cancel") {
    if (pendingPrompt?.params.sessionId === request.params.sessionId) {
      result(pendingPrompt.id, { stopReason: "cancelled" });
      pendingPrompt = undefined;
    }
  } else if (request.id !== undefined) {
    failure(request.id, -32601, "Unknown method");
  }
}
`;

async function writeProtocolAgent(
  directory: string,
  embeddedContext: "omitted" | "false" | "true",
  behavior: "ordinary" | "missing-stop-reason" | "cancel" = "ordinary",
): Promise<{ command: string; tracePath: string }> {
  const adapterPath = path.join(directory, "protocol-agent.mjs");
  const tracePath = path.join(directory, "protocol-trace.jsonl");
  await fs.writeFile(adapterPath, PROTOCOL_AGENT_SOURCE, "utf8");
  // The runner parses quoted argv itself; this string never goes through a shell.
  const command = [process.execPath, adapterPath, tracePath, embeddedContext, behavior]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
  return { command, tracePath };
}

async function readProtocolTrace(tracePath: string): Promise<ProtocolTraceEntry[]> {
  return (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ProtocolTraceEntry);
}

test("core profile accepts ordinary ACP replies without mock commands or optional content", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-core-profile-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const { command, tracePath } = await writeProtocolAgent(directory, "omitted");
  const result = await runRunner([
    "--cwd",
    directory,
    "--agent-command",
    command,
    "--format",
    "json",
  ]);

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = parseReport(result.stdout);
  assert.equal(report.totals.failed, 0);
  for (const id of [
    "acp.v1.session.prompt.unrecognized",
    "acp.v1.session.prompt.structured_blocks",
  ]) {
    assert.equal(
      report.results.some((entry) => entry.id === id && entry.passed),
      true,
      id,
    );
  }
  const blocks = (await readProtocolTrace(tracePath))
    .filter((entry) => entry.direction === "in" && entry.message.method === "session/prompt")
    .flatMap((entry) => entry.message.params?.prompt ?? []);
  assert.equal(
    blocks.some((block) => block.type === "resource_link"),
    true,
  );
  assert.equal(
    blocks.every((block) => block.type === "text" || block.type === "resource_link"),
    true,
  );
});

for (const embeddedContext of ["false", "true"] as const) {
  test(`core structured prompt uses baseline content when embeddedContext is ${embeddedContext}`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-prompt-capability-"));
    t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
    const { command, tracePath } = await writeProtocolAgent(directory, embeddedContext);
    const result = await runRunner([
      "--case",
      "acp.v1.session.prompt.structured_blocks",
      "--cwd",
      directory,
      "--agent-command",
      command,
      "--format",
      "json",
    ]);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(parseReport(result.stdout).totals, { cases: 1, passed: 1, failed: 0 });
    const prompts = (await readProtocolTrace(tracePath)).filter(
      (entry) => entry.direction === "in" && entry.message.method === "session/prompt",
    );
    assert.equal(prompts.length, 1);
    assert.deepEqual(
      prompts[0].message.params?.prompt?.map((block) => block.type),
      ["text", "resource_link"],
    );
  });
}

test("core prompt still rejects a response without the required stop reason", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-prompt-response-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const { command } = await writeProtocolAgent(directory, "omitted", "missing-stop-reason");
  const result = await runRunner([
    "--case",
    "acp.v1.session.prompt.unrecognized",
    "--cwd",
    directory,
    "--agent-command",
    command,
    "--format",
    "json",
  ]);

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  const report = parseReport(result.stdout);
  assert.deepEqual(report.totals, { cases: 1, passed: 0, failed: 1 });
  assert.equal(report.results[0]?.passed, false);
  assert.ok(report.results[0]?.error);
});

test("core unknown-session case accepts the standard resource-not-found error", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-unknown-session-error-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const { command, tracePath } = await writeProtocolAgent(directory, "omitted");
  const result = await runRunner([
    "--case",
    "acp.v1.errors.unknown_session",
    "--cwd",
    directory,
    "--agent-command",
    command,
    "--format",
    "json",
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(parseReport(result.stdout).totals, { cases: 1, passed: 1, failed: 0 });
  const errors = (await readProtocolTrace(tracePath)).filter(
    (entry) => entry.direction === "out" && entry.message.error,
  );
  assert.deepEqual(
    errors.map((entry) => entry.message.error?.code),
    [-32002],
  );
});

test("cancel uses notifications and completes the original prompt response", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cancel-contract-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const { command, tracePath } = await writeProtocolAgent(directory, "omitted", "cancel");
  const { profilePath, casesDir } = await writeFixture(directory, [
    {
      id: "custom.cancel.notification",
      steps: [
        { action: "new_session", save_as: "session_id" },
        {
          action: "prompt_background",
          session: "$session_id",
          prompt: [{ type: "text", text: "Wait for cancellation." }],
          save_as: "active_prompt",
        },
        { action: "cancel", session: "$session_id" },
        { action: "await_background", from: "active_prompt", save_as: "cancel_result" },
        { action: "cancel", session: "$session_id" },
        { action: "new_session", save_as: "after_idle_cancel" },
      ],
      checks: [
        { type: "saved_stop_reason_in", key: "cancel_result", values: ["cancelled"] },
        { type: "saved_non_empty_string", key: "after_idle_cancel" },
      ],
    },
  ]);
  const result = await runRunner([
    "--profile",
    profilePath,
    "--cases-dir",
    casesDir,
    "--cwd",
    directory,
    "--agent-command",
    command,
    "--format",
    "json",
  ]);

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(parseReport(result.stdout).totals, { cases: 1, passed: 1, failed: 0 });
  const trace = await readProtocolTrace(tracePath);
  const cancels = trace.filter(
    (entry) => entry.direction === "in" && entry.message.method === "session/cancel",
  );
  assert.equal(cancels.length, 2);
  assert.equal(
    cancels.every((entry) => !Object.hasOwn(entry.message, "id")),
    true,
  );
  const prompt = trace.find(
    (entry) => entry.direction === "in" && entry.message.method === "session/prompt",
  );
  assert.ok(prompt);
  const completed = trace.filter(
    (entry) => entry.direction === "out" && entry.message.id === prompt.message.id,
  );
  assert.deepEqual(
    completed.map((entry) => entry.message.result?.stopReason),
    ["cancelled"],
  );
  const updates = trace.filter(
    (entry) => entry.direction === "out" && entry.message.method === "session/update",
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].message.params?.update?.sessionUpdate, "agent_message_chunk");
  const responses = trace.filter(
    (entry) => entry.direction === "out" && Object.hasOwn(entry.message, "id"),
  );
  assert.equal(responses.length, 4); // initialize, two sessions, original prompt; no cancel response
});

test("mock retains exact unknown-command output and embedded prompt-block transport", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mock-contract-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const { profilePath, casesDir } = await writeFixture(directory, [
    {
      id: "custom.mock.prompt.unrecognized",
      steps: [
        { action: "new_session", save_as: "session_id" },
        {
          action: "prompt",
          session: "$session_id",
          prompt: [{ type: "text", text: "this-command-does-not-exist" }],
          save_as: "unknown_prompt_result",
        },
      ],
      checks: [
        {
          type: "saved_stop_reason_in",
          key: "unknown_prompt_result",
          values: ["end_turn", "completed", "done"],
        },
        { type: "updates_text_includes", text: "unrecognized prompt" },
      ],
      timeouts: { request_timeout_ms: 10000, update_timeout_ms: 30000 },
    },
    {
      id: "custom.mock.prompt.embedded_blocks",
      steps: [
        { action: "new_session", save_as: "session_id" },
        {
          action: "prompt",
          session: "$session_id",
          prompt: [
            { type: "text", text: "inspect-prompt" },
            {
              type: "resource",
              resource: {
                uri: "file:///tmp/conformance-resource.txt",
                text: "conformance-resource",
              },
            },
          ],
          save_as: "inspect_prompt_result",
        },
      ],
      checks: [
        {
          type: "saved_stop_reason_in",
          key: "inspect_prompt_result",
          values: ["end_turn", "completed", "done"],
        },
        { type: "updates_text_includes", text: '"type":"resource"' },
      ],
      timeouts: { request_timeout_ms: 10000, update_timeout_ms: 30000 },
    },
  ]);
  const result = await runRunner([
    "--profile",
    profilePath,
    "--cases-dir",
    casesDir,
    "--cwd",
    directory,
    "--agent-command",
    MOCK_AGENT_COMMAND,
    "--format",
    "json",
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(parseReport(result.stdout).totals, { cases: 2, passed: 2, failed: 0 });
});

type FilesystemProbeOperation = {
  method: "fs/read_text_file" | "fs/write_text_file";
  path: string;
  content?: string;
};
type FilesystemProbeReceipt = {
  sessionCwd: string;
  agentCwd: string;
  receipts: Array<{
    operation: FilesystemProbeOperation;
    response: { result?: { content?: string }; error?: { code: number; message: string } };
  }>;
};

async function runFilesystemProbe(
  fixtureDir: string,
  cwd: string,
  requests: FilesystemProbeOperation[],
  cleanupSwap?: { source: string; moved: string; target: string },
  permissionMode = "approve-all",
  home?: string,
): Promise<FilesystemProbeReceipt> {
  const receiptPath = path.join(fixtureDir, "filesystem-receipts.json");
  const configPath = path.join(fixtureDir, "filesystem-config.json");
  await fs.writeFile(configPath, JSON.stringify({ receiptPath, requests, cleanupSwap }));
  const { profilePath, casesDir } = await writeFixture(fixtureDir, [
    {
      id: "custom.filesystem.boundary",
      steps: [
        { action: "new_session", save_as: "session_id" },
        {
          action: "prompt",
          session: "$session_id",
          prompt: [{ type: "text", text: "run synthetic filesystem requests" }],
          save_as: "prompt_result",
        },
      ],
      checks: [{ type: "saved_stop_reason_in", key: "prompt_result", values: ["end_turn"] }],
    },
  ]);
  const adapter = fileURLToPath(
    new URL("./fixtures/conformance-filesystem-agent.js", import.meta.url),
  );
  const result = await runRunner(
    [
      "--profile",
      profilePath,
      "--cases-dir",
      casesDir,
      "--cwd",
      cwd,
      "--permission-mode",
      permissionMode,
      "--agent-command",
      [process.execPath, adapter, configPath].map((value) => JSON.stringify(value)).join(" "),
      "--format",
      "json",
    ],
    { home },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parseReport(result.stdout).totals, { cases: 1, passed: 1, failed: 0 });
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as FilesystemProbeReceipt;
  assert.equal(receipt.sessionCwd, cwd);
  assert.equal(receipt.agentCwd, path.resolve(REPO_ROOT));
  assert.equal(receipt.receipts.length, requests.length);
  return receipt;
}

test(
  "runner rejects outside symlink reads and existing/new writes",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-f3-"));
    try {
      const cwd = path.join(tmp, "workspace");
      const outside = path.join(tmp, "outside");
      await fs.mkdir(cwd);
      await fs.mkdir(outside);
      const sentinel = path.join(outside, "existing.txt");
      await fs.writeFile(sentinel, "SYNTHETIC_OUTSIDE_ORIGINAL");
      await fs.symlink(sentinel, path.join(cwd, "file-alias"));
      await fs.symlink(outside, path.join(cwd, "directory-alias"), "dir");
      const receipt = await runFilesystemProbe(tmp, cwd, [
        { method: "fs/read_text_file", path: "file-alias" },
        { method: "fs/read_text_file", path: "directory-alias/existing.txt" },
        { method: "fs/write_text_file", path: "file-alias", content: "bad replacement" },
        {
          method: "fs/write_text_file",
          path: "directory-alias/existing.txt",
          content: "bad replacement",
        },
        {
          method: "fs/write_text_file",
          path: "directory-alias/new/nested.txt",
          content: "bad creation",
        },
      ]);
      for (const { response } of receipt.receipts) {
        assert.equal(response.result, undefined);
        assert.equal(response.error?.code, -32001);
        assert.match(response.error?.message ?? "", /outside session cwd root/i);
      }
      assert.equal(await fs.readFile(sentinel, "utf8"), "SYNTHETIC_OUTSIDE_ORIGINAL");
      await assert.rejects(fs.stat(path.join(outside, "new")), { code: "ENOENT" });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);

test("runner denies filesystem callbacks before creating directories", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-fs-denied-"));
  try {
    const receipt = await runFilesystemProbe(
      tmp,
      tmp,
      [
        { method: "fs/read_text_file", path: "missing.txt" },
        { method: "fs/write_text_file", path: "new/target.txt", content: "DENIED" },
      ],
      undefined,
      "deny-all",
    );
    for (const { response } of receipt.receipts) {
      assert.equal(response.error?.code, -32001);
      assert.match(response.error?.message ?? "", /permission denied/i);
    }
    await assert.rejects(fs.stat(path.join(tmp, "new")), { code: "ENOENT" });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner keeps large reads and refuses writes through hardlinks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-fs-policy-"));
  try {
    const content = "x".repeat(16 * 1024 * 1024 + 1);
    await fs.writeFile(path.join(tmp, "large.txt"), content);
    const original = path.join(tmp, "original.txt");
    const alias = path.join(tmp, "hardlink.txt");
    await fs.writeFile(original, "HARDLINK_ORIGINAL");
    await fs.link(original, alias);
    const receipt = await runFilesystemProbe(tmp, tmp, [
      { method: "fs/read_text_file", path: "large.txt" },
      { method: "fs/read_text_file", path: "hardlink.txt" },
      { method: "fs/write_text_file", path: "hardlink.txt", content: "REJECTED" },
    ]);
    assert.equal(receipt.receipts[0]?.response.result?.content, content);
    assert.equal(receipt.receipts[1]?.response.result?.content, "HARDLINK_ORIGINAL");
    assert.ok(receipt.receipts[2]?.response.error);
    assert.equal(await fs.readFile(original, "utf8"), "HARDLINK_ORIGINAL");
    assert.equal(await fs.readFile(alias, "utf8"), "HARDLINK_ORIGINAL");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

for (const homeLocation of ["root", "inside", "outside"] as const) {
  const relation = homeLocation === "root" ? "equal to" : homeLocation;
  test(`runner cleans literal tilde paths with HOME ${relation} the session root`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-tilde-"));
    try {
      const cwd = path.join(tmp, "workspace");
      const home =
        homeLocation === "root" ? cwd : path.join(homeLocation === "inside" ? cwd : tmp, "home");
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(home, { recursive: true });
      const sentinel = path.join(home, "notes");
      await fs.writeFile(sentinel, "EXISTING_HOME_NOTES");
      const receipt = await runFilesystemProbe(
        tmp,
        cwd,
        [
          { method: "fs/write_text_file", path: "~/notes", content: "LITERAL_TILDE_NOTES" },
          { method: "fs/read_text_file", path: "~/notes" },
        ],
        undefined,
        "approve-all",
        home,
      );
      for (const { response } of receipt.receipts) {
        assert.equal(response.error, undefined);
      }
      assert.equal(receipt.receipts[1]?.response.result?.content, "LITERAL_TILDE_NOTES");
      assert.equal(await fs.readFile(sentinel, "utf8"), "EXISTING_HOME_NOTES");
      await assert.rejects(fs.stat(path.join(cwd, "~", "notes")), { code: "ENOENT" });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
}

test(
  "runner preserves contained aliases and raw parent traversal, and cleans new files",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-f3-control-"));
    try {
      const actualCwd = path.join(tmp, "workspace");
      await fs.mkdir(path.join(actualCwd, "nested", "child"), { recursive: true });
      await fs.mkdir(path.join(actualCwd, "~"));
      await fs.writeFile(path.join(actualCwd, "target.txt"), "ROOT_SENTINEL");
      await fs.writeFile(path.join(actualCwd, "nested", "target.txt"), "NESTED_SENTINEL");
      await fs.writeFile(path.join(actualCwd, "..notes"), "DOT_NAME");
      await fs.writeFile(path.join(actualCwd, "~", "notes"), "LITERAL_TILDE");
      await fs.symlink(
        path.join(actualCwd, "nested", "child"),
        path.join(actualCwd, "alias"),
        "dir",
      );
      await fs.symlink(
        path.join(actualCwd, "nested", "target.txt"),
        path.join(actualCwd, "file-alias"),
      );
      const cwd = path.join(tmp, "cwd-alias");
      await fs.symlink(actualCwd, cwd, "dir");
      const receipt = await runFilesystemProbe(tmp, cwd, [
        { method: "fs/read_text_file", path: "..notes" },
        { method: "fs/read_text_file", path: "~/notes" },
        { method: "fs/read_text_file", path: "nested/../target.txt" },
        { method: "fs/read_text_file", path: `${cwd}/alias/../target.txt` },
        {
          method: "fs/write_text_file",
          path: `${cwd}/alias/../target.txt`,
          content: "UPDATED_NESTED",
        },
        { method: "fs/read_text_file", path: "file-alias" },
        { method: "fs/write_text_file", path: "new-file.txt", content: "NEW_FILE" },
        { method: "fs/read_text_file", path: `${cwd}/new-file.txt` },
      ]);
      for (const { response } of receipt.receipts) {
        assert.equal(response.error, undefined);
      }
      assert.deepEqual(
        receipt.receipts
          .filter(({ operation }) => operation.method === "fs/read_text_file")
          .map(({ response }) => response.result?.content),
        [
          "DOT_NAME",
          "LITERAL_TILDE",
          "ROOT_SENTINEL",
          "NESTED_SENTINEL",
          "UPDATED_NESTED",
          "NEW_FILE",
        ],
      );
      assert.equal(await fs.readFile(path.join(actualCwd, "target.txt"), "utf8"), "ROOT_SENTINEL");
      // Existing-file restoration is separate from callback root confinement.
      assert.equal(
        await fs.readFile(path.join(actualCwd, "nested", "target.txt"), "utf8"),
        "UPDATED_NESTED",
      );
      await assert.rejects(fs.stat(path.join(actualCwd, "new-file.txt")), { code: "ENOENT" });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "runner cleanup cannot be redirected through a replaced parent to an outside file",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-f3-cleanup-"));
    try {
      const cwd = path.join(tmp, "workspace");
      const outside = path.join(tmp, "outside");
      await fs.mkdir(cwd);
      await fs.mkdir(outside);
      const outsideFile = path.join(outside, "file.txt");
      await fs.writeFile(outsideFile, "OUTSIDE_CLEANUP_SENTINEL");
      const receipt = await runFilesystemProbe(
        tmp,
        cwd,
        [
          { method: "fs/write_text_file", path: "created/file.txt", content: "OWNED_NEW_FILE" },
          { method: "fs/read_text_file", path: "created/file.txt" },
        ],
        {
          source: path.join(cwd, "created"),
          moved: path.join(cwd, "moved-created"),
          target: outside,
        },
      );
      for (const { response } of receipt.receipts) {
        assert.equal(response.error, undefined);
      }
      assert.equal(receipt.receipts[1]?.response.result?.content, "OWNED_NEW_FILE");
      assert.equal(await fs.readFile(outsideFile, "utf8"), "OUTSIDE_CLEANUP_SENTINEL");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);
