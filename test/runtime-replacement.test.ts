import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpxRuntime, type AcpRuntimeEnsureInput, type AcpRuntimeHandle } from "../src/runtime.js";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import { InMemorySessionStore, createRuntimeOptions } from "./runtime-test-helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Owner = {
  id: number;
  sessionId: string;
  cwd: string;
  closed: boolean;
  active: boolean;
  cancellations: number;
  handlers: { onSessionUpdate?: (notification: SessionNotification) => void };
};

async function fixture(t: TestContext, mode: AcpRuntimeEnsureInput["mode"] = "persistent") {
  const store = new InMemorySessionStore();
  const owners: Owner[] = [];
  const trace: string[] = [];
  const releases: Array<() => void> = [];
  const barrier = () => {
    const gate = deferred();
    releases.push(gate.resolve);
    return gate;
  };
  const heldPrompt = barrier();
  const hooks: {
    create?: (owner: Owner) => Promise<void>;
    close?: (owner: Owner) => Promise<void>;
    flush?: (owner: Owner) => Promise<void>;
    clear?: (owner: Owner) => void;
    control?: (owner: Owner) => Promise<void>;
    start?: (owner: Owner) => Promise<void>;
  } = {};
  const runtime = new AcpxRuntime(createRuntimeOptions({ cwd: "/old", sessionStore: store }), {
    managerFactory: (options) =>
      new AcpRuntimeManager(options, {
        clientFactory: (clientOptions) => {
          const owner: Owner = {
            id: owners.length + 1,
            sessionId: `native-${owners.length + 1}`,
            cwd: clientOptions.cwd,
            closed: false,
            active: false,
            cancellations: 0,
            handlers: {},
          };
          owners.push(owner);
          return {
            initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
            start: async () => {
              trace.push(`start:${owner.id}`);
              await hooks.start?.(owner);
            },
            createSession: async () => {
              trace.push(`create:${owner.id}`);
              await hooks.create?.(owner);
              return { sessionId: owner.sessionId };
            },
            loadSession: async (sessionId: string) => {
              owner.sessionId = sessionId;
              trace.push(`load:${owner.id}:${sessionId}`);
              return {};
            },
            loadSessionWithOptions: async (sessionId: string) => {
              owner.sessionId = sessionId;
              return {};
            },
            close: async () => {
              await hooks.close?.(owner);
              owner.closed = true;
              trace.push(`close:${owner.id}`);
            },
            supportsLoadSession: () => true,
            supportsResumeSession: () => false,
            hasReusableSession: (sessionId: string) =>
              !owner.closed && owner.sessionId === sessionId,
            getAgentLifecycleSnapshot: () => ({ running: !owner.closed }),
            setEventHandlers: (handlers: Owner["handlers"]) => {
              owner.handlers = handlers;
            },
            clearEventHandlers: () => {
              hooks.clear?.(owner);
              owner.handlers = {};
            },
            waitForSessionUpdatesIdle: async () => {
              await hooks.flush?.(owner);
            },
            hasActivePrompt: () => owner.active,
            requestCancelActivePrompt: async () => {
              owner.cancellations++;
              return false;
            },
            prompt: async (
              sessionId: string,
              text: string,
              written?: () => void | Promise<void>,
            ) => {
              assert.equal(owner.closed, false);
              assert.equal(sessionId, owner.sessionId);
              owner.active = true;
              trace.push(`prompt:${owner.id}:${text}`);
              await written?.();
              if (text === "hold") {
                await heldPrompt.promise;
              }
              owner.active = false;
              trace.push(`response:${owner.id}:${text}`);
              return { stopReason: "end_turn" };
            },
            setSessionMode: async () => {
              await hooks.control?.(owner);
            },
            setSessionConfigOption: async () => ({ configOptions: [] }),
          } as never;
        },
      }),
  });
  t.after(async () => {
    for (const release of releases) {
      release();
    }
    hooks.close = undefined;
    await runtime.shutdown();
  });
  const input: AcpRuntimeEnsureInput = {
    sessionKey: "session",
    agent: "fixture",
    mode,
    cwd: "/old",
    sessionOptions: { systemPrompt: "original" },
  };
  const handle = await runtime.ensureSession(input);
  const turn = (text: string, target: AcpRuntimeHandle = handle) =>
    runtime.startTurn({ handle: target, text, mode: "prompt", requestId: text });
  const emit = (update: SessionNotification["update"]) =>
    owners[0]?.handlers.onSessionUpdate?.({ sessionId: "native-1", update });
  return { runtime, store, owners, trace, hooks, input, handle, turn, emit, barrier, heldPrompt };
}

