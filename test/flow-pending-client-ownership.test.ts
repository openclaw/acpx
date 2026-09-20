import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { FlowRunner, acp, defineFlow } from "../src/flows/runtime.js";
import type { FlowRunStore } from "../src/flows/store.js";
import type {
  FlowDefinition,
  FlowRunResult,
  FlowRunState,
  FlowSessionBinding,
} from "../src/flows/types.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTemporaryHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-client-ownership-"));
  process.env.HOME = homeDir;
  try {
    await run(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

type CreatedNativeSession = {
  client: AcpClient;
  sessionId: string;
  pid: number | undefined;
};

function observeNativeClients(t: TestContext) {
  const clients = new Set<AcpClient>();
  const createRequests: AcpClient[] = [];
  const created: CreatedNativeSession[] = [];
  const promptRequests: Array<{ client: AcpClient; sessionId: string }> = [];
  const loadRequests: Array<{ client: AcpClient; sessionId: string }> = [];
  const closeCalls = new Map<AcpClient, number>();
  const originalStart = AcpClient.prototype.start;
  const originalCreate = AcpClient.prototype.createSession;
  const originalPrompt = AcpClient.prototype.prompt;
  const originalLoad = AcpClient.prototype.loadSessionWithOptions;
  const originalClose = AcpClient.prototype.close;

  // These wrappers observe real ACP methods and preserve their arguments,
  // results, errors, process launches, and protocol requests unchanged.
  t.mock.method(
    AcpClient.prototype,
    "start",
    async function (this: AcpClient, ...args: Parameters<AcpClient["start"]>) {
      clients.add(this);
      await originalStart.apply(this, args);
    },
  );
  t.mock.method(
    AcpClient.prototype,
    "createSession",
    async function (this: AcpClient, ...args: Parameters<AcpClient["createSession"]>) {
      createRequests.push(this);
      const result = await originalCreate.apply(this, args);
      created.push({ client: this, sessionId: result.sessionId, pid: this.getAgentPid() });
      return result;
    },
  );
  t.mock.method(
    AcpClient.prototype,
    "prompt",
    async function (this: AcpClient, ...args: Parameters<AcpClient["prompt"]>) {
      promptRequests.push({ client: this, sessionId: args[0] });
      return await originalPrompt.apply(this, args);
    },
  );
  t.mock.method(
    AcpClient.prototype,
    "loadSessionWithOptions",
    async function (this: AcpClient, ...args: Parameters<AcpClient["loadSessionWithOptions"]>) {
      loadRequests.push({ client: this, sessionId: args[0] });
      return await originalLoad.apply(this, args);
    },
  );
  t.mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
    closeCalls.set(this, (closeCalls.get(this) ?? 0) + 1);
    await originalClose.call(this);
  });

  return {
    clients,
    createRequests,
    created,
    promptRequests,
    loadRequests,
    closeCalls,
    async cleanup() {
      // Close every actually started synthetic client, including a reconnect
      // that failed before session creation. This also cleans a failing oracle.
      await Promise.allSettled([...clients].map((client) => originalClose.call(client)));
    },
  };
}

function runStore(runner: FlowRunner): FlowRunStore {
  return (runner as unknown as { store: FlowRunStore }).store;
}

function makeRunner(homeDir: string, agentFlags: string[]): FlowRunner {
  return new FlowRunner({
    outputRoot: path.join(homeDir, "runs"),
    permissionMode: "deny-all",
    suppressSdkConsoleErrors: true,
    defaultNodeTimeoutMs: 20_000,
    resolveAgent: () => ({
      agentName: "mock",
      agentCommand: "synthetic-flow-agent",
      agentArgv: [process.execPath, MOCK_AGENT_PATH, ...agentFlags],
      cwd: homeDir,
    }),
  });
}

function singlePromptFlow(handle: string): FlowDefinition {
  return defineFlow({
    name: "concurrent-pending-clients",
    startAt: "work",
    nodes: {
      work: acp({
        heartbeatMs: 0,
        session: { handle },
        prompt: ({ input }) => `echo ${String(input)}`,
        parse: (text) => text.trim(),
      }),
    },
    edges: [],
  });
}

