import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import {
  AcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpSessionStore,
} from "../src/runtime.js";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import type { SessionRecord } from "../src/types.js";
import { InMemorySessionStore, createRuntimeOptions } from "./runtime-test-helpers.js";

const peer = fileURLToPath(
  new URL(
    `./fixtures/control-authority-agent${path.extname(fileURLToPath(import.meta.url))}`,
    import.meta.url,
  ),
);

async function fixture(t: TestContext, route: "config" | "legacy" = "config") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-control-finalization-"));
  const disk = createFileSessionStore({ stateDir: path.join(directory, "state") });
  const store: AcpSessionStore = {
    load: (id) => disk.load(id),
    save: (record) => disk.save(record),
  };
  const pids: number[] = [];
  const runtimes: ReturnType<typeof createAcpRuntime>[] = [];
  const createRuntime = () => {
    const runtime = createAcpRuntime({
      cwd: directory,
      sessionStore: store,
      permissionMode: "deny-all",
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [
            process.execPath,
            "--import",
            import.meta.resolve("tsx"),
            peer,
            directory,
            route,
          ],
        },
      }),
      processLifecycle: {
        onSpawned: async ({ pid }) => {
          pids.push(pid);
        },
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = createRuntime();
  const touch = (name: string) => fs.writeFile(path.join(directory, name), "ready");
  const waitFile = async (name: string) => {
    const deadline = Date.now() + 5000;
    while (!(await fs.stat(path.join(directory, name)).catch(() => undefined))) {
      assert.ok(Date.now() < deadline, `missing fixture barrier: ${name}`);
      await delay(5);
    }
  };
  t.after(async () => {
    await touch("release-first");
    await touch("release-control");
    await touch("release-prompt");
    await Promise.all(runtimes.map((instance) => instance.shutdown()));
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await touch("hold-control");
  await touch("emit-final-state");
  const handle = await runtime.ensureSession({
    sessionKey: "control-finalization",
    agent: "fixture",
    mode: "persistent",
  });
  return { directory, disk, store, runtime, createRuntime, handle, touch, waitFile };
}

function assertFinalData(record: SessionRecord | undefined): asserts record is SessionRecord {
  assert.ok(record);
  assert.ok(JSON.stringify(record.messages).includes("final answer while control waits"));
  assert.ok(JSON.stringify(record.acpx).includes("after-control"));
  assert.equal(record.cumulative_token_usage.total_tokens, 12);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function memoryFixture(t: TestContext, mode: "persistent" | "oneshot" = "persistent") {
  const store = new InMemorySessionStore();
  const options = createRuntimeOptions({
    cwd: "/synthetic-control-workspace",
    sessionStore: store,
  });
  const prompt = deferred();
  const promptReturned = deferred();
  const control = deferred();
  const controlStarted = deferred();
  let closed = false;
  let active = false;
  let promptCount = 0;
  let model = "default-model";
  let effort = "low";
  let handlers: { onSessionUpdate?: (notification: SessionNotification) => void } = {};
  const catalog = (): SessionConfigOption[] => [
    {
      id: "llm",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: ["default-model", "first-model"].map((value) => ({ value, name: value })),
    },
    {
      id: "effort",
      name: "Effort",
      type: "select",
      currentValue: effort,
      options: ["low", "high"].map((value) => ({ value, name: value })),
    },
  ];
  const waitControl = async () => {
    controlStarted.resolve();
    await control.promise;
  };
  const client = {
    start: async () => {},
    close: async () => {
      closed = true;
    },
    createSession: async () => ({ sessionId: "native-control", configOptions: catalog() }),
    hasReusableSession: () => !closed,
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    getAgentLifecycleSnapshot: () => ({ running: !closed }),
    setEventHandlers: (next: typeof handlers) => {
      handlers = next;
    },
    clearEventHandlers: () => {
      handlers = {};
    },
    hasActivePrompt: () => active,
    requestCancelActivePrompt: async () => false,
    waitForSessionUpdatesIdle: async () => {},
    prompt: async (_id: string, _input: unknown, onWritten?: () => void | Promise<void>) => {
      active = true;
      await onWritten?.();
      if (++promptCount === 1) {
        await prompt.promise;
      }
      active = false;
      promptReturned.resolve();
      return { stopReason: "end_turn" };
    },
    setSessionMode: async () => {
      await waitControl();
    },
    setSessionModel: async (_id: string, value: string) => {
      await waitControl();
      model = value;
      return { configOptions: catalog() };
    },
    setSessionConfigOption: async (_id: string, _key: string, value: string) => {
      await waitControl();
      effort = value;
      return { configOptions: catalog() };
    },
  };
  let creations = 0;
  const manager = new AcpRuntimeManager(options, {
    clientFactory: () => {
      creations++;
      return client as never;
    },
  });
  const runtime = new AcpxRuntime(options, { managerFactory: () => manager });
  const releases: Array<() => void> = [];
  t.after(async () => {
    for (const release of releases) {
      release();
    }
    prompt.resolve();
    control.resolve();
    await runtime.shutdown();
  });
  const handle = await runtime.ensureSession({
    sessionKey: "memory-control",
    agent: "codex",
    mode,
  });
  const emit = (update: SessionNotification["update"]) =>
    handlers.onSessionUpdate?.({ sessionId: "native-control", update });
  return {
    runtime,
    handle,
    store,
    client,
    prompt,
    promptReturned,
    control,
    controlStarted,
    emit,
    releaseOnCleanup: (release: () => void) => {
      releases.push(release);
    },
    recordId: handle.acpxRecordId ?? handle.sessionKey,
    get creations() {
      return creations;
    },
    get promptCount() {
      return promptCount;
    },
    get closed() {
      return closed;
    },
  };
}

for (const termination of ["pre-aborted", "invalid-input"] as const) {
  test(`oneshot ${termination} cleanup joins an accepted idle control`, async (t) => {
    const f = await memoryFixture(t, "oneshot");
    const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
    await f.controlStarted.promise;
    const input = {
      handle: f.handle,
      text: "unused",
      mode: "prompt" as const,
      requestId: "unused",
    };
    let result: Promise<unknown> | undefined;
    if (termination === "pre-aborted") {
      result = f.runtime.startTurn({ ...input, signal: AbortSignal.abort() }).result;
    } else {
      await assert.rejects(
        f.runtime.startTurn({
          ...input,
          attachments: [{ mediaType: "application/pdf", data: "Zm9v" }],
        }).result,
        /Unsupported ACP runtime attachment media type/,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closedBeforeAcknowledgement = f.closed;
    f.control.resolve();
    await changing;
    await result;
    await f.runtime.shutdown();
    assert.equal(closedBeforeAcknowledgement, false);
    assert.equal(f.closed, true);
    assert.equal(f.promptCount, 0);
    assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, "plan");
  });
}

for (const control of ["mode", "model", "config"] as const) {
  test(`memory ${control} acknowledgement preserves the finalized owner state`, async (t) => {
    const f = await memoryFixture(t);
    const turn = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await turn.promptStarted;
    const changing =
      control === "mode"
        ? f.runtime.setMode({ handle: f.handle, mode: "plan" })
        : control === "model"
          ? f.runtime.setModel({ handle: f.handle, model: "first-model" })
          : f.runtime.setConfigOption({ handle: f.handle, key: "effort", value: "high" });
    void changing.catch(() => {});
    await f.controlStarted.promise;
    f.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "final answer while control waits" },
    });
    f.emit({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "after-control", description: "Final metadata" }],
    });
    f.emit({
      sessionUpdate: "usage_update",
      used: 12,
      size: 500,
      _meta: { usage: { total_tokens: 12 } },
    });
    f.prompt.resolve();
    await f.promptReturned.promise;
    let settled = false;
    void turn.result.then(() => {
      settled = true;
    });
    // The cloning store has no I/O; this drains the complete finalization microtask chain.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completedBeforeAcknowledgement = settled;
    f.control.resolve();
    await changing;
    assert.equal((await turn.result).status, "completed");
    assertFinalData(await f.store.load(f.handle.acpxRecordId ?? f.handle.sessionKey));
    const next = f.runtime.startTurn({
      handle: f.handle,
      text: "second",
      mode: "prompt",
      requestId: "second",
    });
    assert.equal((await next.result).status, "completed");
    const record = await f.store.load(f.handle.acpxRecordId ?? f.handle.sessionKey);
    assertFinalData(record);
    if (control === "mode") {
      assert.equal(record.acpx?.desired_mode_id, "plan");
    }
    if (control === "model") {
      assert.equal(record.acpx?.session_options?.model, "first-model");
    }
    if (control === "config") {
      assert.equal(record.acpx?.desired_config_options?.effort, "high");
    }
    assert.equal(
      completedBeforeAcknowledgement,
      false,
      "turn completion must join admitted controls",
    );
  });
}

