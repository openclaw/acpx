import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createAgentRegistry, type AcpSessionRecord } from "../src/runtime.js";
import { InMemorySessionStore } from "./runtime-test-helpers.js";

const extension = path.extname(fileURLToPath(import.meta.url));
const peer = fileURLToPath(
  new URL(`./fixtures/dependent-config-agent${extension}`, import.meta.url),
);
const createRuntime = process.env.ACPX_TEST_BUILT_RUNTIME
  ? (await import("acpx/runtime")).createAcpRuntime
  : createAcpRuntime;
const sessionKey = "dependent-config";

async function fixture(t: TestContext, { exact = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-connect-session-"));
  const eventsPath = path.join(root, "events");
  await fs.writeFile(eventsPath, "");
  const store = new InMemorySessionStore();
  const effects = () => readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  const timeline = () =>
    effects()
      .slice(baseline)
      .map((event) => event.slice(event.indexOf(" ") + 1));
  let baseline = 0;
  const saves: { record: AcpSessionRecord; events: number }[] = [];
  let failSave = false;
  const options = {
    cwd: root,
    sessionStore: {
      load: (id: string) => store.load(id),
      async save(record: AcpSessionRecord) {
        if (failSave) {
          throw new Error("controlled save failure");
        }
        await store.save(record);
        saves.push({ record: structuredClone(record), events: timeline().length });
      },
    },
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [process.execPath, "--import", import.meta.resolve("tsx"), peer, root],
      },
    }),
    permissionMode: "deny-all" as const,
    timeoutMs: 5_000,
  };
  const setup = createRuntime(options);
  const runtime = createRuntime(options);
  const mark = (name: string) => fs.writeFile(path.join(root, name), "");
  t.after(async () => {
    failSave = false;
    await Promise.all(["load", "reasoning-b"].map((op) => mark(`release-${op}`)));
    try {
      await Promise.all([setup.shutdown(), runtime.shutdown()]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const original = await setup.ensureSession({ sessionKey, agent: "fixture", mode: "persistent" });
  const recordId = original.acpxRecordId ?? sessionKey;
  // Give reconnect local history to preserve. The peer can also replay a chunk on load.
  const turn = setup.startTurn({
    handle: original,
    mode: "prompt",
    text: "original history",
    requestId: "setup",
  });
  assert.equal((await turn.result).status, "completed");
  await setup.close({ handle: original, reason: "release" });
  await setup.shutdown();
  baseline = effects().length;
  const handle = await runtime.ensureSession({
    sessionKey,
    agent: "fixture",
    mode: "persistent",
    ...(exact ? { resumeSessionId: original.backendSessionId } : {}),
  });
  assert.equal(handle.backendSessionId, original.backendSessionId);
  assert.deepEqual(timeline(), []);

  return {
    runtime,
    handle,
    mark,
    timeline,
    saves,
    read: () => store.load(recordId),
    connect: () => runtime.connectSession({ handle }),
    write: (key: string, value: string, signal?: AbortSignal) =>
      runtime.setConfigOption({ handle, key, value, signal }),
    close: () => runtime.close({ handle, reason: "release" }),
    catalog: async () =>
      (await store.load(recordId))?.acpx?.config_options?.map((option) => option.id),
    failSaves: (fail: boolean) => {
      failSave = fail;
    },
    async waitForBarrier(name: string) {
      const signal = AbortSignal.timeout(5_000);
      while (true) {
        try {
          await fs.access(path.join(root, name));
          return;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
          }
        }
        await setTimeout(5, undefined, { signal });
      }
    },
  };
}

for (const connect of [true, false]) {
  test(`dependent controls use ${connect ? "one retained worker" : "two cold workers"}`, async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    await f.mark("replay-history");
    if (connect) {
      await f.connect();
      await f.connect();
      assert.deepEqual(f.timeline(), ["start", "load"]);
    }
    const model = await f.write("model", "model-2");
    const dependent = model.configOptions.find((option) => option.category === "thought_level");
    assert.equal(dependent?.id, "reasoning-b");
    const saved = f.saves.findLast(
      ({ record }) => record.acpx?.session_options?.model === "model-2",
    );
    assert.ok(saved);
    const effort = await f.write(dependent.id, "max");
    assert.equal(
      effort.configOptions.find((option) => option.id === dependent.id)?.currentValue,
      "max",
    );
    assert.deepEqual((await f.read())?.acpx?.desired_config_options, { "reasoning-b": "max" });
    const dispatch = f.timeline().indexOf("write:reasoning-b=max");
    assert.ok(dispatch >= saved.events);
    assert.deepEqual((await f.read())?.messages, before?.messages);
    assert.equal((await f.read())?.createdAt, before?.createdAt);
    assert.equal((await f.read())?.acpSessionId, before?.acpSessionId);
    assert.equal(f.timeline().filter((event) => event === "exit").length, connect ? 0 : 2);
    await f.close();
    const expectedWorkers = connect ? 1 : 2;
    for (const event of ["start", "load", "exit"]) {
      assert.equal(f.timeline().filter((entry) => entry === event).length, expectedWorkers);
    }
    assert.ok(f.timeline().every((event) => event !== "new" && event !== "prompt"));
    t.diagnostic(
      JSON.stringify({
        workers: expectedWorkers,
        timeline: f.timeline(),
        savedAt: saved.events,
        dispatch,
      }),
    );
  });
}

test("an omitted catalog permits an explicit reconnect to refresh the dependent selector", async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.mark("omit-catalog");
  assert.equal((await f.write("model", "model-2")).configOptions, undefined);
  assert.deepEqual(await f.catalog(), ["model", "reasoning-a"]);
  await assert.rejects(
    f.write("reasoning-b", "max"),
    /does not advertise config option 'reasoning-b'/,
  );
  await f.close();
  await f.connect();
  assert.deepEqual(await f.catalog(), ["model", "reasoning-b"]);
  await f.write("reasoning-b", "max");
  await f.close();
  assert.deepEqual(
    f.timeline().filter((event) => /^(load|write:|exit)/.test(event)),
    [
      "load",
      "write:model=model-2",
      "exit",
      "load",
      "write:model=model-2",
      "write:reasoning-b=max",
      "exit",
    ],
  );
});

