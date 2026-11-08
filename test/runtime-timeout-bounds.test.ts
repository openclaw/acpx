import assert from "node:assert/strict";
import test from "node:test";
import {
  AcpRuntimeError,
  AcpxRuntime,
  createAcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeTurnInput,
} from "../src/runtime.js";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import { createRuntimeOptions, InMemorySessionStore } from "./runtime-test-helpers.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const handle: AcpRuntimeHandle = {
  sessionKey: "timeout-boundary",
  backend: "acpx",
  runtimeSessionName: "timeout-boundary",
};

function isInvalidTimeout(error: unknown): boolean {
  assert.ok(error instanceof AcpRuntimeError);
  assert.equal(error.code, "ACP_INVALID_RUNTIME_OPTION");
  assert.match(error.message, /timeoutMs.*maximum supported timer delay/);
  assert.match(error.message, /Set timeoutMs to 2147483647 or less\./);
  return true;
}

function admissionRuntime() {
  const calls = { manager: 0, load: 0, save: 0, registry: 0 };
  const runtime = new AcpxRuntime(
    createRuntimeOptions({
      cwd: "/workspace",
      timeoutMs: 3_000,
      sessionStore: {
        async load() {
          calls.load++;
          return undefined;
        },
        async save() {
          calls.save++;
        },
      },
      agentRegistry: {
        resolve() {
          calls.registry++;
          return "unreachable --acp";
        },
        list() {
          return [];
        },
      },
    }),
    {
      managerFactory(options) {
        calls.manager++;
        return new AcpRuntimeManager(options);
      },
    },
  );
  return { runtime, calls };
}

