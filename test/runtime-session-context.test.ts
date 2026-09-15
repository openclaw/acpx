import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import {
  AcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurn,
} from "../src/runtime.js";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import { InMemorySessionStore, withTempDir } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function withRuntime(
  run: (context: {
    runtime: ReturnType<typeof createAcpRuntime>;
    store: InMemorySessionStore;
    options: AcpRuntimeOptions;
    ensure: (key: string, mode?: "persistent" | "oneshot") => Promise<AcpRuntimeHandle>;
    root: string;
  }) => Promise<void>,
  overrides: Partial<AcpRuntimeOptions> = {},
) {
  await withTempDir("acpx-session-context-", async (root) => {
    const store = new InMemorySessionStore();
    const options: AcpRuntimeOptions = {
      cwd: root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [
            process.execPath,
            MOCK_AGENT_PATH,
            "--supports-load-session",
            "--supports-close-session",
            "--advertise-models",
            "--close-session-marker",
            path.join(root, "closed"),
          ],
        },
      }),
      permissionMode: "deny-all",
      ...overrides,
    };
    const runtime = createAcpRuntime(options);
    const ensure = async (sessionKey: string, mode: "persistent" | "oneshot" = "persistent") => {
      const handle = await runtime.ensureSession({ sessionKey, mode, agent: "fixture" });
      return handle;
    };
    try {
      await run({ runtime, store, options, ensure, root });
    } finally {
      await runtime.shutdown();
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function turnText(turn: AcpRuntimeTurn): Promise<string> {
  let text = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      text += event.text;
    }
  }
  const result = await turn.result;
  assert.equal(result.status, "completed", JSON.stringify(result));
  return text;
}

const prompt = {
  mode: "prompt",
  requestId: "context-test",
  text: "permission edit change",
} as const;

test("one runtime isolates concurrent session servers and turn permission callbacks", async () => {
  await withRuntime(
    async ({ runtime, ensure }) => {
      const [first, second] = await Promise.all([ensure("first"), ensure("second")]);
      const signals: AbortSignal[] = [];
      const seen: string[] = [];
      const pending = deferred<void>();
      const turns = [first, second].map((handle, index) =>
        runtime.startTurn({
          ...prompt,
          handle,
          onPermissionRequest: async (request, { signal }) => {
            assert.equal(request.sessionId, handle.backendSessionId);
            signals.push(signal);
            seen.push(handle.sessionKey);
            if (seen.length === 2) {
              pending.resolve();
            }
            await pending.promise;
            return { outcome: index === 0 ? "allow_once" : "reject_once" };
          },
        }),
      );
      assert.deepEqual(await Promise.all(turns.map(turnText)), [
        "permission selected:allow",
        "permission selected:reject",
      ]);
      assert.equal(
        signals.every((signal) => signal.aborted),
        true,
      );
      for (const handle of [first, second]) {
        assert.equal((await runtime.getStatus({ handle })).lastRequestId, prompt.requestId);
        const text = await turnText(
          runtime.startTurn({ ...prompt, handle, text: "session-mcp-servers" }),
        );
        assert.deepEqual(JSON.parse(text), [
          { name: handle.sessionKey, command: "fixture-tool", args: [], env: [] },
        ]);
        assert.equal(
          await turnText(runtime.startTurn({ ...prompt, handle })),
          "permission selected:reject",
        );
      }
    },
    {
      mcpServers: ({ sessionKey, cwd, agentCommand, agentArgv }) => {
        assert.equal(path.isAbsolute(cwd), true);
        assert.equal(agentCommand.startsWith(process.execPath), true);
        assert.equal(agentArgv?.[0], process.execPath);
        return [{ name: sessionKey, command: "fixture-tool", args: [], env: [] }];
      },
    },
  );
});

test("session servers are resolved again for reconnect and controls without entering stored state", async () => {
  let revision = 1;
  await withRuntime(
    async ({ runtime, ensure, options, store }) => {
      const handle = await ensure("reconnect");
      await runtime.close({ handle, reason: "disconnect" });
      revision = 2;
      const restarted = createAcpRuntime(options);
      try {
        await restarted.setConfigOption({ handle, key: "model", value: "fast-model" });
        const record = await store.load(handle.acpxRecordId!);
        assert.equal(JSON.stringify(record).includes("fixture-tool"), false);
        const text = await turnText(
          restarted.startTurn({ ...prompt, handle, text: "session-mcp-servers" }),
        );
        assert.deepEqual(JSON.parse(text), [
          { name: "reconnect-2", command: "fixture-tool", args: [], env: [] },
        ]);
        await restarted.close({ handle, reason: "retire", discardPersistentState: true });
      } finally {
        await restarted.close({ handle, reason: "test cleanup" });
      }
    },
    {
      mcpServers: ({ sessionKey }) => [
        { name: `${sessionKey}-${revision}`, command: "fixture-tool", args: [], env: [] },
      ],
    },
  );
});

