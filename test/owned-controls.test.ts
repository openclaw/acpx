import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient } from "../src/acp/client.js";
import { withTimeout, type AcpControlAuthority } from "../src/async-control.js";
import { sessionEventLockPath } from "../src/session/event-log.js";
import {
  createOwnedSessionControls,
  runIdleOwnerControl,
} from "../src/session/execution/owned-controls.js";
import {
  QueueControlDeadline,
  QueueOwnerControlAdmission,
} from "../src/session/queue/control-admission.js";
import { acquireSessionTurn } from "../src/session/turn-ownership.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function context() {
  const record = makeSessionRecord({
    acpxRecordId: "owned-control",
    acpSessionId: "provider",
    agentCommand: "unused-test-agent",
    cwd: process.cwd(),
  });
  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    permissionMode: "deny-all",
  });
  return { record, client, sessionId: () => record.acpSessionId };
}

test("native void response clears the deadline before its checkpoint completes", async (t) => {
  const base = context(),
    checkpoint = deferred<void>();
  let retireCalls = 0;
  t.mock.method(
    base.client,
    "setSessionMode",
    async (_sessionId: string, _modeId: string, authority?: AcpControlAuthority) => {
      authority?.assertActive?.();
    },
  );
  const controls = createOwnedSessionControls({
    ...base,
    checkpoint: () => checkpoint.promise,
    retire: async () => {
      retireCalls++;
    },
  });
  const deadline = new QueueControlDeadline(20);
  let finished = false;
  const operation = controls.setSessionMode("plan", deadline).then(() => {
    finished = true;
  });
  await delay(40);
  assert.equal(deadline.signal.aborted, false);
  assert.equal(finished, false);
  assert.equal(base.record.acpx?.desired_mode_id, "plan");
  checkpoint.resolve();
  await operation;
  assert.equal(retireCalls, 0);
});

test("a native response racing timeout retirement still checkpoints before releasing its context", async (t) => {
  const base = context(),
    native = deferred<void>(),
    checkpoint = deferred<void>(),
    retiring = deferred<void>();
  t.mock.method(
    base.client,
    "setSessionMode",
    async (_sessionId: string, _modeId: string, authority?: AcpControlAuthority) => {
      authority?.assertActive?.();
      return await native.promise;
    },
  );
  const controls = createOwnedSessionControls({
    ...base,
    checkpoint: () => checkpoint.promise,
    retire: async () => {
      retiring.resolve();
    },
  });
  const deadline = new QueueControlDeadline(20);
  let finished = false;
  const operation = controls.setSessionMode("plan", deadline);
  void operation.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  const rejected = assert.rejects(operation, (error) => error === deadline.timeoutSignal.reason);
  await retiring.promise;
  assert.equal(finished, false);
  native.resolve();
  await delay(0);
  assert.equal(base.record.acpx?.desired_mode_id, "plan");
  assert.equal(finished, false);
  checkpoint.resolve();
  await rejected;
});

test("a failed checkpoint preserves accepted state and rejects the durable acknowledgement", async (t) => {
  const base = context(),
    failure = new Error("checkpoint failed");
  let retired = false;
  t.mock.method(base.client, "setSessionMode", async () => {});
  const controls = createOwnedSessionControls({
    ...base,
    checkpoint: async () => {
      throw failure;
    },
    retire: async () => {
      retired = true;
    },
  });
  await assert.rejects(controls.setSessionMode("plan"), (error) => error === failure);
  assert.equal(base.record.acpx?.desired_mode_id, "plan");
  assert.equal(retired, false);
});

test("owner shutdown preserves a control reply already admitted to the SDK", async (t) => {
  const base = context(),
    native = deferred<void>(),
    owner = new AbortController();
  let saved = false,
    retired = false;
  t.mock.method(
    base.client,
    "setSessionMode",
    async (_sessionId: string, _modeId: string, authority?: AcpControlAuthority) => {
      authority?.assertActive?.();
      return await native.promise;
    },
  );
  const controls = createOwnedSessionControls({
    ...base,
    checkpoint: async () => {
      saved = true;
    },
    retire: async () => {
      retired = true;
    },
  });
  const deadline = new QueueControlDeadline(1000, owner.signal);
  const operation = controls.setSessionMode("plan", deadline);
  owner.abort(new Error("owner stopping"));
  native.resolve();
  await operation;
  assert.equal(saved, true);
  assert.equal(retired, false);
  assert.equal(base.record.acpx?.desired_mode_id, "plan");
});

test("owner shutdown aborts an idle lock waiter without starting or closing the retained client", async (t) => {
  await withTempHome("acpx-idle-lock-control-", async (home) => {
    const record = makeSessionRecord({
      acpxRecordId: "locked-control",
      acpSessionId: "provider",
      agentCommand: "unused-test-agent",
      cwd: home,
    });
    await writeSessionRecordFile(home, record);
    const writer = await acquireSessionTurn(record.acpxRecordId);
    const entered = deferred<void>();
    const realpath = fs.realpath;
    t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] === path.dirname(sessionEventLockPath(record.acpxRecordId))) {
        entered.resolve();
      }
      return await realpath(...args);
    });
    let starts = 0,
      closes = 0;
    const client = new AcpClient({
      agentCommand: record.agentCommand,
      cwd: home,
      permissionMode: "deny-all",
    });
    t.mock.method(client, "start", async () => {
      starts++;
      throw new Error("unexpected backend startup");
    });
    t.mock.method(client, "close", async () => {
      closes++;
    });
    const admission = new QueueOwnerControlAdmission({
      runIdle: async (invoke, options) =>
        await runIdleOwnerControl(
          {
            ...options,
            client,
            sessionId: record.acpxRecordId,
            onRetirementFailure: () => assert.fail("unexpected retirement failure"),
          },
          invoke,
        ),
    });
    const operation = admission.run(
      async (controls, deadline) => await controls.setSessionMode("plan", deadline),
    );
    void operation.catch(() => {});
    try {
      await withTimeout(entered.promise, 1000);
      admission.stopAdmission();
      await assert.rejects(withTimeout(operation, 1000), {
        detailCode: "QUEUE_OWNER_SHUTTING_DOWN",
      });
      await admission.drainAdmitted();
      assert.equal(starts, 0);
      assert.equal(closes, 0);
    } finally {
      await writer[Symbol.asyncDispose]();
      await operation.catch(() => {});
    }
  });
});