test("oneshot completion saves its accepted control before closing the client", async (t) => {
  const f = await memoryFixture(t, "oneshot");
  const turn = f.runtime.startTurn({
    handle: f.handle,
    text: "first",
    mode: "prompt",
    requestId: "first",
  });
  await turn.promptStarted;
  const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
  await f.controlStarted.promise;
  f.prompt.resolve();
  await f.promptReturned.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.closed, false);
  f.control.resolve();
  await changing;
  assert.equal((await turn.result).status, "completed");
  assert.equal(f.closed, true);
  assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, "plan");
});

test("one checkpoint preserves updates during and after terminal persistence", async (t) => {
  const f = await memoryFixture(t);
  f.control.resolve();
  await f.runtime.setMode({ handle: f.handle, mode: "plan" });
  const turn = f.runtime.startTurn({
    handle: f.handle,
    text: "first",
    mode: "prompt",
    requestId: "first",
  });
  await turn.promptStarted;
  const entered = deferred();
  const release = deferred();
  f.releaseOnCleanup(release.resolve);
  const save = f.store.save.bind(f.store);
  let hold = true;
  f.store.save = async (record) => {
    const snapshot = structuredClone(record);
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    await save(snapshot);
  };
  f.prompt.resolve();
  await entered.promise;
  f.emit({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "during terminal save;" },
  });
  release.resolve();
  assert.equal((await turn.result).status, "completed");
  f.emit({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "after terminal save" },
  });
  await f.runtime.getStatus({ handle: f.handle });
  const record = await f.store.load(f.recordId);
  assert.equal(record?.acpx?.desired_mode_id, "plan");
  assert.ok(JSON.stringify(record?.messages).includes("during terminal save;"));
  assert.ok(JSON.stringify(record?.messages).includes("after terminal save"));
});