test(
  "turn cancellation closes pending permission and rejects a late approval",
  { timeout: 10_000 },
  async () => {
    await withRuntime(async ({ runtime, ensure }) => {
      const handle = await ensure("cancel");
      const entered = deferred<AbortSignal>();
      const answer = deferred<{ outcome: "allow_once" }>();
      const turn = runtime.startTurn({
        ...prompt,
        handle,
        onPermissionRequest: async (_request, { signal }) => {
          entered.resolve(signal);
          return await answer.promise;
        },
      });
      const signal = await entered.promise;
      await turn.cancel();
      assert.equal(signal.aborted, true);
      let text = "";
      for await (const event of turn.events) {
        if (event.type === "text_delta") {
          text += event.text;
        }
      }
      await turn.result;
      assert.equal(text.includes("selected:allow"), false);
      answer.resolve({ outcome: "allow_once" });
      assert.equal(
        await turnText(runtime.startTurn({ ...prompt, handle })),
        "permission selected:reject",
      );
    });
  },
);

test("turn permission overrides leave runtime callback and configured fallback intact", async () => {
  let defaults = 0;
  await withRuntime(
    async ({ runtime, ensure }) => {
      const handle = await ensure("fallback");
      assert.equal(
        await turnText(runtime.startTurn({ ...prompt, handle })),
        "permission selected:allow",
      );
      for (const onPermissionRequest of [
        async () => undefined,
        async () => {
          throw new Error("unavailable");
        },
      ]) {
        assert.equal(
          await turnText(runtime.startTurn({ ...prompt, handle, onPermissionRequest })),
          "permission selected:reject",
        );
      }
      assert.equal(defaults, 1);
    },
    {
      onPermissionRequest: async () => {
        defaults++;
        return { outcome: "allow_once" };
      },
    },
  );
});

test("existing oneshot operations inspect models and close the adapter session", async () => {
  await withRuntime(async ({ runtime, ensure, store, root }) => {
    const handle = await ensure("catalog", "oneshot");
    assert.ok(
      (await runtime.getStatus({ handle })).models?.availableModelIds.includes("fast-model"),
    );
    await runtime.close({ handle, reason: "catalog inspected", discardPersistentState: true });
    assert.equal(
      (await fs.readFile(path.join(root, "closed"), "utf8")).trim(),
      handle.backendSessionId,
    );
    const record = await store.load(handle.acpxRecordId!);
    assert.equal(record?.closed, true);
    assert.equal(record?.acpx?.reset_on_next_ensure, true);
  });
});

for (const finish of ["close", "timeout"] as const) {
  test(
    `turn ${finish} aborts pending permission without waiting for the host`,
    { timeout: 10_000 },
    async () => {
      await withRuntime(async ({ runtime, ensure }) => {
        const handle = await ensure(finish);
        const entered = deferred<AbortSignal>();
        const answer = deferred<{ outcome: "allow_once" }>();
        const turn = runtime.startTurn({
          ...prompt,
          handle,
          ...(finish === "timeout" ? { timeoutMs: 100 } : {}),
          onPermissionRequest: async (_request, { signal }) => {
            entered.resolve(signal);
            return await answer.promise;
          },
        });
        const signal = await entered.promise;
        if (finish === "close") {
          await runtime.close({ handle, reason: "owner closed" });
        }
        await turn.result;
        assert.equal(signal.aborted, true);
        answer.resolve({ outcome: "allow_once" });
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            assert.equal(event.text.includes("selected:allow"), false);
          }
        }
      });
    },
  );
}

test("timeout revokes permission before waiting for late session updates", async () => {
  await withRuntime(async ({ runtime, ensure }) => {
    const handle = await ensure("deadline");
    const observed = deferred<boolean>();
    const turn = runtime.startTurn({
      ...prompt,
      handle,
      timeoutMs: 100,
      onPermissionRequest: async (_request, { signal }) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        observed.resolve(signal.aborted);
        return { outcome: "allow_once" };
      },
    });
    const revokedBeforeReply = await observed.promise;
    let text = "";
    for await (const event of turn.events) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }
    await turn.result;
    assert.equal(revokedBeforeReply, true);
    assert.equal(text.includes("selected:allow"), false);
  });
});

test("findSession restores an existing handle after restart without spawning or writing", async () => {
  await withRuntime(async ({ runtime, ensure, options, store }) => {
    const handle = await ensure("lookup");
    await runtime.close({ handle, reason: "restart" });
    let spawns = 0;
    const restarted = createAcpRuntime({
      ...options,
      processLifecycle: {
        onBeforeSpawn: async () => {
          spawns++;
          throw new Error("lookup must not spawn");
        },
      },
    });
    const writes = store.savedRecordIds.length;
    assert.deepEqual(
      await restarted.findSession({ sessionKey: "lookup", agent: "fixture" }),
      handle,
    );
    assert.equal(
      await restarted.findSession({ sessionKey: "absent", agent: "fixture" }),
      undefined,
    );
    assert.equal(store.savedRecordIds.length, writes);
    assert.equal(spawns, 0);
  });
});

