import assert from "node:assert/strict";
import test from "node:test";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import { closeSession } from "../src/session/execution/session-control.js";
import {
  SessionJournalReader,
  SessionWatchError,
  watchSession as watchJournal,
  type SessionWatchEvent,
} from "../src/session/journal.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { watchSession } from "../src/session/watch.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

for (const outcome of ["closed", "unknown"] as const) {
  test(`watch confirms a stable ${outcome} outcome without another policy call`, async () => {
    await withTempHome("acpx-watch-confirm-", async (home) => {
      const id = "synthetic-terminal-confirmation";
      const record = makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: "synthetic-provider",
        agentCommand: "synthetic-unused",
        cwd: home,
        eventLog: { ...defaultSessionEventLog(id), segment_count: 1 },
      });
      await writeSessionRecord(record);
      await appendTurn(record, "A", undefined, outcome === "closed");
      const terminalError = new SessionWatchError("WATCH_OUTCOME_UNKNOWN", "Pending A");
      const signal = AbortSignal.timeout(10_000);
      let calls = 0;
      const events: SessionWatchEvent[] = [];
      const consume = async () => {
        for await (const event of watchJournal({
          record,
          signal,
          continueWatching: async (_record, pendingRequestId) => {
            calls += 1;
            assert.equal(calls, 1, "the confirming read must precede any further policy call");
            assert.equal(pendingRequestId, outcome === "closed" ? null : "A");
            if (outcome === "unknown") {
              throw terminalError;
            }
            return false;
          },
        })) {
          events.push(event);
        }
      };
      if (outcome === "unknown") {
        await assert.rejects(consume, (error: unknown) => error === terminalError);
      } else {
        await consume();
      }
      assert.equal(calls, 1);
      assert.equal(events.length, outcome === "closed" ? 2 : 1);
      assert.equal(signal.aborted, false);
    });
  });
}

test("watch drains a retained result before accepting a pending-outcome decision", async () => {
  await withTempHome("acpx-watch-pending-drain-", async (home) => {
    const id = "synthetic-pending-drain";
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: "synthetic-provider",
      agentCommand: "synthetic-unused",
      cwd: home,
      eventLog: { ...defaultSessionEventLog(id), segment_count: 1 },
    });
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record);
    await writer.beginTurn("A");
    await writer.appendMessage(message("A output"));
    const stopped = new AbortController();
    const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(10_000)]);
    let completed = false;
    const iterator = watchJournal({
      record,
      signal,
      continueWatching: async (_record, pendingRequestId) => {
        if (!completed) {
          assert.equal(pendingRequestId, "A");
          await writer.finishTurn("A", { status: "completed", stopReason: "end_turn" });
          await writer.close();
          await closeSession(id);
          completed = true;
          // The policy decision used the page yielded before this retained settlement.
          throw new SessionWatchError("WATCH_OUTCOME_UNKNOWN", "Stale pending A observation");
        }
        assert.equal(pendingRequestId, null);
        return false;
      },
    })[Symbol.asyncIterator]();
    try {
      await nextEvent(iterator, "turn_started", "A");
      await nextEvent(iterator, "message", "A");
      const result = await nextEvent(iterator, "turn_result", "A");
      assert(result.type === "turn_result");
      assert.deepEqual(result.result, { status: "completed", stopReason: "end_turn" });
      assert.equal((await iterator.next()).done, true);
      assert.equal(signal.aborted, false);
    } finally {
      stopped.abort();
      await iterator.return?.();
      await writer.close();
    }
  });
});

function message(text: string): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "synthetic-provider",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
}

async function appendTurn(
  record: SessionRecord,
  requestId: string,
  output?: AcpJsonRpcMessage,
  settled = true,
): Promise<void> {
  const writer = await SessionEventWriter.open(record);
  try {
    await writer.beginTurn(requestId);
    if (output) {
      await writer.appendMessage(output);
    }
    if (settled) {
      await writer.finishTurn(requestId, { status: "completed", stopReason: "end_turn" });
    }
  } finally {
    await writer.close();
  }
}