for (const timeoutMs of [MAX_TIMER_DELAY_MS + 0.4, MAX_TIMER_DELAY_MS + 1, Number.MAX_VALUE]) {
  test(`embedded runtime rejects finite timeoutMs=${timeoutMs} above the native maximum`, () => {
    assert.throws(
      () =>
        createAcpRuntime(
          createRuntimeOptions({
            cwd: "/workspace",
            sessionStore: new InMemorySessionStore(),
            timeoutMs,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AcpRuntimeError);
        assert.equal(error.code, "ACP_INVALID_RUNTIME_OPTION");
        assert.match(error.message, /timeoutMs.*maximum supported timer delay/);
        assert.match(error.message, /Set timeoutMs to 2147483647 or less\./);
        return true;
      },
    );
  });
}

test("embedded runtime preserves supported timeout defaults, sentinels and fractions", async () => {
  for (const timeoutMs of [
    undefined,
    0,
    -1,
    Number.NaN,
    Infinity,
    -Infinity,
    0.4,
    1.6,
    MAX_TIMER_DELAY_MS - 0.4,
    MAX_TIMER_DELAY_MS,
  ]) {
    const runtime = createAcpRuntime(
      createRuntimeOptions({
        cwd: "/workspace",
        sessionStore: new InMemorySessionStore(),
        timeoutMs,
      }),
    );
    await runtime.shutdown();
  }
});

for (const method of ["startTurn", "runTurn"] as const) {
  test(`${method} preserves supported and sentinel timeout values at manager handoff`, async () => {
    for (const timeoutMs of [
      undefined,
      0,
      -1,
      Number.NaN,
      Infinity,
      -Infinity,
      0.4,
      MAX_TIMER_DELAY_MS - 0.4,
      MAX_TIMER_DELAY_MS,
    ]) {
      let forwardedTimeout: number | undefined;
      const runtime = new AcpxRuntime(
        createRuntimeOptions({
          cwd: "/workspace",
          sessionStore: new InMemorySessionStore(),
          timeoutMs: 3_000,
        }),
        {
          managerFactory(options) {
            const manager = new AcpRuntimeManager(options);
            const startTurn = manager.startTurn.bind(manager);
            manager.startTurn = (input) => {
              forwardedTimeout = input.timeoutMs;
              return startTurn(input);
            };
            return manager;
          },
        },
      );
      try {
        const input: AcpRuntimeTurnInput = {
          handle,
          timeoutMs,
          requestId: "supported-timeout",
          text: "missing local session",
          mode: "prompt",
        };
        if (method === "startTurn") {
          await runtime.startTurn(input).result;
        } else {
          for await (const event of runtime.runTurn(input)) {
            assert.notEqual(
              event.type === "error" ? event.code : undefined,
              "ACP_INVALID_RUNTIME_OPTION",
            );
          }
        }
        assert.ok(Object.is(forwardedTimeout, timeoutMs));
      } finally {
        await runtime.shutdown();
      }
    }
  });

  for (const timeoutMs of [MAX_TIMER_DELAY_MS + 0.4, MAX_TIMER_DELAY_MS + 1, Number.MAX_VALUE]) {
    test(`${method} rejects timeoutMs=${timeoutMs} before manager or session work`, async (t) => {
      const { runtime, calls } = admissionRuntime();
      t.after(() => runtime.shutdown());
      const input: AcpRuntimeTurnInput = {
        handle,
        timeoutMs,
        requestId: "invalid-timeout",
        text: "must not dispatch",
        mode: "prompt",
      };
      if (method === "startTurn") {
        assert.throws(() => runtime.startTurn(input), isInvalidTimeout);
      } else {
        const iterator = runtime.runTurn(input)[Symbol.asyncIterator]();
        t.after(async () => {
          await iterator.return?.();
        });
        await assert.rejects(iterator.next(), isInvalidTimeout);
      }
      assert.deepEqual(calls, { manager: 0, load: 0, save: 0, registry: 0 });
    });
  }

  test(`${method} gives an invalid timeout admission priority over an invalid handle`, async (t) => {
    const { runtime, calls } = admissionRuntime();
    t.after(() => runtime.shutdown());
    const input: AcpRuntimeTurnInput = {
      handle: { ...handle, runtimeSessionName: "" },
      timeoutMs: MAX_TIMER_DELAY_MS + 1,
      requestId: "double-invalid",
      text: "must not resolve handle",
      mode: "prompt",
    };
    if (method === "startTurn") {
      assert.throws(() => runtime.startTurn(input), isInvalidTimeout);
    } else {
      const iterator = runtime.runTurn(input)[Symbol.asyncIterator]();
      t.after(async () => {
        await iterator.return?.();
      });
      await assert.rejects(iterator.next(), isInvalidTimeout);
    }
    assert.deepEqual(calls, { manager: 0, load: 0, save: 0, registry: 0 });
  });

  test(`${method} forwards the timeout admitted before its asynchronous manager handoff`, async (t) => {
    let forwardedTimeout: number | undefined;
    const runtime = new AcpxRuntime(
      createRuntimeOptions({ cwd: "/workspace", sessionStore: new InMemorySessionStore() }),
      {
        managerFactory(options) {
          const manager = new AcpRuntimeManager(options);
          const startTurn = manager.startTurn.bind(manager);
          manager.startTurn = (input) => {
            forwardedTimeout = input.timeoutMs;
            return startTurn(input);
          };
          return manager;
        },
      },
    );
    t.after(() => runtime.shutdown());
    const input: AcpRuntimeTurnInput = {
      handle,
      timeoutMs: MAX_TIMER_DELAY_MS - 0.4,
      requestId: "capture-timeout",
      text: "missing local session",
      mode: "prompt",
    };
    if (method === "startTurn") {
      const turn = runtime.startTurn(input);
      input.timeoutMs = MAX_TIMER_DELAY_MS + 1;
      await turn.result;
    } else {
      const iterator = runtime.runTurn(input)[Symbol.asyncIterator]();
      t.after(async () => {
        await iterator.return?.();
      });
      const first = iterator.next();
      input.timeoutMs = MAX_TIMER_DELAY_MS + 1;
      await first;
    }
    assert.equal(forwardedTimeout, MAX_TIMER_DELAY_MS - 0.4);
  });
}