test("late config responses reconcile siblings before idle controls use the new catalog", async (t) => {
  const f = await memoryFixture(t);
  f.control.resolve();
  await f.runtime.setConfigOption({ handle: f.handle, key: "effort", value: "high" });
  const entered = deferred();
  const release = deferred();
  f.releaseOnCleanup(release.resolve);
  let dispatches = 0;
  f.client.setSessionConfigOption = async () => {
    dispatches++;
    entered.resolve();
    await release.promise;
    return { configOptions: [] };
  };
  const turn = f.runtime.startTurn({
    handle: f.handle,
    text: "first",
    mode: "prompt",
    requestId: "first",
  });
  await turn.promptStarted;
  const changing = f.runtime.setConfigOption({
    handle: f.handle,
    key: "llm",
    value: "first-model",
  });
  await entered.promise;
  f.emit({ sessionUpdate: "config_option_update", configOptions: [] });
  f.prompt.resolve();
  await f.promptReturned.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(
    f.runtime.setConfigOption({ handle: f.handle, key: "effort", value: "high" }),
    /config|unsupported/i,
  );
  release.resolve();
  await changing;
  assert.equal((await turn.result).status, "completed");
  await rejected;
  const record = await f.store.load(f.recordId);
  assert.equal(record?.acpx?.session_options?.model, "first-model");
  assert.equal(record?.acpx?.desired_config_options, undefined);
  assert.deepEqual(record?.acpx?.config_options, []);
  assert.equal(dispatches, 1);
});