const busy = { code: "ACP_SESSION_INIT_FAILED", message: /unfinished/i };

for (const replacement of [
  { cwd: "/new" },
  { agent: "other" },
  { resumeSessionId: "resume-target" },
]) {
  test(
    `incompatible active ensure preserves the old owner: ${JSON.stringify(replacement)}`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const first = f.turn("hold");
      await first.promptStarted;
      const queued = f.turn("queued");
      await assert.rejects(f.runtime.ensureSession({ ...f.input, ...replacement }), busy);
      assert.equal(f.owners.length, 1);
      assert.equal(f.owners[0]?.closed, false);
      assert.equal(f.owners[0]?.cancellations, 0);
      assert.equal((await f.store.load("session"))?.acpSessionId, "native-1");
      f.heldPrompt.resolve();
      assert.equal((await first.result).status, "completed");
      assert.equal((await queued.result).status, "completed");
      const next = await f.runtime.ensureSession({ ...f.input, ...replacement });
      assert.equal((await f.turn("replacement", next).result).status, "completed");
      assert.ok(f.trace.indexOf("close:1") < f.trace.indexOf("start:2"));
      assert.deepEqual(
        f.trace.filter((event) => event.startsWith("prompt:")),
        ["prompt:1:hold", "prompt:1:queued", "prompt:2:replacement"],
      );
      assert.equal((await f.store.load("session"))?.acpSessionId, next.backendSessionId);
    },
  );
}

test(
  "compatible active ensure does not save an obsolete conversation snapshot",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const first = f.turn("hold");
    await first.promptStarted;
    const entered = f.barrier();
    const release = f.barrier();
    const load = f.store.load.bind(f.store);
    let hold = true;
    f.store.load = async (id) => {
      const snapshot = await load(id);
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    };
    const ensuring = f.runtime.ensureSession({
      ...f.input,
      sessionOptions: { systemPrompt: "ignored" },
    });
    void ensuring.catch(() => {});
    await entered.promise;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "new live output" },
    });
    t.mock.timers.tick(500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(JSON.stringify((await load("session"))?.messages).includes("new live output"));
    release.resolve();
    assert.equal((await ensuring).backendSessionId, f.handle.backendSessionId);
    assert.equal(f.owners.length, 1);
    const current = await load("session");
    assert.ok(JSON.stringify(current?.messages).includes("new live output"));
    assert.equal(current?.acpx?.session_options?.system_prompt, "original");
    f.heldPrompt.resolve();
    assert.equal((await first.result).status, "completed");
  },
);

test(
  "replacement rejects failed retirement and retries cleanup before creating an owner",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const failure = new Error("old owner close failed");
    let fail = true;
    f.hooks.close = async (owner) => {
      if (owner.id === 1 && fail) {
        fail = false;
        throw failure;
      }
    };
    await assert.rejects(
      f.runtime.ensureSession({ ...f.input, cwd: "/new" }),
      (error) => error === failure,
    );
    assert.equal(f.owners.length, 1);
    assert.equal((await f.store.load("session"))?.acpSessionId, "native-1");
    const next = await f.runtime.ensureSession({ ...f.input, cwd: "/new" });
    assert.equal(next.backendSessionId, "native-2");
    assert.ok(f.trace.indexOf("close:1") < f.trace.indexOf("start:2"));
  },
);

