import assert from "node:assert/strict";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  sessionBaseDir,
  sessionEventActivePath,
  sessionEventSegmentPath,
} from "../src/session/event-log.js";
import {
  SessionJournalReader,
  SessionWatchError,
  SESSION_JOURNAL_SCHEMA,
} from "../src/session/journal.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { watchSession } from "../src/session/watch.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

type Receipt = Record<string, unknown>;
type ReadMode = "acp" | "anchored" | "public-watch";
type InventoryTiming = "after-active" | "after-missing";

function message(label: string): AcpJsonRpcMessage {
  return { jsonrpc: "2.0", method: "session/update", params: { label } };
}

function segment(recordId: string, sequence: number, label: string): string {
  return [
    JSON.stringify({
      schema: SESSION_JOURNAL_SCHEMA,
      type: "segment",
      record_id: recordId,
      sequence,
      message_sequence: sequence,
      request_id: null,
    }),
    JSON.stringify(message(label)),
    "",
  ].join("\n");
}

function labelOf(value: AcpJsonRpcMessage): unknown {
  const params: unknown = "params" in value ? value.params : undefined;
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>).label
    : undefined;
}

function statReceipt(stat: Stats | BigIntStats): Receipt {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime: "birthtimeNs" in stat ? String(stat.birthtimeNs) : String(stat.birthtimeMs),
    bigint: typeof stat.ino === "bigint",
  };
}

async function fixture(home: string, id: string): Promise<SessionRecord> {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: "persist11-provider",
    agentCommand: "synthetic-unused-agent",
    cwd: home,
    name: id,
    eventLog: {
      active_path: sessionEventActivePath(id),
      segment_count: 2,
      max_segment_bytes: 1000,
      max_segments: 2,
    },
  });
  await writeSessionRecord(record);
  // R1 is between .1 -> .2 and active -> .1. Retained C has not disappeared.
  await fs.writeFile(sessionEventSegmentPath(id, 2), segment(id, 1, "B"), { mode: 0o600 });
  await fs.writeFile(sessionEventActivePath(id), segment(id, 2, "C"), { mode: 0o600 });
  return record;
}

async function readLabels(mode: ReadMode, record: SessionRecord): Promise<unknown[]> {
  const reader = new SessionJournalReader(record);
  if (mode === "acp") {
    return (await reader.readAcpMessages()).map(labelOf);
  }
  if (mode === "anchored") {
    return (await reader.read()).events
      .filter((event) => event.type === "message")
      .map((event) => labelOf(event.message));
  }
  const abort = new AbortController();
  const iterator = watchSession({
    record,
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
  })[Symbol.asyncIterator]();
  const labels: unknown[] = [];
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        return labels;
      }
      if (next.value.type === "message") {
        const label = labelOf(next.value.message);
        labels.push(label);
        if (label === "D") {
          return labels;
        }
      }
    }
  } finally {
    abort.abort();
    await iterator.return?.();
  }
}