test(
  "accepted control persistence gates completion and the next turn",
  { timeout: 5000 },
  async (t) => {
    const f = await memoryFixture(t);
    const entered = deferred();
    const release = deferred();
    f.releaseOnCleanup(release.resolve);
    const save = f.store.save.bind(f.store);
    let hold = true;
    f.store.save = async (record) => {
      const snapshot = structuredClone(record);
      if (hold && snapshot.acpx?.desired_mode_id === "plan") {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      await save(snapshot);
    };
    const first = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await first.promptStarted;
    const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
    await f.controlStarted.promise;
    f.control.resolve();
    await entered.promise;
    f.prompt.resolve();
    await f.promptReturned.promise;
    const next = f.runtime.startTurn({
      handle: f.handle,
      text: "next",
      mode: "prompt",
      requestId: "next",
    });
    let saved = false;
    let completed = false;
    void changing.then(() => {
      saved = true;
    });
    void first.result.then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(saved, false);
    assert.equal(completed, false);
    assert.equal(f.promptCount, 1);
    release.resolve();
    await changing;
    assert.equal((await first.result).status, "completed");
    assert.equal((await next.result).status, "completed");
    assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, "plan");
  },
);

test(
  "live controls checkpoint their current conversation before prompt completion",
  { timeout: 5000 },
  async (t) => {
    const f = await memoryFixture(t);
    const first = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await first.promptStarted;
    const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
    await f.controlStarted.promise;
    f.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live answer" },
    });
    f.control.resolve();
    await changing;
    const record = await f.store.load(f.recordId);
    assert.equal(record?.acpx?.desired_mode_id, "plan");
    assert.ok(JSON.stringify(record?.messages).includes("live answer"));
    f.prompt.resolve();
    assert.equal((await first.result).status, "completed");
  },
);

test("an accepted control save failure rejects the setter without stranding later work", async (t) => {
  const f = await memoryFixture(t);
  const first = f.runtime.startTurn({
    handle: f.handle,
    text: "first",
    mode: "prompt",
    requestId: "first",
  });
  await first.promptStarted;
  const failure = new Error("accepted control persistence failed");
  const save = f.store.save.bind(f.store);
  let fail = true;
  f.store.save = async (record) => {
    if (fail && record.acpx?.desired_mode_id === "plan") {
      fail = false;
      throw failure;
    }
    await save(record);
  };
  const rejected = assert.rejects(
    f.runtime.setMode({ handle: f.handle, mode: "plan" }),
    (error) => error === failure,
  );
  await f.controlStarted.promise;
  f.control.resolve();
  await rejected;
  await f.runtime.setMode({ handle: f.handle, mode: "auto" });
  f.prompt.resolve();
  assert.equal((await first.result).status, "completed");
  assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, "auto");
});

test("control rejection after native completion releases the owner transition", async (t) => {
  const f = await memoryFixture(t);
  const original = f.client.setSessionMode;
  const failure = new Error("native control rejected");
  f.client.setSessionMode = async () => {
    f.controlStarted.resolve();
    await f.control.promise;
    throw failure;
  };
  const first = f.runtime.startTurn({
    handle: f.handle,
    text: "first",
    mode: "prompt",
    requestId: "first",
  });
  await first.promptStarted;
  const rejected = assert.rejects(
    f.runtime.setMode({ handle: f.handle, mode: "plan" }),
    (error) => error === failure,
  );
  await f.controlStarted.promise;
  f.prompt.resolve();
  await f.promptReturned.promise;
  f.control.resolve();
  await rejected;
  assert.equal((await first.result).status, "completed");
  assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, undefined);
  f.client.setSessionMode = original;
  await f.runtime.setMode({ handle: f.handle, mode: "plan" });
  assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, "plan");
});

