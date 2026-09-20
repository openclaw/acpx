import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import timers from "node:timers/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { AcpClient } from "../src/acp/client.js";
import { TerminalManager } from "../src/acp/terminal-manager.js";
import { TimeoutError } from "../src/async-control.js";
import { acp, defineFlow, FlowRunner } from "../src/flows/runtime.js";
import { sessionEventLockPath } from "../src/session/event-log.js";
import type { RunOnceOptions } from "../src/session/execution/contracts.js";
import { DISCARD_OUTPUT_FORMATTER } from "../src/session/execution/discard-output.js";
import { runOnce, sendSessionDirect } from "../src/session/execution/runtime.js";
import { createSessionWithClient } from "../src/session/execution/session-management.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import type { AcpClientOptions } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// A native stdio peer records actual received requests, independently of client observations.
// The held prompt never answers cancellation; retirement must settle the native request.
const PEER = String.raw`
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const [logPath, mode] = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const update = (sessionId, text) => send({ method: 'session/update', params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} });
log({ method: 'started' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const text = params?.prompt?.filter((part) => part.type === 'text').map((part) => part.text).join('');
  log({ method, sessionId: params?.sessionId, text });
  if (method === 'initialize') {
    reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  } else if (method === 'session/new') {
    reply(id, { sessionId: 'owned-fixture-session' });
  } else if (method === 'session/load') {
    if (mode === 'load-failure') {
      send({ id, error: { code: -32002, message: 'Saved session unavailable' } });
    } else {
      reply(id, {});
    }
  } else if (method === 'session/prompt') {
    update(params.sessionId, text === 'hold' ? 'native-rpc-ready' : 'native answer');
    if (text !== 'hold') reply(id, { stopReason: 'end_turn' });
  }
});
`;

type PeerEntry = { pid: number; method: string; sessionId?: string; text?: string };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function observe(pending: Promise<unknown>) {
  let settled = false;
  const outcome = pending.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  return { outcome, settled: () => settled };
}

function containsError(error: unknown, expected: Error): boolean {
  if (error === expected) {
    return true;
  }
  if (
    error instanceof AggregateError &&
    error.errors.some((item) => containsError(item, expected))
  ) {
    return true;
  }
  return (
    error instanceof Error && error.cause !== undefined && containsError(error.cause, expected)
  );
}

async function nativePeer(home: string, mode = "normal") {
  const source = path.join(home, "owned-peer.mjs");
  const log = path.join(home, "native-requests.jsonl");
  await fs.writeFile(source, PEER);
  await fs.writeFile(log, "");
  return {
    ...normalizeAgentCommandInput([process.execPath, source, log, mode]),
    async entries(): Promise<PeerEntry[]> {
      return (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PeerEntry);
    },
  };
}

function trackClients(t: TestContext, beforeSpawn?: () => Promise<void>) {
  const clients = new Set<AcpClient>();
  const pids = new Set<number>();
  const start = AcpClient.prototype.start;
  t.mock.method(
    AcpClient.prototype,
    "start",
    async function (this: AcpClient, ...args: Parameters<typeof start>) {
      if (!clients.has(this)) {
        clients.add(this);
        const options = (this as unknown as { options: AcpClientOptions }).options;
        const previous = options.processLifecycle;
        options.processLifecycle = {
          ...previous,
          onBeforeSpawn: async (launch) => {
            await previous?.onBeforeSpawn?.(launch);
            await beforeSpawn?.();
          },
          onSpawned: async (spawned) => {
            pids.add(spawned.pid);
            await previous?.onSpawned?.(spawned);
          },
        };
      }
      await start.apply(this, args);
    },
  );
  const close = async () => {
    await Promise.all([...clients].map((client) => client.close()));
  };
  t.signal.addEventListener(
    "abort",
    () => {
      void close().catch(() => {});
    },
    { once: true },
  );
  return {
    pids,
    close,
    assertRetired() {
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    },
  };
}

for (const isolated of [true, false]) {
  test(
    `FlowRunner joins held ${isolated ? "isolated" : "persistent"} native startup after its deadline`,
    { timeout: 15_000 },
    async (t) => {
      await withTempHome("acpx-flow-native-start-", async (home) => {
        const peer = await nativePeer(home);
        const entered = gate();
        const released = gate();
        const closed = gate();
        const clients = trackClients(t, async () => {
          entered.release();
          await released.promise;
        });
        const close = AcpClient.prototype.close;
        t.mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
          await close.call(this);
          closed.release();
        });
        const runner = new FlowRunner({
          resolveAgent: () => ({ agentName: "fixture", ...peer, cwd: home }),
          permissionMode: "deny-all",
          outputRoot: path.join(home, "runs"),
        });
        const flow = defineFlow({
          name: "held-native-start",
          startAt: "held",
          nodes: {
            held: acp({
              session: { isolated },
              timeoutMs: 20_000,
              heartbeatMs: 0,
              prompt: () => "never admitted",
            }),
          },
          edges: [],
        });
        const abortCleanup = () => {
          released.release();
          t.mock.timers.reset();
          void clients.close().catch(() => {});
        };
        t.signal.addEventListener("abort", abortCleanup, { once: true });
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const run = observe(runner.run(flow, {}));
        try {
          await entered.promise;
          t.mock.timers.tick(20_000);
          await closed.promise;
          t.mock.timers.reset();
          await nextTurn();
          assert.equal(run.settled(), false, "the runner must join admitted startup preparation");
          released.release();
          const result = await run.outcome;
          assert.equal(result.ok, false);
          if (!result.ok) {
            assert.ok(result.error instanceof TimeoutError);
          }
          assert.deepEqual(
            await peer.entries(),
            [],
            "revoked startup must not spawn a native peer",
          );
          assert.equal(clients.pids.size, 0);
        } finally {
          released.release();
          t.mock.timers.reset();
          t.signal.removeEventListener("abort", abortCleanup);
          await clients.close();
        }
      });
    },
  );
}

