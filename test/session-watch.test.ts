import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  defaultSessionEventLog,
  sessionEventActivePath,
  sessionEventSegmentPath,
} from "../src/session/event-log.js";
import { SessionEventWriter, listSessionEvents } from "../src/session/events.js";
import { exportSession } from "../src/session/export.js";
import {
  SessionJournalReader,
  watchSession,
  type SessionWatchEvent,
} from "../src/session/journal.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

function record(home: string, id = "watch-session"): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: "provider-session",
    agentCommand: "fixture-agent",
    cwd: home,
    eventLog: { ...defaultSessionEventLog(id), segment_count: 1 },
  });
}

function message(text: string): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "provider-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
}

function observer(session: SessionRecord, cursor?: string, timeoutMs = 3_000) {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
  const iterator = watchSession({ record: session, cursor, signal })[Symbol.asyncIterator]();
  return { abort, iterator };
}

test("reopened journals mark an unfinished turn unknown before the next attempt", async () => {
  await withTempHome("acpx-watch-recovery-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const first = await SessionEventWriter.open(session);
    await first.beginTurn("lost-owner");
    await first.appendMessage(message("before loss"));
    await assert.rejects(first.beginTurn("overlap"), /already active/u);
    await first.close();
    const nextWriter = await SessionEventWriter.open(session);
    await nextWriter.beginTurn("replacement");
    await nextWriter.finishTurn("replacement", { status: "completed", stopReason: "end_turn" });
    await nextWriter.close();
    const watched = observer(session);
    try {
      assert.equal((await next(watched.iterator)).type, "turn_started");
      assert.equal((await next(watched.iterator)).type, "message");
      const recovered = await next(watched.iterator);
      assert.equal(recovered.type, "turn_result");
      if (recovered.type !== "turn_result") {
        throw new Error("Missing recovery result");
      }
      assert.equal(recovered.requestId, "lost-owner");
      assert.equal(recovered.result.status, "failed");
      if (recovered.result.status !== "failed") {
        throw new Error("Lost outcome was marked successful");
      }
      assert.equal(recovered.result.error.detailCode, "WATCH_OUTCOME_UNKNOWN");
      assert.equal((await next(watched.iterator)).requestId, "replacement");
      assert.equal((await next(watched.iterator)).type, "turn_result");
    } finally {
      watched.abort.abort();
    }
  });
});

async function next(iterator: AsyncIterator<SessionWatchEvent>): Promise<SessionWatchEvent> {
  const result = await iterator.next();
  assert.equal(result.done, false, "watch ended before the expected event");
  assert.ok(result.value);
  return result.value;
}

test("watch replays and follows without interpreting an ACP response as a settled turn", async () => {
  await withTempHome("acpx-watch-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("queue-request");
    const output = message("live output");
    await writer.appendMessage(output);
    const watched = observer(session);
    try {
      const started = await next(watched.iterator);
      assert.equal(started.type, "turn_started");
      const replayed = await next(watched.iterator);
      assert.deepEqual(replayed, {
        type: "message",
        requestId: "queue-request",
        message: output,
        cursor: replayed.cursor,
      });
      const response: AcpJsonRpcMessage = {
        jsonrpc: "2.0",
        id: 9,
        result: { stopReason: "end_turn" },
      };
      await writer.appendMessage(response);
      assert.equal((await next(watched.iterator)).type, "message");
      await writer.finishTurn("queue-request", {
        status: "failed",
        error: { message: "Final checkpoint failed" },
      });
      const terminal = await next(watched.iterator);
      assert.equal(terminal.type, "turn_result");
      if (terminal.type === "turn_result") {
        assert.equal(terminal.result.status, "failed");
      }
      assert.equal(new Set([started.cursor, replayed.cursor, terminal.cursor]).size, 3);
      assert.deepEqual(await listSessionEvents(session.acpxRecordId), [output, response]);
      assert.equal(session.lastSeq, 2, "journal metadata must not change ACP sequence counts");
    } finally {
      watched.abort.abort();
      await watched.iterator.return?.();
      await writer.close();
    }
  });
});

