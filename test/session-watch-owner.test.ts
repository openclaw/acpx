import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import type { ProcessBirthIdentity } from "../src/process-identity.js";
import { SessionJournalReader, type SessionWatchEvent } from "../src/session/journal.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { QueueOwnerRecord } from "../src/session/queue/lease-store.js";
import { queueLockFilePath } from "../src/session/queue/paths.js";
import { watchSession } from "../src/session/watch.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const fixturePid = 2_000_001;
const birth = "2026-09-21T10:00:01.000Z";

function watchFixture(t: TestContext, platform: NodeJS.Platform = "darwin") {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalRoot = process.env.SystemRoot;
  Object.defineProperty(process, "platform", { value: platform });
  process.env.SystemRoot = "C:\\Windows";
  const session = makeSessionRecord({
    acpxRecordId: "owner-observation",
    acpSessionId: "provider-session",
    agentCommand: "fixture-agent",
    cwd: process.cwd(),
  });
  const state = {
    owner: {
      pid: fixturePid,
      sessionId: session.acpxRecordId,
      socketPath: "fixture-socket",
      createdAt: birth,
      heartbeatAt: birth,
      ownerGeneration: 1,
      processIdentity: { kind: "posix-lstart", value: birth },
      queueDepth: 0,
      sessionWatch: true,
    } as QueueOwnerRecord | undefined,
    now: 0,
    queries: 0,
    sequence: 0,
    quiet: false,
    signalError: "",
    queryError: null as Error | null,
    output: `${fixturePid} 1 1 S Mon Sep 21 10:00:01 2026\n`,
    onQuery: async () => {},
    requestId: "pending" as string | null,
    event: undefined as SessionWatchEvent | undefined,
  };
  const controller = new AbortController();
  const iterator = watchSession({ record: session, signal: controller.signal })[
    Symbol.asyncIterator
  ]();
  t.mock.method(performance, "now", () => state.now);
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    assert.equal(signal, 0, "passive watching must never send a destructive signal");
    if (state.signalError) {
      throw Object.assign(new Error(state.signalError), { code: state.signalError });
    }
    return true;
  });
  t.mock.method(fs, "readFile", async (file: unknown) => {
    if (file === queueLockFilePath(session.acpxRecordId)) {
      if (!state.owner) {
        throw Object.assign(new Error("missing lease"), { code: "ENOENT" });
      }
      return JSON.stringify(state.owner);
    }
    assert.equal(String(file).endsWith(`${session.acpxRecordId}.json`), true);
    return JSON.stringify(serializeSessionRecordForDisk(session));
  });
  t.mock.method(SessionJournalReader.prototype, "read", async () => {
    // Terminal decisions need an empty confirming page at the retained sequence.
    const sequence = state.quiet ? state.sequence : ++state.sequence;
    const event = state.event ?? {
      type: "message" as const,
      cursor: String(sequence),
      requestId: state.requestId,
      message: { jsonrpc: "2.0" as const, method: "fixture/update", params: {} },
    };
    return {
      events: state.quiet ? [] : [{ ...event, sequence }],
      hasMore: false,
      sequence,
      messageSequence: sequence,
      requestId: state.requestId,
      activeSize: 1,
      activeAnchored: true,
      activePartial: false,
    };
  });
  t.mock.method(childProcess, "execFile", ((
    _command: string,
    _args: readonly string[],
    _options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    state.queries += 1;
    const output = state.output;
    void state.onQuery().then(() => callback(state.queryError, output, ""));
    return new ChildProcess();
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(async () => {
    controller.abort();
    await iterator.return?.();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = originalRoot;
    }
  });
  return { state, session, iterator, controller };
}

test("watch bounds matching observations across journal polls and heartbeat refreshes", async (t) => {
  const { state, iterator } = watchFixture(t);
  await iterator.next();
  await iterator.next();
  assert.equal(state.queries, 1);
  assert(state.owner);
  state.owner.heartbeatAt = "2026-09-21T10:10:00.000Z";
  state.now = 999;
  await iterator.next();
  assert.equal(state.queries, 1);
  state.now = 1_000;
  await iterator.next();
  assert.equal(state.queries, 2);
});

test("idle watches retain gone observations until the owner incarnation changes", async (t) => {
  const { state, iterator } = watchFixture(t);
  state.requestId = null;
  state.output = `${fixturePid} 1 1 S Mon Sep 21 10:00:02 2026\n`;
  await iterator.next();
  await iterator.next();
  assert.equal(state.queries, 1);
  for (const now of [1_000, 10_000, 100_000]) {
    state.now = now;
    await iterator.next();
  }
  assert.equal(state.queries, 1, "an unchanged departed incarnation cannot return");
  assert(state.owner);
  state.owner.ownerGeneration += 1;
  await iterator.next();
  assert.equal(state.queries, 2);
  state.owner.pid += 1;
  await iterator.next();
  assert.equal(state.queries, 3);
  state.owner.processIdentity = { kind: "posix-lstart", value: "2026-09-21T10:00:02.000Z" };
  await iterator.next();
  assert.equal(state.queries, 4);
});

for (const uncertainty of ["legacy", "query-failure", "permission", "foreign-platform"] as const) {
  test(`watch preserves ${uncertainty} ownership conservatively`, async (t) => {
    const { state, iterator } = watchFixture(t);
    assert(state.owner);
    if (uncertainty === "legacy") {
      delete state.owner.processIdentity;
    } else if (uncertainty === "query-failure") {
      state.queryError = new Error("identity query unavailable");
    } else if (uncertainty === "permission") {
      state.signalError = "EPERM";
      state.output = "";
    } else {
      state.owner.processIdentity = {
        kind: "windows-creation",
        value: "2026-09-21T10:00:01.0000000Z",
      };
      state.signalError = "ESRCH";
    }
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await iterator.next()).done, false);
    }
    assert.equal(
      state.queries,
      uncertainty === "legacy" || uncertainty === "foreign-platform" ? 0 : 1,
    );
  });
}

