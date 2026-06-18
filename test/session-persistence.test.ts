import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  fileExists,
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);

test("SessionRecord allows optional closed and closedAt fields", () => {
  const record = makeSessionRecord({
    acpxRecordId: "type-check",
    acpSessionId: "type-check",
    agentCommand: "agent",
    cwd: "/tmp/type-check",
  });

  assert.equal(record.closed, false);
  assert.equal(record.closedAt, undefined);
});

test("parseSessionRecord preserves persisted session env", () => {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "session-env-options",
      acpSessionId: "session-env-options",
      agentCommand: "agent",
      cwd: "/tmp/session-env-options",
      acpx: {
        session_options: {
          env: {
            GIT_AUTHOR_EMAIL: "agent@example.local",
          },
        },
      },
    }),
  );
  const acpx = serialized.acpx as Record<string, unknown>;
  const sessionOptions = acpx.session_options as { env: Record<string, unknown> };
  sessionOptions.env.IGNORED_NON_STRING = 123;

  const parsed = parseSessionRecord(serialized);

  assert.ok(parsed);
  assert.deepEqual(parsed.acpx?.session_options?.env, {
    GIT_AUTHOR_EMAIL: "agent@example.local",
  });
});

test("parseSessionRecord ignores malformed config options during model-control migration", () => {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "malformed-config-options",
      acpSessionId: "malformed-config-options",
      agentCommand: "agent",
      cwd: "/tmp/malformed-config-options",
      acpx: {
        current_model_id: "legacy-model",
        available_models: ["legacy-model"],
      },
    }),
  );
  const acpx = serialized.acpx as Record<string, unknown>;
  acpx.config_options = [null];
  delete acpx.model_control;

  const parsed = parseSessionRecord(serialized);

  assert.ok(parsed);
  assert.equal(parsed.acpx?.config_options, undefined);
  assert.equal(parsed.acpx?.model_control, "legacy_set_model");
});

test("listSessions preserves acpx desired_mode_id", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "desired-mode",
        acpSessionId: "desired-mode",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          desired_mode_id: "plan",
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "desired-mode");
    assert.ok(record);
    assert.equal(record.acpx?.desired_mode_id, "plan");
  });
});

test("listSessions preserves acpx desired_config_options", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "desired-config-options",
        acpSessionId: "desired-config-options",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          desired_config_options: {
            reasoning_effort: "high",
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "desired-config-options");
    assert.ok(record);
    assert.deepEqual(record.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
  });
});

test("listSessions migrates persisted legacy model control", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "legacy-model-control",
        acpSessionId: "legacy-model-control",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          current_model_id: "legacy-model",
          available_models: ["legacy-model"],
          config_options: [],
        },
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "config-model-control",
        acpSessionId: "config-model-control",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          current_model_id: "config-model",
          available_models: ["config-model"],
          config_options: [
            {
              id: "llm",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "config-model",
              options: [{ value: "config-model", name: "Config Model" }],
            },
          ],
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "legacy-model-control");
    assert.ok(record);
    assert.equal(record.acpx?.model_control, "legacy_set_model");
    const configRecord = sessions.find((entry) => entry.acpxRecordId === "config-model-control");
    assert.ok(configRecord);
    assert.equal(configRecord.acpx?.model_control, "config_option");
  });
});

test("listSessions preserves acpx reset_on_next_ensure", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "reset-on-next-ensure",
        acpSessionId: "reset-on-next-ensure",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          reset_on_next_ensure: true,
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "reset-on-next-ensure");
    assert.ok(record);
    assert.equal(record.acpx?.reset_on_next_ensure, true);
  });
});

test("listSessions preserves acpx session_options", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-options",
        acpSessionId: "session-options",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            model: "sonnet",
            allowed_tools: ["Read", "Grep"],
            max_turns: 7,
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-options");
    assert.ok(record);
    assert.deepEqual(record.acpx?.session_options, {
      model: "sonnet",
      allowed_tools: ["Read", "Grep"],
      max_turns: 7,
    });
  });
});

test("listSessions preserves acpx session_options system_prompt string and append", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-system-prompt-string",
        acpSessionId: "session-system-prompt-string",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            system_prompt: "you are an obsidian assistant",
          },
        },
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-system-prompt-append",
        acpSessionId: "session-system-prompt-append",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            system_prompt: { append: "always speak in spanish" },
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const stringRecord = sessions.find(
      (entry) => entry.acpxRecordId === "session-system-prompt-string",
    );
    const appendRecord = sessions.find(
      (entry) => entry.acpxRecordId === "session-system-prompt-append",
    );
    assert.ok(stringRecord);
    assert.ok(appendRecord);
    assert.equal(
      stringRecord.acpx?.session_options?.system_prompt,
      "you are an obsidian assistant",
    );
    assert.deepEqual(appendRecord.acpx?.session_options?.system_prompt, {
      append: "always speak in spanish",
    });
  });
});