test(
  "replacement initialization excludes same-record work without blocking other records",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const entered = f.barrier();
    const release = f.barrier();
    f.hooks.create = async (owner) => {
      if (owner.cwd === path.resolve("/new")) {
        entered.resolve();
        await release.promise;
      }
    };
    const replacing = f.runtime.ensureSession({ ...f.input, cwd: "/new" });
    void replacing.catch(() => {});
    await entered.promise;
    const waiting = f.turn("after replacement");
    const other = await f.runtime.ensureSession({
      ...f.input,
      sessionKey: "independent",
      cwd: "/other",
    });
    assert.equal((await f.turn("independent", other).result).status, "completed");
    assert.equal(
      f.trace.some((event) => event.endsWith(":after replacement")),
      false,
    );
    assert.equal(f.owners.length, 3);
    release.resolve();
    const replacement = await replacing;
    assert.equal((await waiting.result).status, "completed");
    assert.ok(f.trace.includes("prompt:2:after replacement"));
    assert.equal((await f.store.load("session"))?.acpSessionId, replacement.backendSessionId);
  },
);

test(
  "compatible ensure cannot reopen a session before active close finishes",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const first = f.turn("hold");
    await first.promptStarted;
    await f.runtime.close({ handle: f.handle, reason: "test close" });
    await assert.rejects(f.runtime.ensureSession(f.input), busy);
    assert.equal((await f.store.load("session"))?.closed, true);
    f.heldPrompt.resolve();
    await first.result;
    const reopened = await f.runtime.ensureSession(f.input);
    assert.equal(reopened.backendSessionId, f.handle.backendSessionId);
    assert.equal((await f.store.load("session"))?.closed, false);
  },
);

for (const phase of ["preparation", "finalization"] as const) {
  test(
    `incompatible ensure cannot pass ${phase} or an already queued turn`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const entered = f.barrier();
      const release = f.barrier();
      const save = f.store.save.bind(f.store);
      let hold = true;
      f.store.save = async (record) => {
        const terminal = f.trace.includes("response:1:finish");
        if (hold && (phase === "preparation" || terminal)) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        await save(record);
      };
      const first = f.turn(phase === "preparation" ? "hold" : "finish");
      await entered.promise;
      const queued = f.turn("hold");
      let settled = false;
      const replacing = f.runtime.ensureSession({ ...f.input, cwd: "/new" });
      void replacing
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, true);
      assert.equal(f.owners.length, 1);
      release.resolve();
      await assert.rejects(replacing, busy);
      f.heldPrompt.resolve();
      assert.equal((await first.result).status, "completed");
      assert.equal((await queued.result).status, "completed");
      assert.equal((await f.store.load("session"))?.acpSessionId, "native-1");
    },
  );
}

test(
  "idle replacement waits for old-owner close before starting its candidate",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const entered = f.barrier();
    const release = f.barrier();
    f.hooks.close = async (owner) => {
      if (owner.id === 1) {
        entered.resolve();
        await release.promise;
      }
    };
    const replacing = f.runtime.ensureSession({ ...f.input, cwd: "/new" });
    void replacing.catch(() => {});
    await entered.promise;
    assert.equal(f.owners.length, 1);
    assert.equal((await f.store.load("session"))?.acpSessionId, "native-1");
    release.resolve();
    const next = await replacing;
    assert.equal(next.backendSessionId, "native-2");
    assert.ok(f.trace.indexOf("close:1") < f.trace.indexOf("start:2"));
  },
);