test("an owner published during an identity probe wins over the old gone result", async (t) => {
  const { state, iterator } = watchFixture(t);
  state.output = `${fixturePid} 1 1 S Mon Sep 21 10:00:02 2026\n`;
  state.onQuery = async () => {
    assert(state.owner);
    state.owner.ownerGeneration += 1;
    state.owner.processIdentity = { kind: "posix-lstart", value: "2026-09-21T10:00:02.000Z" };
    state.onQuery = async () => {};
  };
  await iterator.next();
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await iterator.next()).done, false);
  }
  assert.equal(state.queries, 2);
});

test("a final journal marker written during the probe wins over owner loss", async (t) => {
  const { state, iterator } = watchFixture(t);
  state.output = `${fixturePid} 1 1 S Mon Sep 21 10:00:02 2026\n`;
  state.onQuery = async () => {
    state.requestId = null;
    state.event = {
      type: "turn_result",
      cursor: "2",
      requestId: "pending",
      result: { status: "completed" },
    };
  };
  await iterator.next();
  assert.equal((await iterator.next()).value?.type, "turn_result");
  assert.equal((await iterator.next()).done, false);
  assert.equal(state.queries, 1);
});

test("owner disappearance and replacement reset the missing-result grace", async (t) => {
  const { state, iterator } = watchFixture(t);
  const owner = state.owner;
  state.owner = undefined;
  await iterator.next();
  await iterator.next();
  state.owner = owner;
  await iterator.next();
  state.owner = undefined;
  await iterator.next();
  state.quiet = true;
  await assert.rejects(iterator.next(), { code: "WATCH_OUTCOME_UNKNOWN" });
});

test("the current process is not marked dead by the numeric self-PID guard", async (t) => {
  const { state, iterator } = watchFixture(t);
  assert(state.owner);
  state.owner.pid = process.pid;
  state.output = `${process.pid} 1 1 S Mon Sep 21 10:00:01 2026\n`;
  await iterator.next();
  await iterator.next();
  await iterator.next();
  assert.equal(state.queries, 1);
});

test("Linux foreign-scope ownership stays unknown even when the local PID is absent", async (t) => {
  const { state, iterator } = watchFixture(t, "linux");
  assert(state.owner);
  const scope = {
    bootId: "11111111-1111-1111-1111-111111111111",
    pidNamespace: "pid:[88]",
    timeNamespace: "time:[99]",
  };
  state.owner.processIdentity = {
    kind: "linux-proc",
    ...scope,
    pidNamespace: "pid:[77]",
    startTicks: "10",
  };
  state.signalError = "ESRCH";
  state.output = JSON.stringify({
    ...scope,
    observerPidNamespace: scope.pidNamespace,
    observerTimeNamespace: scope.timeNamespace,
    helperPid: 123,
    selfStat: `123 (helper) ${["S", "1", "1", ...Array<string>(16).fill("0"), "10"].join(" ")}`,
    targetStat: null,
  });
  await iterator.next();
  await iterator.next();
  await iterator.next();
  assert.equal(state.queries, 1);
});

