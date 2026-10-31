import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import { createDeferred } from "../src/runtime/engine/turn.js";
import { createRuntimeOptions, InMemorySessionStore } from "./runtime-test-helpers.js";

for (const method of ["new", "load", "resume"] as const) {
  test(`session/${method} timeout closes the client without publishing or replacing a session`, async (t) => {
    const store = new InMemorySessionStore();
    const pending = createDeferred<{ sessionId: string }>();
    const calls: string[] = [];
    const manager = new AcpRuntimeManager(
      createRuntimeOptions({ cwd: "/workspace", sessionStore: store, timeoutMs: 20 }),
      {
        clientFactory: () =>
          ({
            start: async () => {},
            close: async () => {
              calls.push("close");
            },
            setEventHandlers: () => {},
            clearEventHandlers: () => {},
            supportsResumeSession: () => method === "resume",
            supportsLoadSession: () => true,
            createSession: () => {
              calls.push("new");
              return pending.promise;
            },
            loadSession: () => {
              calls.push("load");
              return pending.promise;
            },
            resumeSession: () => {
              calls.push("resume");
              return pending.promise;
            },
          }) as never,
      },
    );
    t.after(() => manager.shutdown());
    await assert.rejects(
      manager.ensureSession({
        sessionKey: "setup",
        agent: "codex",
        mode: "persistent",
        ...(method === "new" ? {} : { resumeSessionId: "native-session" }),
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "ACP_SESSION_INIT_FAILED");
        assert.match(error.message, new RegExp(`session/${method}.*20ms`));
        return true;
      },
    );
    assert.deepEqual(calls, [method, "close"]);
    assert.equal(store.records.size, 0);
    pending.resolve({ sessionId: "late-session" });
    await nextTurn();
    assert.equal(store.records.size, 0, "late setup completion must not publish a record");
  });
}

for (const timeoutMs of [100, 0, undefined]) {
  test(`session setup has an independent budget with timeoutMs=${timeoutMs}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initialized = createDeferred<void>();
    const created = createDeferred<{ sessionId: string }>();
    const creating = createDeferred<void>();
    const store = new InMemorySessionStore();
    const manager = new AcpRuntimeManager(
      createRuntimeOptions({ cwd: "/workspace", sessionStore: store, timeoutMs }),
      {
        clientFactory: () =>
          ({
            start: () => initialized.promise,
            close: async () => {},
            setEventHandlers: () => {},
            clearEventHandlers: () => {},
            createSession: () => {
              creating.resolve();
              return created.promise;
            },
            getAgentLifecycleSnapshot: () => ({ running: true }),
            requestCancelActivePrompt: async () => false,
            hasReusableSession: () => true,
          }) as never,
      },
    );
    t.after(() => manager.shutdown());
    const session = manager.ensureSession({
      sessionKey: "setup",
      agent: "codex",
      mode: "persistent",
    });
    await nextTurn();
    t.mock.timers.tick(timeoutMs === 100 ? 60 : 10_000);
    initialized.resolve();
    await creating.promise;
    // The total setup exceeds 100ms, but neither phase does.
    t.mock.timers.tick(timeoutMs === 100 ? 60 : 10_000);
    created.resolve({ sessionId: "native-session" });
    assert.equal((await session).acpSessionId, "native-session");
  });
}

test("session setup preserves native request errors", async (t) => {
  const failure = new Error("native setup failure");
  let closed = false;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({
      cwd: "/workspace",
      sessionStore: new InMemorySessionStore(),
      timeoutMs: 100,
    }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {
            closed = true;
          },
          setEventHandlers: () => {},
          clearEventHandlers: () => {},
          createSession: async () => {
            throw failure;
          },
        }) as never,
    },
  );
  t.after(() => manager.shutdown());
  await assert.rejects(
    manager.ensureSession({ sessionKey: "setup", agent: "codex", mode: "persistent" }),
    (error) => error === failure,
  );
  assert.equal(closed, true);
});