test("an explicitly empty catalog removes the earlier selectors", async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.mark("empty-catalog");
  assert.deepEqual((await f.write("model", "model-2")).configOptions, []);
  assert.deepEqual(await f.catalog(), []);
  await assert.rejects(f.write("reasoning-a", "high"), /Supported config options: none/);
  await f.close();
  assert.deepEqual(
    f.timeline().filter((event) => event.startsWith("write:")),
    ["write:model=model-2"],
  );
});

test("a mutating refusal settles before explicit compensation on the same worker", async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.write("model", "model-2");
  await f.mark("hold-reasoning-b");
  await f.mark("refuse-reasoning-b");
  const refused = assert.rejects(f.write("reasoning-b", "max"), /refused after mutation/);
  const restore = f.write("model", "model-1");
  try {
    await f.waitForBarrier("held-reasoning-b");
    assert.equal(f.timeline().at(-1), "mutated:reasoning-b=max");
  } finally {
    await f.mark("release-reasoning-b");
    await Promise.all([refused, restore]);
  }
  await f.write("reasoning-a", "low");
  assert.deepEqual(await f.catalog(), ["model", "reasoning-a"]);
  assert.deepEqual((await f.read())?.acpx?.desired_config_options, { "reasoning-a": "low" });
  await f.close();
  assert.deepEqual(
    f.timeline().filter((event) => /^(load|write:|refused:|exit)/.test(event)),
    [
      "load",
      "write:model=model-2",
      "write:reasoning-b=max",
      "refused:reasoning-b=max",
      "write:model=model-1",
      "write:reasoning-a=low",
      "exit",
    ],
  );
});