for (const mode of ["isolated", "persistent"] as const) {
  test(
    `${mode} owned direct prompt rechecks authority before its native write`,
    { timeout: 15_000 },
    async (t) => {
      await withTempHome("acpx-flow-native-prompt-", async (home) => {
        const peer = await nativePeer(home);
        const clients = trackClients(t);
        const controller = new AbortController();
        const reason = new Error("prompt authority revoked before native write");
        let observationCount = 0;
        const onAcpMessage: NonNullable<RunOnceOptions["onAcpMessage"]> = (direction, message) => {
          if (
            direction === "outbound" &&
            "method" in message &&
            message.method === "session/prompt"
          ) {
            observationCount += 1;
            controller.abort(reason);
          }
        };
        const connection = { ...peer, cwd: home, permissionMode: "deny-all" as const };
        const initial =
          mode === "persistent" ? await createSessionWithClient(connection) : undefined;
        const prompt = [{ type: "text" as const, text: "must not reach the peer" }];
        const control = { signal: controller.signal, handleProcessInterrupts: false };
        try {
          const pending = initial
            ? sendSessionDirect(
                {
                  sessionId: initial.record.acpxRecordId,
                  client: initial.client,
                  resumePolicy: "same-session-only",
                  permissionMode: "deny-all",
                  outputFormatter: DISCARD_OUTPUT_FORMATTER,
                  onAcpMessage,
                  prompt,
                },
                control,
              )
            : runOnce(
                { ...connection, outputFormatter: DISCARD_OUTPUT_FORMATTER, onAcpMessage, prompt },
                control,
              );
          await assert.rejects(pending, (error) => containsError(error, reason));
          assert.equal(
            observationCount,
            1,
            "the rejection must occur at the actual write boundary",
          );
          const received = await peer.entries();
          assert.equal(received.filter((entry) => entry.method === "session/new").length, 1);
          assert.deepEqual(
            received.filter((entry) => entry.method === "session/prompt"),
            [],
          );
          clients.assertRetired();
        } finally {
          await clients.close();
        }
      });
    },
  );

  test(
    `${mode} owned direct cancellation joins retirement and preserves its failure`,
    { timeout: 15_000 },
    async (t) => {
      await withTempHome("acpx-flow-native-retirement-", async (home) => {
        const peer = await nativePeer(home);
        const clients = trackClients(t);
        const controller = new AbortController();
        const ready = gate();
        const closing = gate();
        const releaseClose = gate();
        const reason = new Error("owned turn revoked");
        const cleanupFailure = new Error("synthetic terminal retirement failure");
        const onAcpMessage: NonNullable<RunOnceOptions["onAcpMessage"]> = (direction, message) => {
          if (
            direction === "inbound" &&
            "method" in message &&
            message.method === "session/update"
          ) {
            ready.release();
          }
        };
        const connection = { ...peer, cwd: home, permissionMode: "deny-all" as const };
        const initial =
          mode === "persistent" ? await createSessionWithClient(connection) : undefined;
        const prompt = [{ type: "text" as const, text: "hold" }];
        const control = { signal: controller.signal, handleProcessInterrupts: false };
        const run = observe(
          initial
            ? sendSessionDirect(
                {
                  sessionId: initial.record.acpxRecordId,
                  client: initial.client,
                  resumePolicy: "same-session-only",
                  permissionMode: "deny-all",
                  outputFormatter: DISCARD_OUTPUT_FORMATTER,
                  onAcpMessage,
                  prompt,
                },
                control,
              )
            : runOnce(
                { ...connection, outputFormatter: DISCARD_OUTPUT_FORMATTER, onAcpMessage, prompt },
                control,
              ),
        );
        await ready.promise;
        // Isolate failed retirement from the separate cooperative-cancel grace-period policy.
        const cancelMock = t.mock.method(
          AcpClient.prototype,
          "cancelActivePrompt",
          async () => undefined,
        );
        const shutdown = TerminalManager.prototype.shutdown;
        const shutdownMock = t.mock.method(
          TerminalManager.prototype,
          "shutdown",
          async function (this: TerminalManager) {
            await shutdown.call(this);
            closing.release();
            await releaseClose.promise;
            throw cleanupFailure;
          },
        );
        const abortCleanup = () => {
          releaseClose.release();
          shutdownMock.mock.restore();
          cancelMock.mock.restore();
          void clients.close().catch(() => {});
        };
        t.signal.addEventListener("abort", abortCleanup, { once: true });
        try {
          assert.equal(
            (await peer.entries()).filter((entry) => entry.method === "session/prompt").length,
            1,
          );
          controller.abort(reason);
          await closing.promise;
          await nextTurn();
          assert.equal(run.settled(), false, "cancellation must await the held native retirement");
          releaseClose.release();
          const result = await run.outcome;
          assert.equal(result.ok, false);
          if (!result.ok) {
            assert.ok(
              containsError(result.error, cleanupFailure),
              "cleanup failure must survive abort normalization",
            );
          }
          clients.assertRetired();
        } finally {
          releaseClose.release();
          t.signal.removeEventListener("abort", abortCleanup);
          shutdownMock.mock.restore();
          cancelMock.mock.restore();
          await clients.close();
        }
      });
    },
  );
}

