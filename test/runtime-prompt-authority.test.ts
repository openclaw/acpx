import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeEvent,
  type AcpSessionStore,
} from "../src/runtime.js";

const peer = fileURLToPath(
  new URL(
    `./fixtures/control-authority-agent${path.extname(fileURLToPath(import.meta.url))}`,
    import.meta.url,
  ),
);

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-prompt-authority-"));
  const disk = createFileSessionStore({ stateDir: path.join(root, "state") });
  const store: AcpSessionStore = {
    load: (id) => disk.load(id),
    save: (record) => disk.save(record),
  };
  const agentArgv = [
    process.execPath,
    "--import",
    import.meta.resolve("tsx"),
    peer,
    root,
    "config",
  ];
  const pids: number[] = [];
  const clients: AcpClient[] = [];
  const processLifecycle = {
    onSpawned: async ({ pid }: { pid: number }) => {
      pids.push(pid);
    },
  };
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: store,
    agentRegistry: createAgentRegistry({ overrides: { fixture: agentArgv } }),
    permissionMode: "deny-all",
    processLifecycle,
  });
  const logs = async (name: string) =>
    (await fs.readFile(path.join(root, name), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  t.after(async () => {
    await runtime.shutdown();
    for (const client of clients) {
      await client.close();
    }
    t.diagnostic(
      JSON.stringify({
        received: await logs("prompts.jsonl"),
        effects: await logs("prompt-effects.jsonl"),
      }),
    );
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ["prompts.jsonl", "prompt-effects.jsonl"]) {
    await fs.writeFile(path.join(root, name), "");
  }
  await fs.writeFile(path.join(root, "release-prompt"), "release");
  return {
    runtime,
    store,
    disk,
    pids,
    createClient() {
      const client = new AcpClient({
        agentCommand: process.execPath,
        agentArgv,
        cwd: root,
        permissionMode: "deny-all",
        processLifecycle,
      });
      clients.push(client);
      return client;
    },
    async prompts(texts: string[]) {
      const expected = texts.map((text) => ({
        sessionId: "authority-session",
        prompt: [{ type: "text", text }],
      }));
      assert.deepEqual(await logs("prompts.jsonl"), expected, "requests received by peer");
      assert.deepEqual(await logs("prompt-effects.jsonl"), expected, "effects applied by peer");
    },
  };
}

async function collectEvents(events: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const collected: AcpRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

for (const mode of ["persistent", "oneshot"] as const) {
  test(
    `${mode} runtime checks prompt authority after the final preparation checkpoint`,
    { timeout: 15_000 },
    async (t) => {
      const context = await fixture(t);
      const { runtime, store, disk } = context;
      const session = { sessionKey: "prompt-authority", agent: "fixture", mode };
      const handle = await runtime.ensureSession(session);
      let enterCheckpoint!: () => void;
      const checkpointEntered = new Promise<void>((resolve) => {
        enterCheckpoint = resolve;
      });
      let releaseCheckpoint!: () => void;
      const checkpointReleased = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      t.signal.addEventListener("abort", releaseCheckpoint, { once: true });
      let holdCheckpoint = true;
      store.save = async (record) => {
        if (holdCheckpoint && record.lastRequestId === "revoked-prompt") {
          holdCheckpoint = false;
          enterCheckpoint();
          await checkpointReleased;
        }
        await disk.save(record);
      };
      const error = new Error("prompt admission revoked during final checkpoint");
      const controller = new AbortController();
      let active = true;
      const input = {
        handle,
        text: "must not reach the agent",
        mode: "prompt" as const,
        requestId: "revoked-prompt",
        signal: controller.signal,
        assertActive: () => {
          if (!active) {
            throw error;
          }
        },
      };
      const rejected = runtime.startTurn(input);
      const readiness = rejected.promptStarted.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      const rejectedEvents = collectEvents(rejected.events);
      await checkpointEntered;
      active = false;
      releaseCheckpoint();
      const result = await rejected.result;
      await context.prompts([]);
      assert.equal(await readiness, error);
      assert.equal(controller.signal.aborted, false);
      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.equal(result.error.message, error.message);
      }
      assert.deepEqual(await rejectedEvents, []);
      if (mode === "oneshot") {
        assert.throws(() => process.kill(context.pids[0], 0), { code: "ESRCH" });
      }

      active = true;
      const nextHandle = await runtime.ensureSession(session);
      const accepted = runtime.startTurn({
        ...input,
        handle: nextHandle,
        requestId: "active-prompt",
        text: "still authorized",
      });
      const acceptedEvents = collectEvents(accepted.events);
      await accepted.promptStarted;
      active = false;
      assert.equal((await accepted.result).status, "completed");
      await acceptedEvents;
      await context.prompts(["still authorized"]);
    },
  );
}

test(
  "legacy runTurn reports revoked prompt admission without sending a prompt",
  { timeout: 15_000 },
  async (t) => {
    const context = await fixture(t);
    const handle = await context.runtime.ensureSession({
      sessionKey: "legacy-authority",
      agent: "fixture",
      mode: "persistent",
    });
    const error = new Error("legacy prompt admission revoked");
    const input = {
      handle,
      text: "must not reach the agent",
      mode: "prompt" as const,
      requestId: "legacy-revoked",
      assertActive: () => {
        throw error;
      },
    };
    const events = await collectEvents(context.runtime.runTurn(input));
    await context.prompts([]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    if (events[0].type === "error") {
      assert.equal(events[0].message, error.message);
    }
  },
);

test(
  "runtime preserves cancellation when the signal aborts during deferred prompt dispatch",
  { timeout: 15_000 },
  async (t) => {
    const context = await fixture(t);
    const handle = await context.runtime.ensureSession({
      sessionKey: "late-abort",
      agent: "fixture",
      mode: "persistent",
    });
    const controller = new AbortController();
    const error = new Error("cancelled before the native prompt write");
    const input = {
      handle,
      text: "must not reach the agent",
      mode: "prompt" as const,
      requestId: "late-abort",
      signal: controller.signal,
      assertActive: () => queueMicrotask(() => controller.abort(error)),
    };
    const turn = context.runtime.startTurn(input);
    const readiness = turn.promptStarted.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert.deepEqual(await turn.result, { status: "cancelled", stopReason: "cancelled" });
    assert.equal(await readiness, error);
    await context.prompts([]);
  },
);

test(
  "native prompt write rejection preserves authority errors and retires the closed transport",
  { timeout: 15_000 },
  async (t) => {
    const context = await fixture(t);
    const client = context.createClient();
    await client.start();
    const { sessionId } = await client.createSession();
    const originalPid = client.getAgentPid();
    const error = new Error("admission revoked at the native prompt write");
    let active = true;
    client.setEventHandlers({
      onAcpMessage: (direction, message) => {
        if (
          direction === "outbound" &&
          "method" in message &&
          message.method === "session/prompt"
        ) {
          active = false;
        }
      },
    });
    let ready = false;
    const failure = await client
      .prompt(
        sessionId,
        "must not reach the agent",
        () => {
          ready = true;
        },
        undefined,
        undefined,
        {
          assertActive: () => {
            if (!active) {
              throw error;
            }
          },
        },
      )
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    await context.prompts([]);
    assert.equal(failure, error);
    assert.equal(ready, false);
    assert.equal(client.hasActivePrompt(), false);
    assert.equal(client.hasReusableSession(sessionId), false);
    client.clearEventHandlers();
    await client.start();
    assert.ok(originalPid);
    assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
    await client.loadSession(sessionId);
    assert.equal((await client.prompt(sessionId, "replacement transport")).stopReason, "end_turn");
    await context.prompts(["replacement transport"]);
  },
);
