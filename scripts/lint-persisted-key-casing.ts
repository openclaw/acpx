import assert from "node:assert/strict";
import { findPersistedKeyPolicyViolations } from "../src/persisted-key-policy.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "lint-record",
    acpSessionId: "lint-session",
    agentSessionId: "agent-session",
    agentCommand: "npx -y @agentclientprotocol/codex-acp",
    cwd: "/tmp/lint",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: {
      active_path: "/tmp/lint-record.events.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: undefined,
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

function assertSerializationPolicy(): void {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(
    violations.length,
    0,
    `serializeSessionRecordForDisk emitted non-snake keys: ${violations.join(", ")}`,
  );

  const requiredTopLevel = [
    "schema",
    "acpx_record_id",
    "acp_session_id",
    "agent_session_id",
    "agent_command",
    "cwd",
    "created_at",
    "last_used_at",
    "last_seq",
    "event_log",
    "title",
    "messages",
    "updated_at",
    "cumulative_token_usage",
    "request_token_usage",
  ];

  for (const key of requiredTopLevel) {
    assert.equal(
      key in persisted,
      true,
      `serialized session record is missing required key: ${key}`,
    );
  }
}

assertSerializationPolicy();
