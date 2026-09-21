import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import { SessionJournalReader, type SessionWatchEvent } from "../src/session/journal.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const AGENT_COMMAND = "acpx-watch-fixture-agent-must-not-launch";

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

async function runCli(home: string, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ACPX_QUEUE_OWNER_ARGS;
  delete env.ACPX_PERF_METRICS_FILE;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "--cwd", home, "--format", "json", ...args], {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Closed journals exit naturally; this only bounds an unexpected hang.
      timeout: 30_000,
      killSignal: "SIGKILL",
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
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function saveClosedJournal(home: string, name?: string): Promise<string> {
  const label = name ?? "default";
  const id = `watch-${label}`;
  const record = makeSessionRecord(
    {
      acpxRecordId: id,
      acpSessionId: `provider-${label}`,
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
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: record.acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `saved-${label}-output` },
        },
      },
    });
    await writer.finishTurn(id, { status: "completed", stopReason: "end_turn" });
  } finally {
    await writer.close();
  }
  const replay = await new SessionJournalReader(record).read();
  assert.equal(replay.events.length, 3);
  return replay.events[0].cursor;
}

async function fixture(run: (home: string, parentCursor: string) => Promise<void>): Promise<void> {
  await withTempHome("acpx-cli-watch-precedence-", async (home) => {
    await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".acpx", "config.json"),
      JSON.stringify({ agents: { codex: { command: AGENT_COMMAND } } }),
    );
    await saveClosedJournal(home);
    const parentCursor = await saveClosedJournal(home, "parent");
    await saveClosedJournal(home, "selected");
    await run(home, parentCursor);
  });
}

function assertReplay(result: CliResult, name: string, afterStarted = false): void {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionWatchEvent);
  assert.deepEqual(
    rows.map((event) => [event.type, event.requestId]),
    [
      ...(!afterStarted ? [["turn_started", `watch-${name}`]] : []),
      ["message", `watch-${name}`],
      ["turn_result", `watch-${name}`],
    ],
  );
  const message = rows.find((event) => event.type === "message");
  assert.ok(message?.type === "message");
  assert.deepEqual(message.message, {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: `provider-${name}`,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `saved-${name}-output` },
      },
    },
  });
}

for (const parentFlag of ["-s", "--session"]) {
  test(`watch inherits the parent ${parentFlag} named closed journal`, async () => {
    await fixture(async (home) => {
      const result = await runCli(home, ["codex", parentFlag, "parent", "sessions", "watch"]);
      assertReplay(result, "parent");
    });
  });
}

for (const watchFlag of ["-s", "--name"]) {
  test(`explicit watch ${watchFlag} overrides a different parent session`, async () => {
    await fixture(async (home) => {
      const result = await runCli(home, [
        "codex",
        "--session",
        "parent",
        "sessions",
        "watch",
        watchFlag,
        "selected",
      ]);
      assertReplay(result, "selected");
    });
  });
}

for (const localOverride of [false, true]) {
  test(`watch missing-name diagnostic uses ${localOverride ? "explicit" : "inherited"} selection`, async () => {
    await fixture(async (home) => {
      const result = await runCli(home, [
        "codex",
        "-s",
        localOverride ? "parent" : "missing-parent",
        "sessions",
        "watch",
        ...(localOverride ? ["--name", "missing-watch"] : []),
      ]);
      assert.equal(result.signal, null, result.stderr);
      assert.notEqual(result.code, 0);
      const payload = JSON.parse(result.stdout.trim()) as { error: { message: string } };
      assert.equal(
        payload.error.message,
        `No named session "${localOverride ? "missing-watch" : "missing-parent"}" for cwd ${home} and agent codex`,
      );
    });
  });
}

test("watch does not inherit the sessions-list cursor", async () => {
  await fixture(async (home) => {
    const result = await runCli(home, [
      "codex",
      "sessions",
      "--cursor",
      "invalid-watch-cursor!",
      "watch",
      "--name",
      "parent",
    ]);
    assertReplay(result, "parent");
  });
});

test("watch uses its own cursor when sessions also has a different cursor", async () => {
  await fixture(async (home, parentCursor) => {
    const result = await runCli(home, [
      "codex",
      "sessions",
      "--cursor",
      "invalid-watch-cursor!",
      "watch",
      "--name",
      "parent",
      "--cursor",
      parentCursor,
    ]);
    assertReplay(result, "parent", true);
  });
});

test("watch without a selector replays the default closed journal", async () => {
  await fixture(async (home) => {
    assertReplay(await runCli(home, ["codex", "sessions", "watch"]), "default");
  });
});

test("watch rejects another journal's cursor instead of changing selected session", async () => {
  await fixture(async (home, parentCursor) => {
    const result = await runCli(home, [
      "codex",
      "--session",
      "parent",
      "sessions",
      "watch",
      "--name",
      "selected",
      "--cursor",
      parentCursor,
    ]);
    assert.equal(result.code, 2);
    const payload = JSON.parse(result.stdout.trim()) as { error: { message: string } };
    assert.equal(payload.error.message, "Cursor belongs to another session");
    assert.doesNotMatch(result.stdout, /saved-parent-output|saved-selected-output/);
  });
});