test("cursor resumes exclusively across rotation and a stale-checkpoint writer restart", async () => {
  await withTempHome("acpx-watch-restart-", async (home) => {
    const session = record(home);
    session.eventLog.max_segment_bytes = 1;
    await writeSessionRecord(session);
    const first = await SessionEventWriter.open(session);
    await first.beginTurn("first-request");
    await first.appendMessage(message("first"));
    await first.finishTurn("first-request", { status: "completed", stopReason: "end_turn" });
    const prior = (await new SessionJournalReader(session).read()).events;
    const cursor = prior[prior.length - 1].cursor;
    await first.close({ checkpoint: false });
    const stale = await resolveSessionRecord(session.acpxRecordId);
    assert.equal(stale.lastSeq, 0);
    const second = await SessionEventWriter.open(stale);
    await second.beginTurn("second-request");
    await second.appendMessage(message("second"));
    await second.finishTurn("second-request", { status: "cancelled", stopReason: "cancelled" });
    await second.close();
    const watched = observer(stale, cursor);
    try {
      const replay = [
        await next(watched.iterator),
        await next(watched.iterator),
        await next(watched.iterator),
      ];
      assert.deepEqual(
        replay.map((event) => [event.type, event.requestId]),
        [
          ["turn_started", "second-request"],
          ["message", "second-request"],
          ["turn_result", "second-request"],
        ],
      );
      assert.equal(new Set([cursor, ...replay.map((event) => event.cursor)]).size, 4);
      assert.equal((await resolveSessionRecord(session.acpxRecordId)).lastSeq, 2);
    } finally {
      watched.abort.abort();
      await watched.iterator.return?.();
    }
  });
});

test("watch rejects malformed, foreign, future, and expired cursors explicitly", async () => {
  await withTempHome("acpx-watch-cursors-", async (home) => {
    const session = record(home);
    session.eventLog.max_segments = 1;
    session.eventLog.max_segment_bytes = 1;
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const initial = (await new SessionJournalReader(session).read()).events[0].cursor;
    const future = Buffer.from(JSON.stringify([session.acpxRecordId, 99])).toString("base64url");
    const foreign = Buffer.from(JSON.stringify(["other-session", 1])).toString("base64url");
    await writer.appendMessages([message("one"), message("two"), message("three")]);
    for (const [cursor, code] of [
      ["bad!", "WATCH_CURSOR_INVALID"],
      [foreign, "WATCH_CURSOR_FOREIGN"],
      [future, "WATCH_CURSOR_FUTURE"],
      [initial, "WATCH_CURSOR_EXPIRED"],
    ]) {
      const watched = observer(session, cursor);
      await assert.rejects(watched.iterator.next(), { code });
      watched.abort.abort();
    }
    await writer.close();
  });
});

test("observer cancellation neither changes files nor closes the writer", async () => {
  await withTempHome("acpx-watch-passive-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const directory = path.dirname(sessionEventActivePath(session.acpxRecordId));
    const before = await fs.readdir(directory);
    const watched = observer(session);
    await next(watched.iterator);
    const waiting = watched.iterator.next();
    watched.abort.abort();
    assert.equal((await waiting).done, true);
    assert.deepEqual(await fs.readdir(directory), before);
    await writer.appendMessage(message("survived observer"));
    await writer.finishTurn("request", { status: "completed" });
    await writer.close();
    const replay = (await new SessionJournalReader(session).read()).events;
    assert.equal(replay[replay.length - 1].type, "turn_result");
  });
});

