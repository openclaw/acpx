import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultSessionEventLog } from "../src/session-event-log.js";
import { SessionEventWriter, listSessionEvents } from "../src/session-events.js";
import {
  resolveSessionRecord,
  writeSessionRecord,
} from "../src/session-persistence.js";
import { ACPX_EVENT_TYPES, type SessionRecord } from "../src/types.js";

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-events-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    await run(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function makeSessionRecord(
  sessionId: string,
  cwd: string,
  maxSegments: number,
): SessionRecord {
  const now = "2026-02-28T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: sessionId,
    agentCommand: "npx @zed-industries/codex-acp",
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: {
      ...defaultSessionEventLog(sessionId),
      max_segments: maxSegments,
      segment_count: 1,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}

test("listSessionEvents reads all configured event segments", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-events-max-window";
    const record = makeSessionRecord(sessionId, cwd, 7);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record, {
      maxSegmentBytes: 1,
      maxSegments: 7,
    });

    for (let index = 0; index < 8; index += 1) {
      await writer.appendDraft({
        type: ACPX_EVENT_TYPES.UPDATE,
        data: {
          update: `event-${index + 1}`,
        },
      });
    }
    await writer.close({ checkpoint: true });

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 8);
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });
});

test("SessionEventWriter stores actual segment_count instead of max_segments", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-events-segment-count";
    const record = makeSessionRecord(sessionId, cwd, 7);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record, {
      maxSegmentBytes: 1,
      maxSegments: 7,
    });

    await writer.appendDraft({
      type: ACPX_EVENT_TYPES.UPDATE,
      data: {
        update: "first",
      },
    });
    assert.equal(writer.getRecord().eventLog.segment_count, 1);

    await writer.appendDraft({
      type: ACPX_EVENT_TYPES.UPDATE,
      data: {
        update: "second",
      },
    });
    assert.equal(writer.getRecord().eventLog.segment_count, 2);

    await writer.appendDraft({
      type: ACPX_EVENT_TYPES.UPDATE,
      data: {
        update: "third",
      },
    });
    assert.equal(writer.getRecord().eventLog.segment_count, 3);

    await writer.close({ checkpoint: true });

    const stored = await resolveSessionRecord(sessionId);
    assert.equal(stored.eventLog.segment_count, 3);
    assert.equal(stored.eventLog.max_segments, 7);
  });
});