function scheduleTwoRotations(
  t: TestContext,
  recordId: string,
  timing: InventoryTiming,
  trailingMessage?: AcpJsonRpcMessage,
) {
  const active = sessionEventActivePath(recordId);
  const one = sessionEventSegmentPath(recordId, 1);
  const two = sessionEventSegmentPath(recordId, 2);
  const paths = [two, one, active];
  const selected = new Set(paths);
  const originalSync = fsSync.lstatSync;
  const originalAsync = fs.lstat;
  const receipts: Receipt[] = [
    {
      phase: "fixture",
      label: "B",
      path: two,
      ...statReceipt(originalSync(two, { bigint: true })),
    },
    {
      phase: "fixture",
      label: "C",
      path: active,
      ...statReceipt(originalSync(active, { bigint: true })),
    },
  ];
  let inventoryCount = 0;
  let firstFinished = false;
  let secondStarted = false;
  let secondFinished = false;
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });

  function finishFirstRotation() {
    fsSync.renameSync(active, one);
    const extraLine = trailingMessage === undefined ? "" : `${JSON.stringify(trailingMessage)}\n`;
    fsSync.writeFileSync(active, segment(recordId, 3, "D") + extraLine, { mode: 0o600 });
    receipts.push({
      phase: "R1-complete",
      timing,
      label: "D",
      path: active,
      ...statReceipt(originalSync(active, { bigint: true })),
    });
    firstFinished = true;
  }

  const inventory = t.mock.method(
    fsSync,
    "lstatSync",
    (...args: Parameters<typeof originalSync>) => {
      const target = String(args[0]);
      if (inventoryCount >= paths.length || !selected.has(target)) {
        return originalSync(...args);
      }
      assert.equal(target, paths[inventoryCount], "baseline inventory order changed");
      const index = inventoryCount++;
      let stat;
      try {
        stat = originalSync(...args);
      } catch (error) {
        receipts.push({
          phase: "inventory",
          index,
          path: target,
          error: (error as NodeJS.ErrnoException).code,
        });
        if (
          timing === "after-missing" &&
          target === one &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          // The real missing result is preserved, but the next real active stat
          // sees D. Initial and opened identities can therefore both be B,D.
          finishFirstRotation();
        }
        throw error;
      }
      assert(stat);
      receipts.push({ phase: "inventory", index, path: target, ...statReceipt(stat) });
      if (timing === "after-active" && target === active) {
        // Finish R1 only after the real inventory has captured [B, missing, C].
        finishFirstRotation();
      }
      return stat;
    },
  );

  const verification = t.mock.method(
    fs,
    "lstat",
    async (...args: Parameters<typeof originalAsync>) => {
      const target = String(args[0]);
      if (!selected.has(target) || args[1]?.bigint !== true) {
        return await originalAsync(...args);
      }
      assert.equal(
        firstFinished,
        true,
        "unexpected asynchronous stat before the captured inventory",
      );
      if (!secondStarted) {
        assert.equal(target, two, "baseline verification order changed");
        secondStarted = true;
        try {
          // Real B identity is retained as the return value; other verification
          // syscalls wait until the normal unlink/rename portion of R2 completes.
          const stat = await originalAsync(...args);
          assert(stat);
          receipts.push({ phase: "verification-before-R2", path: target, ...statReceipt(stat) });
          fsSync.unlinkSync(two);
          fsSync.renameSync(one, two);
          secondFinished = true;
          receipts.push({
            phase: "R2-partial",
            retained: "C",
            path: two,
            ...statReceipt(originalSync(two, { bigint: true })),
          });
          return stat;
        } finally {
          releaseSecond();
        }
      }
      await secondGate;
      try {
        const stat = await originalAsync(...args);
        assert(stat);
        receipts.push({ phase: "verification-after-R2", path: target, ...statReceipt(stat) });
        return stat;
      } catch (error) {
        receipts.push({
          phase: "verification-after-R2",
          path: target,
          error: (error as NodeJS.ErrnoException).code,
        });
        throw error;
      }
    },
  );

  return {
    receipts,
    restore() {
      verification.mock.restore();
      inventory.mock.restore();
      releaseSecond();
    },
    assertAdmitted() {
      assert.equal(inventoryCount, 3);
      assert.equal(firstFinished, true);
      assert.equal(secondStarted, true);
      assert.equal(secondFinished, true);
    },
  };
}

for (const [timing, mode] of [
  ["after-active", "acp"],
  ["after-active", "anchored"],
  ["after-active", "public-watch"],
  ["after-missing", "acp"],
  ["after-missing", "anchored"],
  ["after-missing", "public-watch"],
] as const) {
  test(`retained C survives ${timing} inventory rotation during ${mode} capture`, async (t) => {
    await withTempHome("acpx-journal-two-rotations-", async (home) => {
      const record = await fixture(home, `persist11-${timing}-${mode}`);
      const schedule = scheduleTwoRotations(t, record.acpxRecordId, timing);
      let outcome: { labels: unknown[] } | { error: unknown };
      try {
        outcome = await readLabels(mode, record).then(
          (labels) => ({ labels }),
          (error: unknown) => ({ error }),
        );
      } finally {
        schedule.restore();
      }
      const stable = await new SessionJournalReader(record).readAcpMessages();
      t.diagnostic(
        JSON.stringify({
          timing,
          mode,
          receipts: schedule.receipts,
          outcome:
            "labels" in outcome
              ? outcome
              : {
                  error:
                    outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
                  code: (outcome.error as { code?: unknown })?.code,
                },
          stable: stable.map(labelOf),
        }),
      );
      schedule.assertAdmitted();
      assert.deepEqual(
        stable.map(labelOf),
        ["C", "D"],
        "C remained retained throughout the captured race",
      );
      if ("error" in outcome) {
        throw outcome.error;
      }
      assert.deepEqual(outcome.labels, ["C", "D"]);
    });
  });
}