for (const failing of [false, true]) {
  test(`idle updates survive ${failing ? "failed" : "successful"} turn preparation`, async (t) => {
    const f = await memoryFixture(t);
    const first = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await first.promptStarted;
    f.prompt.resolve();
    assert.equal((await first.result).status, "completed");
    const entered = deferred();
    const release = deferred();
    f.releaseOnCleanup(release.resolve);
    const save = f.store.save.bind(f.store);
    let hold = true;
    f.store.save = async (record) => {
      const snapshot = structuredClone(record);
      if (hold && JSON.stringify(snapshot.messages).includes("preparation barrier")) {
        hold = false;
        entered.resolve();
        await release.promise;
        if (failing) {
          throw new Error("preparation failed");
        }
      }
      await save(snapshot);
    };
    const next = f.runtime.startTurn({
      handle: f.handle,
      text: "preparation barrier",
      mode: "prompt",
      requestId: "next",
    });
    await entered.promise;
    f.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "buffered during preparation" },
    });
    release.resolve();
    assert.equal((await next.result).status, failing ? "failed" : "completed");
    await f.runtime.getStatus({ handle: f.handle });
    const record = await f.store.load(f.recordId);
    assert.ok(JSON.stringify(record?.messages).includes("buffered during preparation"));
    if (failing) {
      assert.equal(JSON.stringify(record?.messages).includes("preparation barrier"), false);
    }
    const retry = f.runtime.startTurn({
      handle: f.handle,
      text: "retry",
      mode: "prompt",
      requestId: "retry",
    });
    assert.equal((await retry.result).status, "completed");
    assert.equal(f.creations, 1);
  });
}

test(
  "shutdown joins accepted persistence after authority revocation",
  { timeout: 5000 },
  async (t) => {
    const f = await memoryFixture(t);
    const entered = deferred();
    const release = deferred();
    f.releaseOnCleanup(release.resolve);
    const save = f.store.save.bind(f.store);
    let hold = true;
    f.store.save = async (record) => {
      const snapshot = structuredClone(record);
      if (hold && snapshot.acpx?.desired_mode_id === "plan") {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      await save(snapshot);
    };
    const first = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await first.promptStarted;
    const abort = new AbortController();
    let revoked = false;
    const changing = f.runtime.setMode({
      handle: f.handle,
      mode: "plan",
      signal: abort.signal,
      assertActive: () => {
        assert.equal(revoked, false);
      },
    });
    await f.controlStarted.promise;
    f.control.resolve();
    await entered.promise;
    f.prompt.resolve();
    await f.promptReturned.promise;
    revoked = true;
    abort.abort(new Error("revoked after native acceptance"));
    const stopping = f.runtime.shutdown();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release.resolve();
    await changing;
    assert.equal((await first.result).status, "completed");
    await stopping;
    assert.equal((await f.store.load(f.recordId))?.acpx?.desired_mode_id, "plan");
  },
);

test(
  "close preserves accepted controls and cancellation updates without joining the turn",
  { timeout: 5000 },
  async (t) => {
    const f = await memoryFixture(t);
    const first = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await first.promptStarted;
    const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
    await f.controlStarted.promise;
    const closing = f.runtime.close({ handle: f.handle, reason: "test close" });
    f.control.resolve();
    await changing;
    await closing;
    const closed = await f.store.load(f.recordId);
    assert.equal(closed?.closed, true);
    assert.equal(closed?.acpx?.desired_mode_id, "plan");
    f.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "final cancellation output" },
    });
    f.prompt.resolve();
    await first.result;
    const final = await f.store.load(f.recordId);
    assert.equal(final?.closed, true);
    assert.equal(final?.acpx?.desired_mode_id, "plan");
    assert.ok(JSON.stringify(final?.messages).includes("final cancellation output"));
  },
);

test(
  "discard keeps accepted state and late output until fresh creation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const turn = f.runtime.startTurn({
      handle: f.handle,
      text: "before discard",
      mode: "prompt",
      requestId: "discard",
    });
    await turn.promptStarted;
    const changing = f.runtime.setMode({ handle: f.handle, mode: "plan" });
    await f.waitFile("received-1");
    const closing = f.runtime.close({
      handle: f.handle,
      reason: "discard probe",
      discardPersistentState: true,
    });
    await f.touch("release-control");
    await changing;
    await closing;
    await f.touch("release-prompt");
    await turn.result;
    const record = await f.disk.load(f.handle.acpxRecordId ?? f.handle.sessionKey);
    assertFinalData(record);
    assert.equal(record.closed, true);
    assert.equal(record.acpx?.reset_on_next_ensure, true);
    assert.equal(record.acpx?.desired_mode_id, "plan");
    const fresh = await f.runtime.ensureSession({
      sessionKey: "control-finalization",
      agent: "fixture",
      mode: "persistent",
    });
    const freshRecord = await f.disk.load(fresh.acpxRecordId ?? fresh.sessionKey);
    assert.equal(freshRecord?.closed, false);
    assert.equal(freshRecord?.acpx?.reset_on_next_ensure, undefined);
    assert.deepEqual(
      (await fs.readFile(path.join(f.directory, "sessions.jsonl"), "utf8")).trim().split("\n"),
      ['"new"', '"close"', '"new"'],
    );
  },
);