function observeRun(running: Promise<FlowRunResult>) {
  return running.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

type ObservedRun = ReturnType<typeof observeRun>;

function onlyBinding(state: FlowRunState): FlowSessionBinding {
  const bindings = Object.values(state.sessionBindings);
  assert.equal(bindings.length, 1);
  return bindings[0];
}

for (const keys of ["same", "different"] as const) {
  test(
    `FlowRunner keeps pending native clients independent across concurrent ${keys}-key runs`,
    { concurrency: false, timeout: 30_000 },
    async (t) => {
      await withTemporaryHome(async (homeDir) => {
        const native = observeNativeClients(t);
        // A first prompt must use its creating process: a new mock process
        // deliberately rejects loading an empty session created elsewhere.
        const runner = makeRunner(homeDir, [
          "--supports-load-session",
          "--load-session-fails-on-empty",
        ]);
        const store = runStore(runner);
        const originalEnsure = store.ensureSessionBundle.bind(store);
        const aHeld = deferred();
        const releaseA = deferred();
        let heldA: { binding: FlowSessionBinding; native: CreatedNativeSession } | undefined;
        let runningA: ObservedRun | undefined;
        let runningB: ObservedRun | undefined;

        t.mock.method(
          store,
          "ensureSessionBundle",
          async (...args: Parameters<FlowRunStore["ensureSessionBundle"]>) => {
            // Publish the real session bundle, then hold its completion while
            // FlowRunner still owns the newly created, unconsumed client.
            await originalEnsure(...args);
            const [, state, binding, record] = args;
            if (state.input === "A" && record && !heldA) {
              const created = native.created.find(
                (entry) => entry.sessionId === record.acpSessionId,
              );
              assert.ok(created, "held client identity must come from a real session/new response");
              assert.equal(binding.acpSessionId, created.sessionId);
              heldA = { binding: { ...binding }, native: created };
              aHeld.resolve();
              await releaseA.promise;
            }
          },
        );

        try {
          runningA = observeRun(runner.run(singlePromptFlow("main"), "A"));
          await Promise.race([
            aHeld.promise,
            runningA.then((result) => {
              if (!result.ok) {
                throw result.error;
              }
              throw new Error("Run A completed without entering its pending-client barrier");
            }),
          ]);
          assert.ok(heldA);
          const a = heldA.native;
          assert.equal(native.created.length, 1);
          assert.equal(typeof a.pid, "number");
          assert.equal(a.client.getAgentLifecycleSnapshot().running, true);
          assert.equal(native.closeCalls.get(a.client) ?? 0, 0);
          assert.equal(native.promptRequests.length, 0);

          runningB = observeRun(
            runner.run(singlePromptFlow(keys === "same" ? "main" : "other"), "B"),
          );
          const bResult = await runningB;
          assert.equal(bResult.ok, true);
          assert.equal(bResult.value.state.status, "completed");
          assert.equal(bResult.value.state.outputs.work, "B");
          const bBinding = onlyBinding(bResult.value.state);
          const b = native.created.find((entry) => entry.sessionId === bBinding.acpSessionId);
          assert.ok(b);
          assert.equal(native.created.length, 2);
          assert.notEqual(a.client, b.client);
          assert.notEqual(a.sessionId, b.sessionId);
          assert.notEqual(a.pid, b.pid);
          assert.notEqual(heldA.binding.acpxRecordId, bBinding.acpxRecordId);
          assert.equal(heldA.binding.key === bBinding.key, keys === "same");

          // B's prompt and final cleanup cannot borrow or retire A's client.
          assert.deepEqual(native.promptRequests, [{ client: b.client, sessionId: b.sessionId }]);
          assert.equal(native.closeCalls.get(a.client) ?? 0, 0);
          assert.equal(a.client.getAgentLifecycleSnapshot().running, true);
          assert.equal(b.client.getAgentLifecycleSnapshot().running, false);
          assert.ok((native.closeCalls.get(b.client) ?? 0) > 0);
          assert.deepEqual(native.loadRequests, []);

          releaseA.resolve();
          const aResult = await runningA;
          assert.equal(aResult.ok, true);
          assert.equal(aResult.value.state.status, "completed");
          assert.equal(aResult.value.state.outputs.work, "A");
          const aBinding = onlyBinding(aResult.value.state);
          assert.equal(aBinding.acpxRecordId, heldA.binding.acpxRecordId);
          assert.equal(aBinding.acpSessionId, a.sessionId);
          assert.equal(bBinding.acpSessionId, b.sessionId);
          assert.deepEqual(native.promptRequests, [
            { client: b.client, sessionId: b.sessionId },
            { client: a.client, sessionId: a.sessionId },
          ]);
          assert.deepEqual(native.loadRequests, []);
          assert.equal(native.createRequests.length, 2);
          assert.equal(native.clients.size, 2);
          assert.ok((native.closeCalls.get(a.client) ?? 0) > 0);
          assert.equal(a.client.getAgentLifecycleSnapshot().running, false);
          assert.equal(b.client.getAgentLifecycleSnapshot().running, false);
        } finally {
          releaseA.resolve();
          await Promise.allSettled([runningA, runningB]);
          await native.cleanup();
        }
      });
    },
  );
}

test(
  "FlowRunner does not create a replacement native session when reconnecting the saved session fails",
  { concurrency: false, timeout: 30_000 },
  async (t) => {
    await withTemporaryHome(async (homeDir) => {
      const native = observeNativeClients(t);
      const runner = makeRunner(homeDir, ["--supports-load-session", "--load-session-not-found"]);
      const store = runStore(runner);
      const originalEnsure = store.ensureSessionBundle.bind(store);
      let runDir: string | undefined;
      t.mock.method(
        store,
        "ensureSessionBundle",
        async (...args: Parameters<FlowRunStore["ensureSessionBundle"]>) => {
          runDir = args[0];
          await originalEnsure(...args);
        },
      );

      try {
        const result = await observeRun(
          runner.run(
            defineFlow({
              name: "saved-native-session-load-failure",
              startAt: "first",
              nodes: {
                first: acp({
                  heartbeatMs: 0,
                  prompt: () => "echo first",
                  parse: (text) => text.trim(),
                }),
                second: acp({
                  heartbeatMs: 0,
                  prompt: () => "echo must-not-run",
                  parse: (text) => text.trim(),
                }),
              },
              edges: [{ from: "first", to: "second" }],
            }),
            {},
          ),
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.match(
            String(result.error),
            /Persistent ACP session .* could not be resumed: .*resource not found/i,
          );
        }
        assert.ok(runDir);
        assert.equal(native.created.length, 1);
        assert.equal(
          native.createRequests.length,
          1,
          "failed session/load must not admit session/new",
        );
        const original = native.created[0];
        assert.equal(native.loadRequests.length, 1);
        assert.equal(native.loadRequests[0].sessionId, original.sessionId);
        assert.notEqual(native.loadRequests[0].client, original.client);
        assert.deepEqual(native.promptRequests, [
          { client: original.client, sessionId: original.sessionId },
        ]);
        assert.equal(
          native.clients.size,
          2,
          "the second native process must attempt saved-session load",
        );
        for (const client of native.clients) {
          assert.equal(client.getAgentLifecycleSnapshot().running, false);
        }

        const state = JSON.parse(
          await fs.readFile(path.join(runDir, "projections/run.json"), "utf8"),
        ) as FlowRunState;
        assert.equal(state.status, "failed");
        assert.equal(state.results.first?.outcome, "ok");
        assert.equal(state.results.second?.outcome, "failed");
        assert.equal(state.outputs.first, "first");
        assert.equal(state.outputs.second, undefined);
        assert.equal(onlyBinding(state).acpSessionId, original.sessionId);
      } finally {
        await native.cleanup();
      }
    });
  },
);
