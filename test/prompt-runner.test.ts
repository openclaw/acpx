import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "../src/cli/session/prompt-runner.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import type { SessionRecord } from "../src/types.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

test("runSessionSetModeDirect resumes a load-capable session and closes the client once", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-resume",
      acpSessionId: "prompt-runner-resume-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });
    await writeSessionRecord(homeDir, record);

    let clientAvailableCalls = 0;
    let clientClosedCalls = 0;
    let controllerOperations: Promise<unknown> | undefined;

    const result = await runSessionSetModeDirect({
      sessionRecordId: record.acpxRecordId,
      modeId: "review",
      timeoutMs: 5_000,
      onClientAvailable: (controller) => {
        clientAvailableCalls += 1;
        controllerOperations = Promise.all([
          controller.setSessionMode("preload"),
          controller.setSessionConfigOption("reasoning_effort", "high"),
        ]);
      },
      onClientClosed: () => {
        clientClosedCalls += 1;
      },
    });
    await controllerOperations;

    assert.equal(result.resumed, true);
    assert.equal(result.loadError, undefined);
    assert.equal(clientAvailableCalls, 1);
    assert.equal(clientClosedCalls, 1);
    assert.equal(result.record.closed, false);
    assert.equal(result.record.closedAt, undefined);
    assert.equal(result.record.acpSessionId, record.acpSessionId);
    assert.equal(result.record.protocolVersion, 1);

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpSessionId, record.acpSessionId);
    assert.equal(persisted.closed, false);
    assert.equal(persisted.protocolVersion, 1);
    assert.equal(typeof persisted.lastUsedAt, "string");
  });
});

test("runSessionSetConfigOptionDirect falls back to createSession and returns updated options", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-config",
      acpSessionId: "stale-session-id",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --load-session-fails-on-empty`,
      cwd,
      messages: [],
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetConfigOptionDirect({
      sessionRecordId: record.acpxRecordId,
      configId: "reasoning_effort",
      value: "high",
      timeoutMs: 5_000,
    });

    assert.equal(result.resumed, false);
    assert.match(result.loadError ?? "", /internal error/i);
    assert.notEqual(result.record.acpSessionId, "stale-session-id");
    assert.deepEqual(result.response.configOptions, [
      {
        id: "mode",
        name: "Session Mode",
        category: "mode",
        type: "select",
        currentValue: "auto",
        options: [
          {
            value: "read-only",
            name: "Read Only",
          },
          {
            value: "auto",
            name: "Default",
          },
          {
            value: "full-access",
            name: "Full Access",
          },
          {
            value: "plan",
            name: "Plan",
          },
          {
            value: "default",
            name: "Default",
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default-model",
        options: [
          {
            value: "default",
            name: "Default",
          },
          {
            value: "gpt-5.4",
            name: "gpt-5.4",
          },
          {
            value: "gpt-5.2",
            name: "gpt-5.2",
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          {
            value: "low",
            name: "Low",
          },
          {
            value: "medium",
            name: "Medium",
          },
          {
            value: "high",
            name: "High",
          },
          {
            value: "xhigh",
            name: "Xhigh",
          },
        ],
      },
    ]);

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpSessionId, result.record.acpSessionId);
    assert.equal(persisted.protocolVersion, 1);
    assert.equal(persisted.closed, false);
  });
});

test("runSessionSetModelDirect updates current and desired model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-model",
      acpSessionId: "prompt-runner-model-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --advertise-models`,
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetModelDirect({
      sessionRecordId: record.acpxRecordId,
      modelId: "gpt-5.4",
      timeoutMs: 5_000,
    });

    assert.equal(result.resumed, true);
    assert.equal(result.record.acpx?.current_model_id, "gpt-5.4");
    assert.equal(result.record.acpx?.session_options?.model, "gpt-5.4");

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpx?.current_model_id, "gpt-5.4");
    assert.equal(persisted.acpx?.session_options?.model, "gpt-5.4");
  });
});

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    cwd: path.resolve(overrides.cwd),
    name: overrides.name,
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: overrides.lastSeq ?? 0,
    lastRequestId: overrides.lastRequestId,
    eventLog: overrides.eventLog ?? {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    pid: overrides.pid,
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    protocolVersion: overrides.protocolVersion,
    agentCapabilities: overrides.agentCapabilities,
    title: overrides.title ?? null,
    messages: overrides.messages ?? [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: overrides.cumulative_token_usage ?? {},
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx,
  };
}

async function writeSessionRecord(homeDir: string, record: SessionRecord): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `${encodeURIComponent(record.acpxRecordId)}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-prompt-runner-home-"));
  process.env.HOME = homeDir;

  try {
    await run(homeDir);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
