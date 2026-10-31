import assert from "node:assert/strict";
import test from "node:test";
import {
  getDesiredModeId,
  normalizeModeId,
  setDesiredModeId,
} from "../src/session/mode-preference.js";
import type { SessionRecord } from "../src/types.js";

test("normalizeModeId trims valid values and drops blanks", () => {
  assert.equal(normalizeModeId(" plan "), "plan");
  assert.equal(normalizeModeId(""), undefined);
  assert.equal(normalizeModeId("   "), undefined);
  assert.equal(normalizeModeId(undefined), undefined);
});

test("getDesiredModeId reads normalized desired_mode_id", () => {
  assert.equal(getDesiredModeId({ desired_mode_id: " auto " }), "auto");
  assert.equal(getDesiredModeId({ desired_mode_id: "   " }), undefined);
  assert.equal(getDesiredModeId(undefined), undefined);
});

test("setDesiredModeId creates and clears acpx mode preference state", () => {
  const record = makeSessionRecord();

  setDesiredModeId(record, " plan ");
  assert.deepEqual(record.acpx, {
    desired_mode_id: "plan",
  });

  setDesiredModeId(record, "   ");
  assert.deepEqual(record.acpx, {});

  setDesiredModeId(record, undefined);
  assert.deepEqual(record.acpx, {});
});

function makeSessionRecord(): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "mode-record",
    acpSessionId: "mode-session",
    agentCommand: "agent",
    cwd: "/tmp/acpx",
    createdAt: timestamp,
    lastUsedAt: timestamp,
    lastSeq: 0,
    eventLog: {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: timestamp,
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: timestamp,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}