test("shutdown closes retained clients and active permissions before returning", async () => {
  const pids: number[] = [];
  await withRuntime(
    async ({ runtime, ensure, store }) => {
      const idle = await ensure("idle");
      const handle = await ensure("active");
      const entered = deferred<AbortSignal>();
      const answer = deferred<{ outcome: "allow_once" }>();
      const turn = runtime.startTurn({
        ...prompt,
        handle,
        onPermissionRequest: async (_request, { signal }) => {
          entered.resolve(signal);
          return await answer.promise;
        },
      });
      const signal = await entered.promise;
      await runtime.shutdown();
      await turn.result;
      assert.equal(signal.aborted, true);
      answer.resolve({ outcome: "allow_once" });
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      assert.equal((await store.load(idle.acpxRecordId!))?.closed, false);
      await assert.rejects(ensure("late"), /shut down/);
      await assert.rejects(runtime.startTurn({ ...prompt, handle }).result, /shut down/);
      await assert.rejects(runtime.doctor(), /shut down/);
    },
    {
      processLifecycle: {
        onSpawned: async ({ pid }) => {
          pids.push(pid);
        },
      },
    },
  );
});

test("shutdown joins admitted startup and rejects queued ensure without leaking a child", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const pids: number[] = [];
  await withRuntime(
    async ({ runtime, ensure }) => {
      const first = assert.rejects(ensure("starting"), /shut down/);
      const queued = assert.rejects(ensure("starting"), /shut down/);
      await entered.promise;
      const shutdown = runtime.shutdown();
      release.resolve();
      await Promise.all([first, queued, shutdown]);
      assert.equal(pids.length, 0);
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    },
    {
      processLifecycle: {
        onBeforeSpawn: async () => {
          entered.resolve();
          await release.promise;
        },
        onSpawned: async ({ pid }) => {
          pids.push(pid);
        },
      },
    },
  );
});

test("shutdown terminates a probe blocked in initialization", { timeout: 5_000 }, async () => {
  const spawned = deferred<number>();
  await withRuntime(
    async ({ runtime }) => {
      const probe = assert.rejects(runtime.doctor(), /shut down/);
      const pid = await spawned.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await runtime.shutdown();
      await probe;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    },
    {
      probeAgent: "fixture",
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [process.execPath, "-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
        },
      }),
      processLifecycle: {
        onSpawned: async ({ pid }) => {
          spawned.resolve(pid);
        },
      },
    },
  );
});

for (const kind of ["cancelled", "invalid"] as const) {
  test(`shutdown joins admitted ${kind} cleanup after the retained owner is removed`, async () => {
    await withRuntime(async ({ options }) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const clientClosed = deferred<void>();
      let hold = false;
      const runtime = new AcpxRuntime(options, {
        managerFactory: (runtimeOptions) =>
          new AcpRuntimeManager(runtimeOptions, {
            clientFactory: (clientOptions) => {
              const client = new AcpClient(clientOptions);
              const close = client.close.bind(client);
              client.close = async () => {
                await close();
                clientClosed.resolve();
              };
              const wait = client.waitForSessionUpdatesIdle.bind(client);
              client.waitForSessionUpdatesIdle = async (input) => {
                if (hold) {
                  entered.resolve();
                  await release.promise;
                }
                await wait(input);
              };
              return client;
            },
          }),
      });
      try {
        const handle = await runtime.ensureSession({
          sessionKey: "cleanup",
          agent: "fixture",
          mode: "oneshot",
        });
        hold = true;
        const turn = runtime.startTurn({
          ...prompt,
          handle,
          ...(kind === "cancelled"
            ? { signal: AbortSignal.abort() }
            : { attachments: [{ mediaType: "application/unsupported", data: "fixture" }] }),
        });
        const cleanup =
          kind === "invalid"
            ? assert.rejects(turn.result, /Unsupported ACP runtime attachment/)
            : turn.result;
        await entered.promise;
        let stopped = false;
        const shutdown = runtime.shutdown().then(() => {
          stopped = true;
        });
        await clientClosed.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(stopped, false);
        hold = false;
        release.resolve();
        await Promise.all([cleanup, shutdown]);
      } finally {
        hold = false;
        release.resolve();
        await runtime.shutdown();
      }
    });
  });
}

test("shutdown joins the final record save of an admitted close", async () => {
  await withRuntime(async ({ runtime, ensure, store }) => {
    const handle = await ensure("closing");
    const entered = deferred<void>();
    const release = deferred<void>();
    const save = store.save.bind(store);
    store.save = async (record) => {
      if (record.closed) {
        entered.resolve();
        await release.promise;
      }
      await save(record);
    };
    try {
      const close = runtime.close({ handle, reason: "retire" });
      await entered.promise;
      let stopped = false;
      const shutdown = runtime.shutdown().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopped, false);
      release.resolve();
      await Promise.all([close, shutdown]);
    } finally {
      release.resolve();
    }
  });
});