test("a stable retained C,D journal remains readable through the same three surfaces", async () => {
  await withTempHome("acpx-journal-stable-retained-", async (home) => {
    const record = await fixture(home, "persist11-stable");
    await fs.unlink(sessionEventSegmentPath(record.acpxRecordId, 2));
    await fs.rename(
      sessionEventActivePath(record.acpxRecordId),
      sessionEventSegmentPath(record.acpxRecordId, 2),
    );
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      segment(record.acpxRecordId, 3, "D"),
      { mode: 0o600 },
    );
    for (const mode of ["acp", "anchored", "public-watch"] as const) {
      assert.deepEqual(await readLabels(mode, record), ["C", "D"]);
    }
    assert.deepEqual((await fs.readdir(sessionBaseDir())).toSorted(), [
      `${record.acpxRecordId}.json`,
      `${record.acpxRecordId}.stream.2.ndjson`,
      `${record.acpxRecordId}.stream.ndjson`,
    ]);
  });
});

type JournalSnapshot = Awaited<ReturnType<SessionJournalReader["read"]>>;
type ReadOutcome = { snapshot: JournalSnapshot } | { error: unknown };

function snapshotLabels(snapshot: JournalSnapshot): unknown[] {
  return snapshot.events
    .filter((event) => event.type === "message")
    .map((event) => labelOf(event.message));
}

function snapshotSummary(snapshot: JournalSnapshot) {
  return {
    labels: snapshotLabels(snapshot),
    sequences: snapshot.events.map((event) => event.sequence),
    hasMore: snapshot.hasMore,
    sequence: snapshot.sequence,
  };
}

function outcomeSummary(outcome: ReadOutcome) {
  if ("snapshot" in outcome) {
    return snapshotSummary(outcome.snapshot);
  }
  return {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    code: (outcome.error as { code?: unknown })?.code,
  };
}

async function captureRead(
  reader: SessionJournalReader,
  options?: { maxBytes: number },
): Promise<ReadOutcome> {
  return await reader.read(undefined, options).then(
    (snapshot) => ({ snapshot }),
    (error: unknown) => ({ error }),
  );
}

function successfulRead(outcome: ReadOutcome): JournalSnapshot {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.snapshot;
}

test("a stable parse failure preserves the reused reader's delivered prefix", async () => {
  await withTempHome("acpx-journal-rejected-page-", async (home) => {
    const record = await fixture(home, "persist11-rejected-page");
    const reader = new SessionJournalReader(record);
    assert.deepEqual(snapshotLabels(await reader.read()), ["B", "C"]);
    const active = sessionEventActivePath(record.acpxRecordId);
    await fs.appendFile(active, `${JSON.stringify(message("D"))}\n`);
    const validSize = (await fs.stat(active)).size;
    await fs.appendFile(active, "malformed\n");

    await assert.rejects(
      reader.read(),
      (error) => error instanceof SessionWatchError && error.code === "WATCH_JOURNAL_CORRUPT",
    );
    // Repair only the malformed suffix on the same file, then retry the same reader.
    await fs.truncate(active, validSize);
    assert.deepEqual(snapshotLabels(await reader.read()), ["D"]);
    assert.deepEqual(snapshotLabels(await reader.read()), []);
  });
});

