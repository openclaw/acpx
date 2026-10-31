import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createAgentRegistry } from "../src/runtime.js";
import { InMemorySessionStore } from "./runtime-test-helpers.js";

const peer = fileURLToPath(new URL("./fixtures/control-authority-agent.js", import.meta.url));

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-explicit-resume-"));
  const store = new InMemorySessionStore();
  const options = {
    cwd: root,
    sessionStore: store,
    agentRegistry: createAgentRegistry({
      overrides: { mock: [process.execPath, peer, root, "config"] },
    }),
    permissionMode: "deny-all" as const,
  };
  let runtime = createAcpRuntime(options);
  t.after(async () => {
    await fs.writeFile(path.join(root, "release-load"), "release");
    await fs.writeFile(path.join(root, "release-prompt"), "release");
    await runtime.shutdown();
    t.diagnostic(
      JSON.stringify({
        sessions: await fs.readFile(path.join(root, "sessions.jsonl"), "utf8"),
        controls: await fs.readFile(path.join(root, "received.jsonl"), "utf8"),
        prompts: await fs.readFile(path.join(root, "prompts.jsonl"), "utf8").catch(() => ""),
      }),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "release-prompt"), "release");
  await fs.writeFile(path.join(root, "received.jsonl"), "");
  const input = {
    sessionKey: "explicit",
    agent: "mock",
    mode: "persistent" as const,
    sessionOptions: { systemPrompt: "immutable instructions" },
  };
  const original = await runtime.ensureSession(input);
  await runtime.setConfigOption({ handle: original, key: "llm", value: "gpt-5.6-luna" });
  await runtime.setConfigOption({ handle: original, key: "effort", value: "xhigh" });
  await runtime.close({ handle: original, reason: "cold reconnect" });
  const before = await store.load(original.acpxRecordId!);
  assert.ok(before);
  assert.equal(before.acpx?.session_origin, "new");
  assert.deepEqual(before.messages, []);
  assert.equal(before.acpx?.session_options?.model, "gpt-5.6-luna");
  assert.equal(before.acpx?.desired_config_options?.effort, "xhigh");
  return {
    get runtime() {
      return runtime;
    },
    store,
    input,
    original,
    before,
    mark: (name: string) => fs.writeFile(path.join(root, name), "enabled"),
    unmark: (name: string) => fs.rm(path.join(root, name), { force: true }),
    read: (name: string) => fs.readFile(path.join(root, name), "utf8"),
    async attach() {
      return await runtime.ensureSession({ ...input, resumeSessionId: original.backendSessionId });
    },
    async restart() {
      await runtime.shutdown();
      runtime = createAcpRuntime(options);
    },
  };
}

function assertProjection(
  before: NonNullable<Awaited<ReturnType<InMemorySessionStore["load"]>>>,
  after: Awaited<ReturnType<InMemorySessionStore["load"]>>,
) {
  assert.ok(after);
  assert.equal(after.acpSessionId, before.acpSessionId);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.eventLog, before.eventLog);
  assert.deepEqual(after.acpx?.session_options, before.acpx?.session_options);
  assert.equal(after.acpx?.session_options?.model, "gpt-5.6-luna");
  assert.equal(after.acpx?.desired_config_options?.effort, "xhigh");
}

for (const operation of ["control", "prompt"] as const) {
  test(`explicit compatible reuse refuses cold ${operation} replacement`, async (t) => {
    const f = await fixture(t);
    await f.restart();
    const handle = await f.attach();
    // Both an older handle and an unconstrained ensure alias name this arrangement.
    await f.runtime.ensureSession(f.input);
    await f.mark("fail-load");
    const controls = await f.read("received.jsonl");
    if (operation === "control") {
      await assert.rejects(
        f.runtime.setConfigOption({ handle: f.original, key: "llm", value: "second-model" }),
        /could not be resumed/,
      );
    } else {
      const turn = f.runtime.startTurn({
        handle,
        text: "must not send",
        requestId: "refused",
        mode: "prompt",
      });
      const result = await turn.result;
      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.match(result.error.message, /could not be resumed/);
      }
    }
    assert.equal(await f.read("sessions.jsonl"), '"new"\n"load"\n');
    assert.equal(await f.read("received.jsonl"), controls);
    await assert.rejects(f.read("prompts.jsonl"), { code: "ENOENT" });
    const after = await f.store.load(handle.acpxRecordId!);
    assertProjection(f.before, after);
    if (operation === "control") {
      assert.deepEqual(after?.messages, []);
      await f.unmark("fail-load");
      await f.restart();
      const next = await f.attach();
      const continuation = f.runtime.startTurn({
        handle: next,
        text: "after refusal",
        requestId: "after-refusal",
        mode: "prompt",
      });
      assert.equal((await continuation.result).status, "completed");
      assertProjection(f.before, await f.store.load(next.acpxRecordId!));
      assert.equal(await f.read("sessions.jsonl"), '"new"\n"load"\n"load"\n');
    }
  });
}

