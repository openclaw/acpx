import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = path.resolve("dist/cli.js");
const AGENT_COMMAND = "acpx-watch-suppress-agent-must-not-launch";
const SECRET = "SYNTHETIC_FILE_BODY";
const SUPPRESSED = "[read output suppressed]";

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function readRequest(id: number): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "fs/read_text_file",
    params: { sessionId: "provider-watch", path: "/synthetic/file" },
  };
}

function modeRequest(id: number): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_mode",
    params: { sessionId: "provider-watch", modeId: "plan" },
  };
}

function readResponse(id: number): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: SECRET },
  };
}

function modeResponse(id: number): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {},
  };
}

type JournalOrder = {
  requests: "read-first" | "other-first";
  responses: "read-first" | "other-first";
};

const READ_FIRST: JournalOrder = { requests: "read-first", responses: "read-first" };

async function saveJournal(
  home: string,
  name: string,
  readId: number,
  modeId: number,
  order: JournalOrder,
): Promise<void> {
  const id = `watch-${name}`;
  const record = makeSessionRecord(
    {
      acpxRecordId: id,
      acpSessionId: "provider-watch",
      agentCommand: AGENT_COMMAND,
      cwd: home,
      name,
      closed: true,
      closedAt: "2026-01-02T00:00:00.000Z",
      eventLog: { ...defaultSessionEventLog(id), segment_count: 1 },
    },
    { defaultName: false },
  );
  await writeSessionRecord(record);
  const writer = await SessionEventWriter.open(record);
  try {
    await writer.beginTurn(id);
    // Two same-id requests are in flight at once. The journal does not store
    // direction, so watch replays them under one correlation key.
    const requests =
      order.requests === "read-first"
        ? [readRequest(readId), modeRequest(modeId)]
        : [modeRequest(modeId), readRequest(readId)];
    const responses =
      order.responses === "read-first"
        ? [readResponse(readId), modeResponse(modeId)]
        : [modeResponse(modeId), readResponse(readId)];
    for (const message of [...requests, ...responses]) {
      await writer.appendMessage(message);
    }
    await writer.finishTurn(id, { status: "completed", stopReason: "end_turn" });
  } finally {
    await writer.close();
  }
}

async function watch(home: string, name: string): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ACPX_QUEUE_OWNER_ARGS;
  delete env.ACPX_PERF_METRICS_FILE;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        "--cwd",
        home,
        "--format",
        "json",
        "--suppress-reads",
        "codex",
        "sessions",
        "watch",
        "-s",
        name,
      ],
      {
        cwd: home,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
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
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function withFixture(
  name: string,
  readId: number,
  modeId: number,
  run: (home: string) => Promise<void>,
  order: JournalOrder = READ_FIRST,
): Promise<void> {
  await withTempHome("acpx-watch-suppress-", async (home) => {
    await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".acpx", "config.json"),
      JSON.stringify({ agents: { codex: { command: AGENT_COMMAND } } }),
    );
    await saveJournal(home, name, readId, modeId, order);
    await run(home);
  });
}

test("sessions watch --suppress-reads hides a read result when another method reuses its JSON-RPC id", async () => {
  await withFixture("colliding", 7, 7, async (home) => {
    const result = await watch(home, "colliding");
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes(SECRET), false, result.stdout);
    assert.equal(result.stdout.includes(SUPPRESSED), true, result.stdout);
  });
});

test("sessions watch --suppress-reads still hides a read result when JSON-RPC ids do not collide", async () => {
  await withFixture("distinct", 7, 8, async (home) => {
    const result = await watch(home, "distinct");
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes(SECRET), false, result.stdout);
    assert.equal(result.stdout.includes(SUPPRESSED), true, result.stdout);
  });
});

for (const order of [
  { requests: "read-first", responses: "other-first" },
  { requests: "other-first", responses: "read-first" },
  { requests: "other-first", responses: "other-first" },
] as const) {
  test(`sessions watch --suppress-reads hides a colliding read result (requests ${order.requests}, responses ${order.responses})`, async () => {
    await withFixture(
      `colliding-${order.requests}-${order.responses}`,
      7,
      7,
      async (home) => {
        const result = await watch(home, `colliding-${order.requests}-${order.responses}`);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout.includes(SECRET), false, result.stdout);
        assert.equal(result.stdout.includes(SUPPRESSED), true, result.stdout);
      },
      order,
    );
  });
}