async function nextEvent(
  iterator: AsyncIterator<SessionWatchEvent>,
  type: SessionWatchEvent["type"],
  requestId: string,
): Promise<SessionWatchEvent> {
  const item = await iterator.next();
  assert.equal(item.done, false, `watch ended before ${requestId} ${type}`);
  assert(item.value);
  assert.equal(item.value.type, type);
  assert.equal(item.value.requestId, requestId);
  return item.value;
}

for (const boundary of ["consumer yield", "continuation decision", "pending B"] as const) {
  test(
    `closed watch preserves retained events and outcome (${boundary})`,
    { timeout: 15_000 },
    async () => {
      await withTempHome("acpx-watch-final-drain-", async (home) => {
        const id = "synthetic-close-drain";
        const record = makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: "synthetic-provider",
          agentCommand: "synthetic-unused",
          cwd: home,
          eventLog: {
            ...defaultSessionEventLog(id),
            segment_count: 1,
            max_segment_bytes: 8 * 1024 * 1024,
          },
        });
        await writeSessionRecord(record);
        await appendTurn(record, "A");
        // The second case crosses the replay-page cap without rotating the journal.
        const output = message(
          boundary === "continuation decision" ? "x".repeat(1024 * 1024 + 128) : "B final output",
        );
        let closureCommitted = false;
        const completeBAndClose = async () => {
          if (closureCommitted) {
            return;
          }
          await appendTurn(record, "B", output, boundary !== "pending B");
          assert.equal((await closeSession(id)).closed, true);
          closureCommitted = true;
        };
        const stopped = new AbortController();
        const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(10_000)]);
        const stream =
          boundary !== "continuation decision"
            ? watchSession({ record, signal })
            : watchJournal({
                record,
                signal,
                // Controlled policy seam: real journal/close work completes immediately
                // before the existing continuation callback first reports closure.
                continueWatching: async (_record, pendingRequestId) => {
                  assert.equal(pendingRequestId, null);
                  await completeBAndClose();
                  return false;
                },
              });
        const iterator = stream[Symbol.asyncIterator]();
        try {
          const first = [
            await nextEvent(iterator, "turn_started", "A"),
            await nextEvent(iterator, "turn_result", "A"),
          ];
          if (boundary !== "continuation decision") {
            // The generator is suspended at A's final yield. No timing race or sleep.
            await completeBAndClose();
          }
          const tail = [
            await nextEvent(iterator, "turn_started", "B"),
            await nextEvent(iterator, "message", "B"),
          ];
          assert(tail[1].type === "message");
          assert.deepEqual(tail[1].message, output);
          if (boundary === "pending B") {
            await assert.rejects(iterator.next(), { code: "WATCH_OUTCOME_UNKNOWN" });
            assert.equal(
              signal.aborted,
              false,
              "unknown outcome must not become normal completion",
            );
            const retained = await new SessionJournalReader(record).read();
            assert.equal(retained.requestId, "B");
            assert.deepEqual(
              [...first, ...tail].map((event) => event.cursor),
              retained.events.map((event) => event.cursor),
            );
            return;
          }
          tail.push(await nextEvent(iterator, "turn_result", "B"));
          assert(tail[2].type === "turn_result");
          assert.deepEqual(tail[2].result, { status: "completed", stopReason: "end_turn" });
          assert.equal((await iterator.next()).done, true);
          assert(closureCommitted);
          assert.equal(
            signal.aborted,
            false,
            "completion must be natural, not watchdog cancellation",
          );

          const all = [...first, ...tail];
          const retained = await new SessionJournalReader(record).read();
          assert.deepEqual(
            all.map((event) => event.cursor),
            retained.events.map((event) => event.cursor),
          );
          assert.equal(new Set(all.map((event) => event.cursor)).size, 5);
          const resumed: SessionWatchEvent[] = [];
          for await (const event of watchSession({ record, cursor: first[1].cursor, signal })) {
            resumed.push(event);
          }
          assert.deepEqual(resumed, tail, "resume remains exclusive after A's opaque cursor");
          assert.equal(signal.aborted, false);
        } finally {
          stopped.abort();
          await iterator.return?.();
        }
      });
    },
  );
}