test(
  "failed replacement leaves the old saved identity resumable by waiting work",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const entered = f.barrier();
    const release = f.barrier();
    const failure = new Error("candidate initialization failed");
    f.hooks.create = async (owner) => {
      if (owner.id === 2) {
        entered.resolve();
        await release.promise;
        throw failure;
      }
    };
    const rejected = assert.rejects(
      f.runtime.ensureSession({ ...f.input, cwd: "/new" }),
      (error) => error === failure,
    );
    await entered.promise;
    const next = f.turn("after failed replacement");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.owners.length, 2);
    assert.equal(
      f.trace.some((event) => event.endsWith(":after failed replacement")),
      false,
    );
    release.resolve();
    await rejected;
    assert.equal((await next.result).status, "completed");
    assert.equal(f.owners[1]?.closed, true);
    assert.equal(f.owners[2]?.cwd, path.resolve("/old"));
    assert.equal((await f.store.load("session"))?.acpSessionId, "native-1");
  },
);

test(
  "shutdown retires a candidate and rejects same-record work waiting for initialization",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const entered = f.barrier();
    const release = f.barrier();
    f.hooks.create = async (owner) => {
      if (owner.id === 2) {
        entered.resolve();
        await release.promise;
      }
    };
    const rejected = assert.rejects(f.runtime.ensureSession({ ...f.input, cwd: "/new" }), {
      code: "ACP_BACKEND_UNAVAILABLE",
    });
    await entered.promise;
    const queued = f.turn("never sent");
    const stopping = f.runtime.shutdown();
    release.resolve();
    await rejected;
    await stopping;
    assert.equal((await queued.result).status, "failed");
    assert.equal(
      f.trace.some((event) => event.startsWith("prompt:")),
      false,
    );
    assert.equal(f.owners.length, 2);
    assert.ok(f.owners.every((owner) => owner.closed));
  },
);

test(
  "a new oneshot owner does not block work on the previous oneshot record",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "oneshot");
    const entered = f.barrier();
    const release = f.barrier();
    f.hooks.create = async (owner) => {
      if (owner.id === 2) {
        entered.resolve();
        await release.promise;
      }
    };
    const creating = f.runtime.ensureSession({ ...f.input, cwd: "/new" });
    void creating.catch(() => {});
    await entered.promise;
    const previous = f.turn("independent previous oneshot");
    let finished = false;
    void previous.result.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, true);
    assert.equal((await previous.result).status, "completed");
    release.resolve();
    const next = await creating;
    assert.notEqual(next.acpxRecordId, f.handle.acpxRecordId);
    assert.equal((await f.turn("new oneshot", next).result).status, "completed");
  },
);

test(
  "oneshot ensure cannot reopen an owner retired during its lookup",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "oneshot");
    const entered = f.barrier();
    const release = f.barrier();
    let hold = true;
    f.hooks.flush = async () => {
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
    };
    const ensuring = f.runtime.ensureSession(f.input);
    void ensuring.catch(() => {});
    await entered.promise;
    await f.runtime.close({ handle: f.handle, reason: "close during lookup" });
    assert.equal((await f.store.load(f.handle.acpxRecordId!))?.closed, true);
    release.resolve();
    const next = await ensuring;
    assert.notEqual(next.acpxRecordId, f.handle.acpxRecordId);
    assert.equal((await f.store.load(f.handle.acpxRecordId!))?.closed, true);
    assert.equal((await f.turn("new oneshot", next).result).status, "completed");
  },
);