test("aborting after dispatch preserves the issued write and gates the next write", async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.write("model", "model-2");
  await f.mark("hold-reasoning-b");
  const controller = new AbortController();
  let settled = false;
  const pending = f.write("reasoning-b", "max", controller.signal).finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  try {
    await f.waitForBarrier("held-reasoning-b");
    const reason = new Error("host cancelled");
    controller.abort(reason);
    await assert.rejects(
      f.write("reasoning-b", "minimal", controller.signal),
      (error) => error === reason,
    );
    await setImmediate();
    assert.equal(settled, false);
  } finally {
    await f.mark("release-reasoning-b");
    await pending;
  }
  assert.deepEqual((await f.read())?.acpx?.desired_config_options, { "reasoning-b": "max" });
  await f.close();
  assert.deepEqual(
    f.timeline().filter((event) => /^(load|write:|exit)/.test(event)),
    ["load", "write:model=model-2", "write:reasoning-b=max", "exit"],
  );
});

test("an aborted load settles before releasing its worker without retaining it", async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.mark("hold-load");
  const controller = new AbortController();
  const reason = new Error("load cancelled");
  const pending = assert.rejects(
    f.runtime.connectSession({ handle: f.handle, signal: controller.signal }),
    (error) => error === reason,
  );
  try {
    await f.waitForBarrier("held-load");
    controller.abort(reason);
    assert.deepEqual(f.timeline(), ["start", "load"]);
  } finally {
    await f.mark("release-load");
    await pending;
  }
  assert.deepEqual(f.timeline(), ["start", "load", "exit"]);
  assert.deepEqual((await f.read())?.messages, before?.messages);
  assert.equal((await f.read())?.acpSessionId, before?.acpSessionId);
  await f.connect();
  await f.close();
  assert.deepEqual(f.timeline(), ["start", "load", "exit", "start", "load", "exit"]);
});

test("exact resume refusal sends no prompt, control or replacement session", async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.mark("refuse-load");
  await assert.rejects(f.connect(), /could not be resumed:.*controlled load failure/);
  const after = await f.read();
  assert.equal(after?.acpSessionId, before?.acpSessionId);
  assert.deepEqual(after?.acpx, before?.acpx);
  assert.deepEqual(after?.messages, before?.messages);
  assert.deepEqual(f.timeline(), ["start", "load", "exit"]);
});

test("a failed checkpoint gates the next write and close until storage recovers", async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.failSaves(true);
  await assert.rejects(f.write("model", "model-2"), /controlled save failure/);
  await assert.rejects(f.write("reasoning-b", "max"), /controlled save failure/);
  await assert.rejects(f.close(), /controlled save failure/);
  assert.deepEqual(
    f.timeline().filter((event) => /^(load|write:|exit)/.test(event)),
    ["load", "write:model=model-2"],
  );
  f.failSaves(false);
  await f.write("reasoning-b", "max");
  assert.deepEqual((await f.read())?.acpx?.desired_config_options, { "reasoning-b": "max" });
  await f.close();
  assert.deepEqual(
    f.timeline().filter((event) => /^(load|write:|exit)/.test(event)),
    ["load", "write:model=model-2", "write:reasoning-b=max", "exit"],
  );
});

test("the next turn reuses the retained connection and shutdown joins its exit", async (t) => {
  const f = await fixture(t, { exact: false });
  await f.connect();
  const turn = f.runtime.startTurn({
    handle: f.handle,
    text: "next prompt",
    requestId: "next",
    mode: "prompt",
  });
  assert.equal((await turn.result).status, "completed");
  await f.runtime.shutdown();
  assert.deepEqual(f.timeline(), ["start", "load", "prompt", "exit"]);
  await assert.rejects(f.connect(), /runtime is shut down/);
});