test("partial writes are withheld and recovery preserves sequence without altering ACP bytes", async () => {
  await withTempHome("acpx-watch-partial-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    await writer.close({ checkpoint: false });
    const filePath = sessionEventActivePath(session.acpxRecordId);
    const before = await fs.readFile(filePath, "utf8");
    await fs.appendFile(filePath, '{"jsonrpc":');
    const partial = await new SessionJournalReader(session).read();
    assert.equal(partial.events.length, 1);
    assert.equal(partial.activePartial, true);
    const resumed = await SessionEventWriter.open(await resolveSessionRecord(session.acpxRecordId));
    await resumed.appendMessage(message("after crash"));
    await resumed.finishTurn("request", { status: "completed" });
    await resumed.close();
    assert.equal(
      await fs.readFile(sessionEventSegmentPath(session.acpxRecordId, 1), "utf8"),
      `${before}{"jsonrpc":`,
    );
    const recovered = await new SessionJournalReader(session).read();
    assert.deepEqual(
      recovered.events.map((event) => event.sequence),
      [1, 2, 3],
    );
    assert.equal(recovered.events[1].requestId, "request");
  });
});

test("committed corruption and a missing middle segment fail instead of silently skipping", async () => {
  await withTempHome("acpx-watch-corrupt-", async (home) => {
    for (const mode of ["invalid-line", "missing-segment"]) {
      const session = record(home, mode);
      session.eventLog.max_segment_bytes = 1;
      await writeSessionRecord(session);
      const writer = await SessionEventWriter.open(session);
      await writer.beginTurn("request");
      await writer.appendMessages([message("one"), message("two")]);
      await writer.close();
      if (mode === "invalid-line") {
        await fs.appendFile(sessionEventActivePath(session.acpxRecordId), "{invalid-json\n");
      } else {
        await fs.unlink(sessionEventSegmentPath(session.acpxRecordId, 1));
      }
      await assert.rejects(new SessionJournalReader(session).read(), {
        code: "WATCH_JOURNAL_CORRUPT",
      });
    }
  });
});

test("portable exports remain ACP-only after lifecycle journaling", async () => {
  await withTempHome("acpx-watch-export-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    const output = message("exported");
    await writer.beginTurn("request");
    await writer.appendMessage(output);
    await writer.finishTurn("request", { status: "completed" });
    await writer.close();
    const target = path.join(home, "export.json");
    await exportSession(
      { agentCommand: session.agentCommand, cwd: home, name: session.name },
      target,
    );
    const exported = JSON.parse(await fs.readFile(target, "utf8")) as { history: unknown[] };
    assert.deepEqual(exported.history, [output]);
  });
});

test("watch reads concurrent rotations without duplicate events or silent gaps", async () => {
  await withTempHome("acpx-watch-rotation-", async (home) => {
    const session = record(home);
    session.eventLog.max_segment_bytes = 400;
    session.eventLog.max_segments = 64;
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    // Forty durable rotations can outlive the short watchdog on loaded runners.
    const watched = observer(session, undefined, 15_000);
    const observed: SessionWatchEvent[] = [];
    const collect = async () => {
      for (;;) {
        const event = await next(watched.iterator);
        observed.push(event);
        if (event.type === "turn_result") {
          return;
        }
      }
    };
    const write = async () => {
      await writer.beginTurn("request");
      for (let index = 0; index < 40; index += 1) {
        await writer.appendMessage(message(`chunk-${index}`));
      }
      await writer.finishTurn("request", { status: "completed" });
    };
    try {
      const results = await Promise.allSettled([collect(), write()]);
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      assert.equal(observed.length, 42);
      assert.equal(new Set(observed.map((event) => event.cursor)).size, 42);
      assert.deepEqual(
        observed.filter((event) => event.type === "message").map((event) => event.message),
        Array.from({ length: 40 }, (_, index) => message(`chunk-${index}`)),
      );
    } finally {
      watched.abort.abort();
      await watched.iterator.return?.();
      await writer.close();
    }
  });
});