for (const failure of ["EIO", "abort"] as const) {
  test(`post-read verification ${failure} preserves the reused reader's delivered prefix`, async (t) => {
    await withTempHome("acpx-journal-verification-failure-", async (home) => {
      const record = await fixture(home, `persist11-verification-${failure}`);
      const reader = new SessionJournalReader(record);
      assert.deepEqual(snapshotLabels(await reader.read()), ["B", "C"]);
      await fs.appendFile(
        sessionEventActivePath(record.acpxRecordId),
        `${JSON.stringify(message("D"))}\n`,
      );
      const controller = new AbortController();
      const reason = new Error("post-read verification aborted");
      const original = fs.lstat;
      let calls = 0;
      let injected = 0;
      const verification = t.mock.method(
        fs,
        "lstat",
        async (...args: Parameters<typeof original>) => {
          const stat = await original(...args).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return error;
            }
            throw error;
          });
          if (args[1]?.bigint === true && ++calls === 4) {
            injected += 1;
            if (failure === "EIO") {
              throw Object.assign(new Error("post-read verification EIO"), { code: "EIO" });
            }
            controller.abort(reason);
          }
          if (stat instanceof Error) {
            throw stat;
          }
          return stat;
        },
      );
      try {
        await assert.rejects(reader.read(controller.signal), (error: unknown) =>
          failure === "abort" ? error === reason : (error as NodeJS.ErrnoException).code === "EIO",
        );
        assert.equal(injected, 1);
      } finally {
        verification.mock.restore();
      }
      assert.deepEqual(snapshotLabels(await reader.read()), ["D"]);
      assert.deepEqual(snapshotLabels(await reader.read()), []);
    });
  });
}

for (const { timing, bounded } of [
  { timing: "after-active", bounded: false },
  { timing: "after-missing", bounded: false },
  { timing: "after-missing", bounded: true },
] as const) {
  test(`reused reader retains delivery state across ${timing} rotation${bounded ? " and a bounded page" : ""}`, async (t) => {
    await withTempHome("acpx-journal-reused-reader-", async (home) => {
      const record = await fixture(home, `persist11-reused-${timing}-${bounded}`);
      const reader = new SessionJournalReader(record);
      const initial = await reader.read();
      assert.deepEqual(snapshotLabels(initial), ["B", "C"]);
      assert.deepEqual(
        initial.events.map((event) => event.sequence),
        [2, 3],
      );
      assert.equal(initial.hasMore, false);

      const options = bounded ? { maxBytes: 1 } : undefined;
      const schedule = scheduleTwoRotations(
        t,
        record.acpxRecordId,
        timing,
        bounded ? message("E") : undefined,
      );
      let raced: ReadOutcome;
      try {
        // No explicit `after`: the same reader must preserve C's delivered state.
        raced = await captureRead(reader, options);
      } finally {
        schedule.restore();
      }
      const following = await captureRead(reader, options);
      const final = bounded ? await captureRead(reader, options) : undefined;
      const stable = await new SessionJournalReader(record).readAcpMessages();
      t.diagnostic(
        JSON.stringify({
          timing,
          bounded,
          initial: snapshotSummary(initial),
          receipts: schedule.receipts,
          raced: outcomeSummary(raced),
          following: outcomeSummary(following),
          final: final === undefined ? undefined : outcomeSummary(final),
          stable: stable.map(labelOf),
        }),
      );
      schedule.assertAdmitted();
      assert.deepEqual(stable.map(labelOf), bounded ? ["C", "D", "E"] : ["C", "D"]);
      const accepted = successfulRead(raced);
      assert.deepEqual(snapshotLabels(accepted), ["D"]);
      assert.deepEqual(
        accepted.events.map((event) => event.sequence),
        [4],
      );
      assert.equal(accepted.hasMore, bounded);
      const next = successfulRead(following);
      assert.deepEqual(snapshotLabels(next), bounded ? ["E"] : []);
      if (bounded) {
        assert.deepEqual(
          next.events.map((event) => event.sequence),
          [5],
        );
        assert(final);
        const drained = successfulRead(final);
        assert.deepEqual(drained.events, []);
        assert.equal(drained.hasMore, false);
      } else {
        assert.equal(next.hasMore, false);
      }
    });
  });
}
