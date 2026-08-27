import path from "node:path";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeHandle,
  type AcpSessionRecord,
} from "../src/runtime.js";

const [mode, stateDir, mockAgentPath] = process.argv.slice(2);
if (!mode || !stateDir) {
  throw new Error("usage: runtime-retirement-process <seed|retire|ensure> <state-dir> [agent]");
}

const sessionKey = "process-retirement";
const store = createFileSessionStore({ stateDir });
const handle: AcpRuntimeHandle = {
  sessionKey,
  backend: "acpx",
  runtimeSessionName: sessionKey,
  acpxRecordId: sessionKey,
};

if (mode === "seed") {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const record: AcpSessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: sessionKey,
    acpSessionId: "stale-backend-session",
    agentCommand: "fixture",
    cwd: stateDir,
    name: sessionKey,
    createdAt: timestamp,
    lastUsedAt: timestamp,
    lastSeq: 0,
    eventLog: {
      active_path: "",
      segment_count: 0,
      max_segment_bytes: 0,
      max_segments: 0,
      last_write_at: timestamp,
      last_write_error: null,
    },
    closed: false,
    messages: [],
    updated_at: timestamp,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
  await store.save(record);
  process.stdout.write(
    `${JSON.stringify({ phase: mode, backendSessionId: record.acpSessionId })}\n`,
  );
} else {
  const runtime = createAcpRuntime({
    cwd: stateDir,
    sessionStore: store,
    agentRegistry: createAgentRegistry({
      overrides: mockAgentPath
        ? {
            fixture: [process.execPath, path.resolve(mockAgentPath)],
          }
        : undefined,
    }),
    permissionMode: "approve-reads",
  });

  if (mode === "retire") {
    await runtime.prepareFreshSession(handle);
    process.stdout.write(`${JSON.stringify({ phase: mode })}\n`);
  } else if (mode === "ensure") {
    if (!mockAgentPath) {
      throw new Error("ensure requires a mock-agent path");
    }
    const freshHandle = await runtime.ensureSession({
      sessionKey,
      agent: "fixture",
      mode: "persistent",
    });
    process.stdout.write(
      `${JSON.stringify({
        phase: mode,
        backendSessionId: freshHandle.backendSessionId,
        acpxRecordId: freshHandle.acpxRecordId,
      })}\n`,
    );
    await runtime.close({ handle: freshHandle, reason: "process proof complete" });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
}