test("ACP payloads cannot impersonate local journal metadata", async () => {
  await withTempHome("acpx-watch-marker-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const impersonation = {
      ...message("adapter payload"),
      schema: "acpx.session.journal.v1",
      type: "turn_started",
      request_id: "spoofed-request",
    };
    await writer.appendMessage(impersonation);
    await writer.finishTurn("request", { status: "completed" });
    await writer.close();
    const replay = await new SessionJournalReader(session).read();
    assert.deepEqual(
      replay.events.map((event) => [event.type, event.requestId]),
      [
        ["turn_started", "request"],
        ["message", "request"],
        ["turn_result", "request"],
      ],
    );
    assert.deepEqual(await listSessionEvents(session.acpxRecordId), [impersonation]);
  });
});

test("closing an idle iterator settles its outstanding read without an external abort", async () => {
  await withTempHome("acpx-watch-close-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const directory = path.dirname(sessionEventActivePath(session.acpxRecordId));
    const before = await fs.readdir(directory);
    const iterator = watchSession({ record: session })[Symbol.asyncIterator]();
    const waiting = iterator.next();
    assert.equal((await iterator.return?.())?.done, true);
    assert.equal((await waiting).done, true);
    assert.deepEqual(await fs.readdir(directory), before);
  });
});

test("slow observers report expired unread history without delaying the writer", async () => {
  await withTempHome("acpx-watch-slow-", async (home) => {
    const session = record(home);
    session.eventLog.max_segment_bytes = 1;
    session.eventLog.max_segments = 1;
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const watched = observer(session);
    await next(watched.iterator);
    await writer.appendMessages(Array.from({ length: 5 }, (_, index) => message(`chunk-${index}`)));
    await writer.finishTurn("request", { status: "completed" });
    await writer.close();
    await assert.rejects(watched.iterator.next(), { code: "WATCH_CURSOR_EXPIRED" });
    watched.abort.abort();
  });
});

test("legacy raw history stays byte-identical and starts a new anchored watch boundary", async () => {
  await withTempHome("acpx-watch-legacy-", async (home) => {
    const session = record(home);
    session.lastSeq = 1;
    await writeSessionRecord(session);
    const legacy = `${JSON.stringify(message("legacy output"))}\n`;
    await fs.writeFile(sessionEventActivePath(session.acpxRecordId), legacy);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("new-request");
    await writer.appendMessage(message("new output"));
    await writer.finishTurn("new-request", { status: "completed" });
    await writer.close();
    assert.equal(
      await fs.readFile(sessionEventSegmentPath(session.acpxRecordId, 1), "utf8"),
      legacy,
    );
    assert.deepEqual(await listSessionEvents(session.acpxRecordId), [
      message("legacy output"),
      message("new output"),
    ]);
    const replay = await new SessionJournalReader(session).read();
    assert.equal(replay.events.length, 3);
    assert.equal(replay.messageSequence, 2);
    assert.ok(replay.events.every((event) => event.requestId === "new-request"));
  });
});

test("checkpoint failure does not prevent later output or a settled failed result", async () => {
  await withTempHome("acpx-watch-checkpoint-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const recordPath = path.join(home, ".acpx", "sessions", `${session.acpxRecordId}.json`);
    await fs.rename(recordPath, `${recordPath}.saved`);
    await fs.mkdir(recordPath);
    await assert.rejects(writer.checkpoint());
    await fs.rmdir(recordPath);
    await fs.rename(`${recordPath}.saved`, recordPath);
    try {
      await writer.appendMessage(message("after checkpoint failure"));
      await writer.finishTurn("request", {
        status: "failed",
        error: { message: "Checkpoint failed" },
      });
      await writer.close();
      const replay = await new SessionJournalReader(session).read();
      assert.deepEqual(
        replay.events.map((event) => event.type),
        ["turn_started", "message", "turn_result"],
      );
      assert.equal((await resolveSessionRecord(session.acpxRecordId)).lastSeq, 1);
    } finally {
      await writer.close({ checkpoint: false }).catch(() => {});
    }
  });
});

