import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import type { SessionRecord } from "../src/types.js";
import { createRuntimeOptions, InMemorySessionStore } from "./runtime-test-helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Owner = {
  sessionId: string;
  closed: boolean;
  closeCalls: number;
  clearCalls: number;
  handlers: { onSessionUpdate?: (notification: SessionNotification) => void };
};

async function fixture(t: TestContext, count = 1) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new InMemorySessionStore();
  const save = store.save.bind(store);
  const owners: Owner[] = [];
  const saves: SessionRecord[] = [];
  const releases: Array<() => void> = [];
  const hooks: {
    save?: (record: SessionRecord) => Promise<void>;
    close?: (owner: Owner) => Promise<void>;
  } = {};
  store.save = async (record) => {
    const snapshot = structuredClone(record);
    saves.push(snapshot);
    await hooks.save?.(snapshot);
    await save(snapshot);
  };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/synthetic-shutdown", sessionStore: store }),
    {
      clientFactory: () => {
        const owner: Owner = {
          sessionId: `shutdown-native-${owners.length + 1}`,
          closed: false,
          closeCalls: 0,
          clearCalls: 0,
          handlers: {},
        };
        owners.push(owner);
        return {
          start: async () => {},
          createSession: async () => ({ sessionId: owner.sessionId }),
          close: async () => {
            owner.closeCalls += 1;
            await hooks.close?.(owner);
            owner.closed = true;
          },
          getAgentLifecycleSnapshot: () => ({ running: !owner.closed }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          hasReusableSession: () => !owner.closed,
          waitForSessionUpdatesIdle: async () => {},
          setEventHandlers: (handlers: Owner["handlers"]) => {
            owner.handlers = handlers;
          },
          clearEventHandlers: () => {
            owner.clearCalls += 1;
            owner.handlers = {};
          },
        } as never;
      },
    },
  );
  t.after(async () => {
    for (const release of releases) {
      release();
    }
    hooks.save = undefined;
    hooks.close = undefined;
    await manager.shutdown().catch(() => {});
  });
  const records: SessionRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    records.push(
      await manager.ensureSession({
        sessionKey: `shutdown-session-${index}`,
        agent: "fixture",
        mode: "persistent",
      }),
    );
  }
  const emit = (index: number, name = "idle-update") => {
    const owner = owners[index];
    assert.ok(owner);
    owner.handlers.onSessionUpdate?.({
      sessionId: owner.sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name, description: "Synthetic shutdown update" }],
      },
    });
  };
  const barrier = () => {
    const gate = deferred();
    releases.push(gate.resolve);
    return gate;
  };
  const commands = async (index = 0) =>
    (await store.load(records[index].acpxRecordId))?.acpx?.available_commands?.map(
      (entry) => entry.name,
    ) ?? [];
  return { manager, store, owners, records, saves, hooks, emit, barrier, commands };
}

function includesFailure(failure: unknown) {
  return (error: unknown) => error instanceof AggregateError && error.errors.includes(failure);
}

for (const fault of ["healthy", "once", "permanent"] as const) {
  test(`shutdown settles checkpoint cleanup and reports its own failures (${fault})`, async (t) => {
    const f = await fixture(t);
    const failure = new Error("shutdown checkpoint failed");
    let attempts = 0;
    f.hooks.save = async () => {
      attempts += 1;
      if (fault === "permanent" || (fault === "once" && attempts === 1)) {
        throw failure;
      }
    };
    f.emit(0);
    const shutdown = f.manager.shutdown();
    assert.equal(f.manager.shutdown(), shutdown);
    if (fault === "healthy") {
      await shutdown;
    } else {
      await assert.rejects(shutdown, includesFailure(failure));
    }
    assert.deepEqual(await f.commands(), fault === "permanent" ? [] : ["idle-update"]);
    assert.equal(attempts, fault === "healthy" ? 1 : 2);
    assert.equal(f.owners[0].closeCalls, 2);
    assert.equal(f.owners[0].closed, true);
    assert.equal(f.owners[0].clearCalls, 1);
    assert.deepEqual(f.owners[0].handlers, {});
  });
}

test("shutdown waits for another owner's pending save before reporting a failure", async (t) => {
  const f = await fixture(t, 2);
  const failure = new Error("first owner cannot save");
  const failedTwice = f.barrier();
  const secondEntered = f.barrier();
  const releaseSecond = f.barrier();
  let firstAttempts = 0;
  f.hooks.save = async (record) => {
    if (record.acpxRecordId === f.records[0].acpxRecordId) {
      firstAttempts += 1;
      if (firstAttempts === 2) {
        failedTwice.resolve();
      }
      throw failure;
    }
    secondEntered.resolve();
    await releaseSecond.promise;
  };
  f.emit(0);
  f.emit(1);
  let settled = false;
  const shutdown = f.manager.shutdown();
  void shutdown.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.all([failedTwice.promise, secondEntered.promise]);
  await nextTurn();
  assert.equal(settled, false);
  releaseSecond.resolve();
  await assert.rejects(shutdown, includesFailure(failure));
  assert.deepEqual(await f.commands(1), ["idle-update"]);
  assert(f.owners.every((owner) => owner.closed && owner.clearCalls === 1));
});

test("shutdown preserves close-time updates and the initial close failure", async (t) => {
  const f = await fixture(t);
  const failure = new Error("first close failed");
  f.hooks.close = async (owner) => {
    if (owner.closeCalls === 1) {
      throw failure;
    }
    assert.ok(owner.handlers.onSessionUpdate);
    f.emit(0, "received-during-close");
  };
  await assert.rejects(f.manager.shutdown(), includesFailure(failure));
  assert.deepEqual(await f.commands(), ["received-during-close"]);
  assert.equal(f.owners[0].closeCalls, 2);
  assert.equal(f.owners[0].closed, true);
  assert.equal(f.owners[0].clearCalls, 1);
});