for (const failSave of [false, true]) {
  test(
    `retirement drains its final checkpoint before replacement (${failSave ? "failure" : "success"})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const entered = f.barrier();
      const release = f.barrier();
      const failure = new Error("retirement checkpoint failed");
      const save = f.store.save.bind(f.store);
      let emitted = false;
      f.hooks.clear = (owner) => {
        if (owner.id === 1 && !emitted) {
          emitted = true;
          f.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "final retirement output" },
          });
        }
      };
      f.store.save = async (record) => {
        const snapshot = structuredClone(record);
        if (JSON.stringify(snapshot.messages).includes("final retirement output")) {
          entered.resolve();
          await release.promise;
          if (failSave) {
            throw failure;
          }
        }
        await save(snapshot);
      };
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const replacing = f.runtime.ensureSession({ ...f.input, cwd: "/new" });
      void replacing.catch(() => {});
      await entered.promise;
      assert.equal(f.owners[0]?.closed, true);
      assert.equal(f.owners.length, 1);
      release.resolve();
      if (failSave) {
        await assert.rejects(replacing, (error) => error === failure);
        assert.equal(f.owners.length, 1);
        await assert.rejects(
          f.runtime.ensureSession({ ...f.input, cwd: "/new" }),
          (error) => error === failure,
        );
        assert.equal(f.owners.length, 1);
        f.store.save = save;
      } else {
        assert.equal((await replacing).backendSessionId, "native-2");
      }
      const replacement = await f.runtime.ensureSession({ ...f.input, cwd: "/new" });
      t.mock.timers.tick(1000);
      assert.equal((await f.turn("after retirement", replacement).result).status, "completed");
      assert.equal((await f.store.load("session"))?.acpSessionId, "native-2");
      assert.equal(f.owners.length, 2);
    },
  );
}

test(
  "replacement can start immediately after the previous turn result settles",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.turn("finish").result).status, "completed");
    const next = await f.runtime.ensureSession({ ...f.input, cwd: "/new" });
    assert.equal(next.backendSessionId, "native-2");
    assert.equal((await f.turn("replacement", next).result).status, "completed");
  },
);

test(
  "a turn submitted after replacement reservation waits for the new owner",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const entered = f.barrier();
    const release = f.barrier();
    const load = f.store.load.bind(f.store);
    let reads = 0;
    f.store.load = async (id) => {
      const record = await load(id);
      if (++reads === 2) {
        entered.resolve();
        await release.promise;
      }
      return record;
    };
    const replacing = f.runtime.ensureSession({ ...f.input, cwd: "/new" });
    void replacing.catch(() => {});
    await entered.promise;
    const follower = f.turn("follower");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      f.trace.some((event) => event.startsWith("prompt:")),
      false,
    );
    release.resolve();
    const next = await replacing;
    assert.equal((await follower.result).status, "completed");
    assert.ok(f.trace.includes("prompt:2:follower"));
    assert.equal((await load("session"))?.acpSessionId, next.backendSessionId);
  },
);

test(
  "reopening a controlled record cannot overwrite a later accepted control",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.runtime.close({ handle: f.handle, reason: "reconnect control" });
    const controlEntered = f.barrier();
    const releaseControl = f.barrier();
    const acknowledged = f.barrier();
    f.hooks.start = async () => {
      controlEntered.resolve();
      await releaseControl.promise;
    };
    f.hooks.control = async () => {
      acknowledged.resolve();
    };
    const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
    void changing.catch(() => {});
    await controlEntered.promise;
    const saving = f.barrier();
    const releaseSave = f.barrier();
    const save = f.store.save.bind(f.store);
    let hold = true;
    f.store.save = async (record) => {
      const snapshot = structuredClone(record);
      if (hold && !snapshot.closed && !snapshot.acpx?.desired_mode_id) {
        hold = false;
        saving.resolve();
        await releaseSave.promise;
      }
      await save(snapshot);
    };
    const ensuring = f.runtime.ensureSession(f.input);
    void ensuring.catch(() => {});
    await saving.promise;
    releaseControl.resolve();
    await acknowledged.promise;
    let controlFinished = false;
    void changing.then(
      () => {
        controlFinished = true;
      },
      () => {},
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controlFinished, false);
    releaseSave.resolve();
    await ensuring;
    await changing;
    const record = await f.store.load("session");
    assert.equal(record?.closed, false);
    assert.equal(record?.acpx?.desired_mode_id, "plan");
  },
);