test("a failed append remains fatal until the journal is reopened", async () => {
  await withTempHome("acpx-watch-append-failure-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const filePath = sessionEventActivePath(session.acpxRecordId);
    await fs.rename(filePath, `${filePath}.saved`);
    await fs.mkdir(filePath);
    await assert.rejects(writer.appendMessage(message("failed")));
    await fs.rmdir(filePath);
    await fs.rename(`${filePath}.saved`, filePath);
    await assert.rejects(writer.appendMessage(message("must not append")));
    await writer.close({ checkpoint: false }).catch(() => {});
    const replay = await new SessionJournalReader(session).read();
    assert.deepEqual(
      replay.events.map((event) => event.type),
      ["turn_started"],
    );
  });
});

test("ACP-only snapshots survive rotation after opening the active file", async (t) => {
  await withTempHome("acpx-watch-snapshot-race-", async (home) => {
    const session = record(home);
    session.eventLog.max_segment_bytes = 1;
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    await writer.appendMessage(message("first"));
    const open = fs.open;
    const activePath = sessionEventActivePath(session.acpxRecordId);
    const activePaths = new Set([activePath, await fs.realpath(activePath)]);
    let rotated = false;
    const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const flags = args[1];
      const reading =
        typeof flags === "number"
          ? (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
          : flags === "r";
      if (reading && activePaths.has(String(args[0])) && !rotated) {
        rotated = true;
        await writer.appendMessage(message("second"));
      }
      return handle;
    });
    try {
      assert.deepEqual(await listSessionEvents(session.acpxRecordId), [
        message("first"),
        message("second"),
      ]);
      assert.equal(rotated, true, "the read must exercise the post-open rotation race");
    } finally {
      mocked.mock.restore();
      await writer.close();
    }
  });
});

test("bounded replay pages retain unread lines and omit events at or before a resume cursor", async () => {
  await withTempHome("acpx-watch-pages-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(`${index}: ${"x".repeat(100)}`),
    );
    await writer.appendMessages(messages);
    await writer.finishTurn("request", { status: "completed" });
    await writer.close();
    const reader = new SessionJournalReader(session);
    let page = await reader.read(undefined, { maxBytes: 200 });
    assert.equal(page.hasMore, true);
    assert.ok(
      page.events.length < messages.length,
      "replay must not buffer the entire retained history",
    );
    const events = [...page.events];
    while (page.hasMore) {
      const last = events[events.length - 1];
      page = await reader.read(undefined, { after: last.sequence, maxBytes: 200 });
      assert.ok(!page.hasMore || page.events.length > 0, "a backlog page must make progress");
      events.push(...page.events);
    }
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      events.filter((event) => event.type === "message").map((event) => event.message),
      messages,
    );
    const resumed = await new SessionJournalReader(session).read(undefined, {
      after: 17,
      maxBytes: 200,
    });
    assert.equal(resumed.events[0].sequence, 18);
    assert.ok(resumed.events.every((event) => event.sequence > 17));
  });
});

test("incremental readers publish split UTF-8 records only after their terminating newline", async () => {
  await withTempHome("acpx-watch-split-", async (home) => {
    const session = record(home);
    await writeSessionRecord(session);
    const writer = await SessionEventWriter.open(session);
    await writer.beginTurn("request");
    await writer.close();
    const output = message("a 🦞 across reads");
    const line = Buffer.from(`${JSON.stringify(output)}\n`);
    const split = line.indexOf(Buffer.from("🦞")) + 2;
    const filePath = sessionEventActivePath(session.acpxRecordId);
    const reader = new SessionJournalReader(session);
    await fs.appendFile(filePath, line.subarray(0, split));
    assert.equal((await reader.read()).events.length, 1);
    await fs.appendFile(filePath, line.subarray(split, -1));
    assert.equal((await reader.read()).events.length, 0);
    await fs.appendFile(filePath, line.subarray(-1));
    const completed = await reader.read();
    assert.equal(completed.events.length, 1);
    assert.equal(completed.events[0].type, "message");
    if (completed.events[0].type === "message") {
      assert.deepEqual(completed.events[0].message, output);
    }
  });
});