test("listSessions ignores unsupported conversation message shapes", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });

    const malformed = makeSessionRecord({
      acpxRecordId: "malformed-shape",
      acpSessionId: "malformed-shape",
      agentCommand: "agent",
      cwd: path.join(homeDir, "workspace"),
    });

    (malformed as unknown as Record<string, unknown>).messages = [
      {
        kind: "user",
        id: "user_1",
        content: [{ type: "text", text: "invalid" }],
      },
    ];

    await fs.writeFile(
      path.join(sessionDir, "malformed-shape.json"),
      JSON.stringify(serializeSessionRecordForDisk(malformed), null, 2) + "\n",
      "utf8",
    );

    const session = await loadSessionModule();
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "malformed-shape"),
      false,
    );
  });
});

test("listSessions preserves lifecycle and conversation metadata", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-a",
        acpSessionId: "session-a",
        agentCommand: "agent-a",
        cwd,
        pid: 12345,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:01:00.000Z",
        lastAgentExitCode: null,
        lastAgentExitSignal: "SIGTERM",
        lastAgentExitAt: "2026-01-01T00:02:00.000Z",
        lastAgentDisconnectReason: "process_exit",
        title: "My Thread",
        messages: [
          {
            User: {
              id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
              content: [
                { Text: "hello" },
                { Audio: { source: "UklGRg==", mime_type: "audio/wav" } },
              ],
            },
          },
          {
            Agent: {
              content: [{ Text: "world" }],
              tool_results: {},
            },
          },
        ],
        updated_at: "2026-01-01T00:02:00.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-a");
    assert.ok(record);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.lastPromptAt, "2026-01-01T00:01:00.000Z");
    assert.equal(record.lastAgentExitCode, null);
    assert.equal(record.lastAgentExitSignal, "SIGTERM");
    assert.equal(record.lastAgentExitAt, "2026-01-01T00:02:00.000Z");
    assert.equal(record.lastAgentDisconnectReason, "process_exit");
    assert.equal(record.messages.length, 2);
    assert.deepEqual(record.messages[0], {
      User: {
        id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
        content: [{ Text: "hello" }, { Audio: { source: "UklGRg==", mime_type: "audio/wav" } }],
      },
    });
    assert.equal(record.title, "My Thread");
  });
});

test("listSessions preserves optional agentSessionId", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-runtime",
        acpSessionId: "session-runtime",
        agentSessionId: "provider-runtime-123",
        agentCommand: "agent-a",
        cwd,
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-runtime");
    assert.ok(record);
    assert.equal(record.agentSessionId, "provider-runtime-123");
  });
});

test("findSession and findSessionByDirectoryWalk resolve expected records", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const packagesDir = path.join(repoRoot, "packages");
    const nestedDir = path.join(packagesDir, "app");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-root",
        acpSessionId: "session-root",
        agentCommand: "agent-a",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-packages",
        acpSessionId: "session-packages",
        agentCommand: "agent-a",
        cwd: packagesDir,
      }),
    );

    const foundDefault = await session.findSession({
      agentCommand: "agent-a",
      cwd: packagesDir,
    });
    assert.equal(foundDefault?.acpxRecordId, "session-packages");

    const boundary = session.findGitRepositoryRoot(nestedDir);
    const walked = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary,
    });
    assert.equal(walked?.acpxRecordId, "session-packages");
  });
});

test("writeSessionRecord maintains an index and listSessions rebuilds it when missing", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "repo");
    const record = makeSessionRecord({
      acpxRecordId: "indexed-session",
      acpSessionId: "indexed-session",
      agentCommand: "agent-a",
      cwd,
    });

    const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");
    await writeSessionRecord(homeDir, record);
    assert.equal(await fileExists(indexPath), false);

    const initialSessions = await session.listSessions();
    assert.equal(
      initialSessions.some((entry) => entry.acpxRecordId === "indexed-session"),
      true,
    );
    assert.equal(await fileExists(indexPath), true);

    await fs.rm(indexPath, { force: true });
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "indexed-session"),
      true,
    );
    assert.equal(await fileExists(indexPath), true);
  });
});

test("closeSession soft-closes and terminates matching process", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    const sessionId = "live-session";
    const cwd = path.join(homeDir, "repo");
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: process.execPath,
        cwd,
        pid: child.pid,
      }),
    );

    const filePath = sessionFilePath(homeDir, sessionId);

    try {
      const closed = await session.closeSession(sessionId);
      assert.equal(closed.closed, true);
      assert.equal(typeof closed.closedAt, "string");
      assert.equal(closed.pid, undefined);
      assert.equal(await fileExists(filePath), true);

      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      assert.equal(stored.closed, true);
      assert.equal(typeof stored.closed_at, "string");

      const exited = await waitForExit(child.pid);
      assert.equal(exited, true);
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }
  });
});

test("normalizeQueueOwnerTtlMs applies default and edge-case normalization", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    assert.equal(session.normalizeQueueOwnerTtlMs(undefined), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(session.normalizeQueueOwnerTtlMs(0), 0);
    assert.equal(session.normalizeQueueOwnerTtlMs(-1), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(session.normalizeQueueOwnerTtlMs(Number.NaN), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.POSITIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.NEGATIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(session.normalizeQueueOwnerTtlMs(1.6), 2);
    assert.equal(session.normalizeQueueOwnerTtlMs(15_000), 15_000);
  });
});

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?session_test=${cacheBuster}`)) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-test-home-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

async function waitForExit(pid: number | undefined): Promise<boolean> {
  if (pid == null) {
    return true;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  return false;
}