test(
  "persistent flow reconnect never replaces a missing ACP session",
  { timeout: 15_000 },
  async (t) => {
    await withTempHome("acpx-flow-native-resume-", async (home) => {
      const peer = await nativePeer(home, "load-failure");
      const clients = trackClients(t);
      const runner = new FlowRunner({
        resolveAgent: () => ({ agentName: "fixture", ...peer, cwd: home }),
        permissionMode: "deny-all",
        outputRoot: path.join(home, "runs"),
      });
      const flow = defineFlow({
        name: "same-session-required",
        startAt: "first",
        nodes: {
          first: acp({ heartbeatMs: 0, prompt: () => "first" }),
          second: acp({ heartbeatMs: 0, prompt: () => "must not replace" }),
        },
        edges: [{ from: "first", to: "second" }],
      });
      try {
        await assert.rejects(
          runner.run(flow, {}),
          /Persistent ACP session .* could not be resumed/,
        );
        const received = await peer.entries();
        assert.equal(received.filter((entry) => entry.method === "session/new").length, 1);
        assert.deepEqual(
          received
            .filter((entry) => entry.method === "session/load")
            .map((entry) => entry.sessionId),
          ["owned-fixture-session"],
        );
        assert.deepEqual(
          received.filter((entry) => entry.method === "session/prompt").map((entry) => entry.text),
          ["first"],
        );
        assert.equal(clients.pids.size, 2, "the second node must exercise a real reconnect");
        clients.assertRetired();
      } finally {
        await clients.close();
      }
    });
  },
);

for (const phase of ["retry", "cleanup"] as const) {
  test(`owned turn admission preserves ${phase === "retry" ? "the abort reason" : "cleanup failures"}`, async (t) => {
    await withTempHome("acpx-flow-admission-", async (home) => {
      const record = makeSessionRecord({
        acpxRecordId: "owned-admission",
        acpSessionId: "synthetic",
        agentCommand: "synthetic",
        cwd: home,
      });
      await writeSessionRecord(record);
      const requestedLockPath = sessionEventLockPath(record.acpxRecordId);
      const lockPath = path.join(
        await fs.realpath(path.dirname(requestedLockPath)),
        path.basename(requestedLockPath),
      );
      const controller = new AbortController();
      const reason = new TimeoutError(20_000);
      const cleanupFailure = new Error("synthetic acquisition cleanup failure");
      let entered = false;
      if (phase === "retry") {
        await fs.writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
        );
        const delay = timers.setTimeout;
        t.mock.method(
          timers,
          "setTimeout",
          (ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
            const pending = delay(ms, value, options);
            if (ms === 15 && options?.signal) {
              entered = true;
              controller.abort(reason);
            }
            return pending;
          },
        );
        syncBuiltinESMExports();
      } else {
        const link = fs.link;
        const unlink = fs.unlink;
        t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
          await link(...args);
          if (String(args[1]) === lockPath) {
            entered = true;
            controller.abort(reason);
          }
        });
        t.mock.method(fs, "unlink", async (filename: Parameters<typeof fs.unlink>[0]) => {
          if (String(filename) === lockPath) {
            throw cleanupFailure;
          }
          await unlink(filename);
        });
      }
      try {
        await assert.rejects(
          sendSessionDirect(
            {
              sessionId: record.acpxRecordId,
              prompt: [{ type: "text", text: "never admitted" }],
              permissionMode: "deny-all",
              outputFormatter: DISCARD_OUTPUT_FORMATTER,
            },
            { signal: controller.signal, handleProcessInterrupts: false },
          ),
          (error: unknown) => {
            assert.equal(entered, true);
            if (phase === "retry") {
              assert.equal(error, reason);
            } else {
              assert.ok(containsError(error, reason));
              assert.ok(containsError(error, cleanupFailure));
            }
            return true;
          },
        );
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });
}