test(
  "native accepted model state survives a new runtime loading the saved session",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const first = f.runtime.startTurn({
      handle: f.handle,
      text: "first",
      mode: "prompt",
      requestId: "first",
    });
    await first.promptStarted;
    const changing = f.runtime.setModel({ handle: f.handle, model: "first-model" });
    await f.waitFile("received-1");
    await f.touch("release-prompt");
    await f.waitFile("prompt-effects.jsonl");
    await f.touch("release-control");
    await changing;
    assert.equal((await first.result).status, "completed");
    await f.runtime.shutdown();
    const reloaded = f.createRuntime();
    const next = reloaded.startTurn({
      handle: f.handle,
      text: "after reload",
      mode: "prompt",
      requestId: "reload",
    });
    assert.equal((await next.result).status, "completed");
    const record = await f.disk.load(f.handle.acpxRecordId ?? f.handle.sessionKey);
    assertFinalData(record);
    assert.equal(record.acpx?.current_model_id, "first-model");
    assert.equal(record.acpx?.session_options?.model, "first-model");
    assert.deepEqual(
      (await fs.readFile(path.join(f.directory, "sessions.jsonl"), "utf8")).trim().split("\n"),
      ['"new"', '"load"'],
    );
  },
);

for (const control of ["mode", "model", "config"] as const) {
  test(
    `accepted ${control} joins finalization and survives retained reuse`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const turn = f.runtime.startTurn({
        handle: f.handle,
        text: "first prompt",
        mode: "prompt",
        requestId: "first",
      });
      await turn.promptStarted;
      const changing =
        control === "mode"
          ? f.runtime.setMode({ handle: f.handle, mode: "plan" })
          : control === "model"
            ? f.runtime.setModel({ handle: f.handle, model: "first-model" })
            : f.runtime.setConfigOption({ handle: f.handle, key: "effort", value: "high" });
      await f.waitFile("received-1");
      await f.touch("release-prompt");
      await f.waitFile("prompt-effects.jsonl");
      let settled = false;
      void turn.result.then(() => {
        settled = true;
      });
      await delay(750);
      const completedBeforeAcknowledgement = settled;
      await f.touch("release-control");
      await changing;
      assert.equal((await turn.result).status, "completed");
      const assertSelection = (record: SessionRecord | undefined) => {
        assertFinalData(record);
        if (control === "mode") {
          assert.equal(record.acpx?.desired_mode_id, "plan");
        }
        if (control === "model") {
          assert.equal(record.acpx?.current_model_id, "first-model");
          assert.equal(record.acpx?.session_options?.model, "first-model");
        }
        if (control === "config") {
          assert.equal(record.acpx?.desired_config_options?.effort, "high");
        }
      };
      assertSelection(await f.disk.load(f.handle.acpxRecordId ?? f.handle.sessionKey));
      const next = f.runtime.startTurn({
        handle: f.handle,
        text: "second prompt",
        mode: "prompt",
        requestId: "second",
      });
      assert.equal((await next.result).status, "completed");
      assertSelection(await f.disk.load(f.handle.acpxRecordId ?? f.handle.sessionKey));
      assert.equal(
        completedBeforeAcknowledgement,
        false,
        "turn result escaped an admitted control",
      );
      const effects = (await fs.readFile(path.join(f.directory, "effects.jsonl"), "utf8"))
        .trim()
        .split("\n");
      assert.equal(effects.length, 1, "retained reuse must not redispatch the control");
      assert.deepEqual(
        (await fs.readFile(path.join(f.directory, "sessions.jsonl"), "utf8")).trim().split("\n"),
        ['"new"'],
      );
    },
  );
}