test("explicit reconnect replays omitted model and effort without replacing projection", async (t) => {
  const f = await fixture(t);
  await f.restart();
  const handle = await f.attach();
  const turn = f.runtime.startTurn({
    handle,
    text: "continue",
    requestId: "continued",
    mode: "prompt",
  });
  assert.equal((await turn.result).status, "completed");
  const status = await f.runtime.getStatus({ handle });
  assert.equal(status.models?.currentModelId, "gpt-5.6-luna");
  assert.equal(
    (await f.store.load(handle.acpxRecordId!))?.acpx?.config_options?.find(
      (option) => option.id === "effort",
    )?.currentValue,
    "xhigh",
  );
  assert.equal(await f.read("sessions.jsonl"), '"new"\n"load"\n');
  const received = (await f.read("received.jsonl"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { value: string });
  assert.deepEqual(
    received.map((row) => row.value),
    ["gpt-5.6-luna", "xhigh", "gpt-5.6-luna", "xhigh"],
  );
  assertProjection(f.before, await f.store.load(handle.acpxRecordId!));
});

test("untargeted empty-record fallback remains independent of a strict record", async (t) => {
  const f = await fixture(t);
  await f.attach();
  const other = await f.runtime.ensureSession({ ...f.input, sessionKey: "other" });
  await f.runtime.close({ handle: other, reason: "cold reconnect" });
  await f.mark("fail-load");
  await f.runtime.setConfigOption({ handle: other, key: "llm", value: "second-model" });
  assert.equal(await f.read("sessions.jsonl"), '"new"\n"new"\n"load"\n"new"\n');
});

test("explicit preparation separately permits fresh untargeted construction", async (t) => {
  const f = await fixture(t);
  const handle = await f.attach();
  await f.runtime.prepareFreshSession({ handle });
  const fresh = await f.runtime.ensureSession(f.input);
  await f.runtime.close({ handle: fresh, reason: "after explicit reset" });
  await f.mark("fail-load");
  await f.runtime.setConfigOption({ handle: fresh, key: "llm", value: "second-model" });
  assert.equal(await f.read("sessions.jsonl"), '"new"\n"new"\n"load"\n"new"\n');
});

test("explicit attachment refuses to constrain already admitted untargeted work", async (t) => {
  const f = await fixture(t);
  await f.restart();
  await f.runtime.ensureSession(f.input);
  await f.mark("hold-load");
  await f.mark("fail-load");
  const control = f.runtime.setConfigOption({
    handle: f.original,
    key: "llm",
    value: "second-model",
  });
  void control.catch(() => {});
  for (let count = 0; ; count++) {
    try {
      await f.read("load-started");
      break;
    } catch (error) {
      if (count === 1000) {
        throw error;
      }
    }
    await setTimeout(5);
  }
  await assert.rejects(f.attach(), /unfinished/);
  await f.mark("release-load");
  await control;
  assert.equal(await f.read("sessions.jsonl"), '"new"\n"load"\n"new"\n');
  await f.attach();
});

test("already strict compatible ensure remains available during an active prompt", async (t) => {
  const f = await fixture(t);
  const handle = await f.attach();
  await f.unmark("release-prompt");
  const turn = f.runtime.startTurn({
    handle,
    text: "hold",
    requestId: "strict-active",
    mode: "prompt",
  });
  await turn.promptStarted;
  const alias = await f.attach();
  assert.equal(alias.backendSessionId, handle.backendSessionId);
  await f.mark("release-prompt");
  assert.equal((await turn.result).status, "completed");
  assert.equal(await f.read("sessions.jsonl"), '"new"\n"load"\n');
});