test("a live older owner still reports unsupported passive watching", async (t) => {
  const { state, iterator } = watchFixture(t);
  assert(state.owner);
  delete state.owner.sessionWatch;
  await iterator.next();
  await iterator.next();
  await assert.rejects(iterator.next(), { code: "WATCH_OWNER_UNSUPPORTED" });
});

test("a final marker precedes an unsupported owner published during the probe", async (t) => {
  const { state, iterator } = watchFixture(t);
  state.onQuery = async () => {
    assert(state.owner);
    state.owner.ownerGeneration += 1;
    delete state.owner.sessionWatch;
    state.requestId = null;
    state.event = {
      type: "turn_result",
      cursor: "2",
      requestId: "pending",
      result: { status: "completed" },
    };
    state.onQuery = async () => {};
  };
  await iterator.next();
  state.now += 2_000;
  assert.equal((await iterator.next()).value?.type, "turn_result");
  state.now += 2_000;
  await iterator.next();
  state.now += 2_000;
  await assert.rejects(iterator.next(), { code: "WATCH_OWNER_UNSUPPORTED" });
  assert.equal(state.queries, 2, "the replacement's own query also gets a journal reread");
});

test("slow watch consumers consume a same-owner decision before refreshing its observation", async (t) => {
  const { state, iterator } = watchFixture(t);
  await iterator.next();
  state.now = 2_000;
  await iterator.next();
  assert.equal(state.queries, 1);
  state.now = 4_000;
  await iterator.next();
  assert.equal(state.queries, 1, "the first post-probe journal pass must permit a decision");
  state.now = 6_000;
  await iterator.next();
  assert.equal(state.queries, 2, "ordinary cadence resumes after the decision pass");
});

test("Windows retirement metadata does not declare a still-live owner dead", async (t) => {
  const { state, iterator } = watchFixture(t, "win32");
  assert(state.owner);
  const identity: ProcessBirthIdentity = {
    kind: "windows-creation",
    value: "2026-09-21T10:00:01.0000000Z",
  };
  state.owner.processIdentity = identity;
  state.owner.retirement = {
    ownerGeneration: state.owner.ownerGeneration,
    root: { pid: fixturePid, processIdentity: identity },
    descendants: [],
  };
  state.output = `${fixturePid} 1 0 S ${identity.value}\n`;
  await iterator.next();
  await iterator.next();
  state.owner.retirement = null;
  await iterator.next();
  assert.equal(state.queries, 1);
});

test("closed history finishes after rereading an idle reused owner's journal", async (t) => {
  const { state, session, iterator } = watchFixture(t);
  state.requestId = null;
  state.output = `${fixturePid} 1 1 S Mon Sep 21 10:00:02 2026\n`;
  session.closed = true;
  await iterator.next();
  assert.equal((await iterator.next()).done, false);
  state.quiet = true;
  assert.equal((await iterator.next()).done, true);
  assert.equal(state.queries, 1);
  await iterator.return?.();
  state.now = 10_000;
  assert.equal((await iterator.next()).done, true);
  assert.equal(state.queries, 1);
});

test("closing during an idle identity query still delivers the final journal marker", async (t) => {
  const { state, session, iterator } = watchFixture(t);
  state.requestId = null;
  state.output = `${fixturePid} 1 1 S Mon Sep 21 10:00:02 2026\n`;
  state.onQuery = async () => {
    session.closed = true;
    state.owner = undefined;
    state.event = {
      type: "turn_result",
      cursor: "2",
      requestId: "late-turn",
      result: { status: "completed" },
    };
  };
  await iterator.next();
  assert.equal((await iterator.next()).value?.type, "turn_result");
  state.quiet = true;
  assert.equal((await iterator.next()).done, true);
});

test("returning during an identity query joins it without scheduling another observation", async (t) => {
  const { state, iterator } = watchFixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pendingQuery = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.onQuery = () => {
    entered();
    return pendingQuery;
  };
  await iterator.next();
  const pending = iterator.next();
  try {
    await started;
    const returned = iterator.return?.();
    release();
    await returned;
    assert.equal((await pending).done, true);
    state.now = 10_000;
    assert.equal((await iterator.next()).done, true);
    assert.equal(state.queries, 1);
  } finally {
    release();
  }
});
