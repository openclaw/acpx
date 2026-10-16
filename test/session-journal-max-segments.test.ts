import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  MAX_EVENT_SEGMENTS,
  sessionBaseDir,
  sessionEventActivePath,
  sessionEventSegmentPath,
} from "../src/session/event-log.js";
import { listSessionEvents, SessionEventWriter } from "../src/session/events.js";
import {
  SESSION_JOURNAL_SCHEMA,
  SessionJournalReader,
  watchSession,
} from "../src/session/journal.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

function message(label: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { label } });
}

function labelOf(value: AcpJsonRpcMessage): unknown {
  const params: unknown = "params" in value ? value.params : undefined;
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>).label
    : undefined;
}

test(
  "journal read keeps saved segments above the import cap without walking every index",
  { timeout: 20_000 },
  async () => {
    await withTempHome("acpx-journal-cap-", async () => {
      const id = "cap-record";
      const record = makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: "provider",
        agentCommand: "synthetic-unused-agent",
        cwd: "/tmp",
        eventLog: {
          active_path: ".stream.ndjson",
          segment_count: 1,
          max_segment_bytes: 1024,
          max_segments: 100_000_000,
        },
      });
      await fs.mkdir(sessionBaseDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        sessionEventSegmentPath(id, MAX_EVENT_SEGMENTS),
        `${message("at-cap")}\n`,
        {
          mode: 0o600,
        },
      );
      await fs.writeFile(
        sessionEventSegmentPath(id, MAX_EVENT_SEGMENTS + 1),
        `${message("above-cap")}\n`,
        { mode: 0o600 },
      );

      const started = Date.now();
      const retained = await new SessionJournalReader(record).readAcpMessages();
      assert.ok(Date.now() - started < 5_000);
      assert.deepEqual(retained.map(labelOf), ["above-cap", "at-cap"]);

      await fs.writeFile(sessionEventSegmentPath(id, 1026), `${message("past-saved")}\n`, {
        mode: 0o600,
      });
      const savedCap = await new SessionJournalReader({
        ...record,
        eventLog: { ...record.eventLog, max_segments: MAX_EVENT_SEGMENTS + 1 },
      }).readAcpMessages();
      assert.deepEqual(savedCap.map(labelOf), ["above-cap", "at-cap"]);

      await fs.writeFile(sessionEventSegmentPath(id, 2), `${message("low")}\n`, { mode: 0o600 });
      const small = await new SessionJournalReader({
        ...record,
        eventLog: { ...record.eventLog, max_segments: 2 },
      }).readAcpMessages();
      assert.deepEqual(small.map(labelOf), ["low"]);
    });
  },
);

for (const savedMaxSegments of [
  MAX_EVENT_SEGMENTS + 1,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_VALUE,
]) {
  test(`writer restart preserves saved retention ${savedMaxSegments}`, async () => {
    await withTempHome("acpx-journal-retain-", async () => {
      const id = "retain-1025";
      const record = makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: "provider",
        agentCommand: "synthetic-unused-agent",
        cwd: "/tmp",
        lastSeq: 1,
        eventLog: {
          active_path: sessionEventActivePath(id),
          segment_count: 2,
          max_segment_bytes: 64,
          max_segments: savedMaxSegments,
        },
      });
      await writeSessionRecord(record);
      await fs.writeFile(
        sessionEventSegmentPath(id, MAX_EVENT_SEGMENTS),
        `${message("kept-above-cap")}\n`,
        {
          mode: 0o600,
        },
      );
      await fs.writeFile(sessionEventActivePath(id), "not-json\n", { mode: 0o600 });

      const retained = await new SessionJournalReader(record).readAcpMessages();
      assert.deepEqual(retained.map(labelOf), ["kept-above-cap"]);

      const writer = await SessionEventWriter.open(record, { maxSegmentBytes: 64 });
      await writer.appendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: { label: "fresh" },
      } as never);
      await writer.close({ checkpoint: true });

      const stored = await resolveSessionRecord(id);
      assert.equal(stored.eventLog.max_segments, savedMaxSegments);
      const moved = await fs.readFile(sessionEventSegmentPath(id, MAX_EVENT_SEGMENTS + 1), "utf8");
      assert.match(moved, /kept-above-cap/);
      const events = await listSessionEvents(id);
      assert.deepEqual(events.map(labelOf), ["kept-above-cap", "fresh"]);
    });
  });
}

test("writer rejects an unrepresentable next segment before changing journal files", async () => {
  await withTempHome("acpx-journal-index-limit-", async () => {
    const id = "index-limit";
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: "provider",
      agentCommand: "synthetic-unused-agent",
      cwd: "/tmp",
      lastSeq: 1,
      eventLog: {
        active_path: sessionEventActivePath(id),
        segment_count: 2,
        max_segment_bytes: 64,
        max_segments: Number.MAX_VALUE,
      },
    });
    await writeSessionRecord(record);
    const furthest = sessionEventSegmentPath(id, Number.MAX_SAFE_INTEGER);
    const retained = `${message("furthest")}\n`;
    await fs.writeFile(furthest, retained, { mode: 0o600 });
    const active = sessionEventActivePath(id);
    await fs.writeFile(active, "not-json\n", { mode: 0o600 });
    const writer = await SessionEventWriter.open(record, { maxSegmentBytes: 64 });
    await assert.rejects(
      writer.appendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: { label: "fresh" },
      }),
      /segment index exceeds its supported range/,
    );
    await assert.rejects(writer.close(), /segment index exceeds its supported range/);
    assert.equal(await fs.readFile(furthest, "utf8"), retained);
    assert.equal(await fs.readFile(active, "utf8"), "not-json\n");
  });
});

test("watch cursor still reaches a segment above the import cap", async () => {
  await withTempHome("acpx-journal-watch-", async () => {
    const id = "watch-1025";
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: "provider",
      agentCommand: "synthetic-unused-agent",
      cwd: "/tmp",
      lastSeq: 1,
      eventLog: {
        active_path: sessionEventActivePath(id),
        segment_count: 1,
        max_segment_bytes: 1024,
        max_segments: MAX_EVENT_SEGMENTS + 1,
      },
    });
    await writeSessionRecord(record);
    const anchor = {
      schema: SESSION_JOURNAL_SCHEMA,
      type: "segment",
      record_id: id,
      sequence: 0,
      message_sequence: 0,
      request_id: null,
    };
    await fs.writeFile(
      sessionEventSegmentPath(id, MAX_EVENT_SEGMENTS + 1),
      `${JSON.stringify(anchor)}\n${message("from-1025")}\n`,
      { mode: 0o600 },
    );
    const cursor = Buffer.from(JSON.stringify([id, 0])).toString("base64url");
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]);
    const iterator = watchSession({ record, cursor, signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    abort.abort();
    await iterator.return?.();
    assert.equal(first.done, false);
    assert.equal(first.value?.type, "message");
    const payload = first.value?.type === "message" ? first.value.message : undefined;
    assert.equal(labelOf(payload as AcpJsonRpcMessage), "from-1025");
  });
});
