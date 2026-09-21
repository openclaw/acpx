import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from "../src/runtime.js";

const peer = fileURLToPath(
  new URL(
    `./fixtures/control-authority-agent${path.extname(fileURLToPath(import.meta.url))}`,
    import.meta.url,
  ),
);

async function fixture(
  t: TestContext,
  route: "config" | "legacy",
  fresh = false,
  sessionMode: "oneshot" | "persistent" = fresh ? "oneshot" : "persistent",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-authority-"));
  const disk = createFileSessionStore({ stateDir: path.join(root, "state") });
  const pids: number[] = [];
  const runtimes: ReturnType<typeof createAcpRuntime>[] = [];
  const createRuntime = () => {
    const runtime = createAcpRuntime({
      cwd: root,
      sessionStore: disk,
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [process.execPath, "--import", import.meta.resolve("tsx"), peer, root, route],
        },
      }),
      permissionMode: "deny-all",
      processLifecycle: {
        onSpawned: async ({ pid }) => {
          pids.push(pid);
        },
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  const write = (name: string) => fs.writeFile(path.join(root, name), "ready");
  const logs = async (name: string) =>
    (await fs.readFile(path.join(root, name), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  let recordId: string | undefined;
  t.after(async () => {
    for (const name of ["release-first", "release-load", "release-new"]) {
      await write(name);
    }
    for (const runtime of runtimes) {
      await runtime.shutdown();
    }
    const record = recordId ? await disk.load(recordId) : undefined;
    t.diagnostic(
      JSON.stringify({
        received: await logs("received.jsonl"),
        effects: await logs("effects.jsonl"),
        selection: record?.acpx,
      }),
    );
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    await fs.rm(root, { recursive: true, force: true });
    t.diagnostic(
      JSON.stringify({ cleanup: "all peers joined and state removed", peers: pids.length }),
    );
  });
  await fs.writeFile(path.join(root, "received.jsonl"), "");
  await fs.writeFile(path.join(root, "effects.jsonl"), "");
  const seed = createRuntime();
  const handle = await seed.ensureSession({
    sessionKey: "replay-authority",
    agent: "fixture",
    mode: sessionMode,
  });
  recordId = handle.acpxRecordId ?? handle.sessionKey;
  await seed.setModel({ handle, model: "first-model" });
  await seed.setConfigOption({ handle, key: "effort", value: "high" });
  if (fresh) {
    await seed.setMode({ handle, mode: "plan" });
  }
  await seed.shutdown();
  const before = await disk.load(recordId);
  assert.equal(before?.acpx?.session_options?.model, "first-model");
  assert.equal(before?.acpx?.desired_config_options?.effort, "high");
  await fs.writeFile(path.join(root, "received.jsonl"), "");
  await fs.writeFile(path.join(root, "effects.jsonl"), "");
  await fs.rm(path.join(root, "received-1"));
  const runtime = createRuntime();
  return {
    runtime,
    handle,
    before,
    write,
    async wait(name: string) {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path.join(root, name))) {
        assert.ok(Date.now() < deadline, `peer did not reach ${name}`);
        await setTimeout(5);
      }
    },
    record: () => disk.load(handle.acpxRecordId ?? handle.sessionKey),
    async controls(expected: Array<{ method: string; value: string }>, expectedEffects = expected) {
      const entries = (values: typeof expected) =>
        values.map((entry, index) => ({ sequence: index + 1, ...entry }));
      assert.deepEqual(
        await logs("received.jsonl"),
        entries(expected),
        "requests received by peer",
      );
      assert.deepEqual(
        await logs("effects.jsonl"),
        entries(expectedEffects),
        "effects applied by peer",
      );
    },
  };
}

for (const route of ["config", "legacy"] as const) {
  test(
    `${route} reconnect rejects revoked admission before saved controls dispatch`,
    { timeout: 15_000 },
    async (t) => {
      const context = await fixture(t, route);
      await context.write("hold-load");
      const error = new Error("authority revoked during session load");
      const controller = new AbortController();
      let active = true;
      const pending = context.runtime
        .setMode({
          handle: context.handle,
          mode: "plan",
          signal: controller.signal,
          assertActive: () => {
            if (!active) {
              throw error;
            }
          },
        })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );
      await context.wait("load-started");
      if (route === "config") {
        controller.abort(error);
      } else {
        active = false;
      }
      await context.write("release-load");
      const failure = await pending;
      t.diagnostic(JSON.stringify({ originalAuthorityError: failure === error }));
      await context.controls([]);
      assert.equal(failure, error);
      assert.deepEqual((await context.record())?.acpx, context.before?.acpx);
    },
  );
}

test(
  "reconnect settles admitted model replay and preserves adjusted siblings before rejecting later replay",
  { timeout: 15_000 },
  async (t) => {
    const context = await fixture(t, "config");
    await context.write("hold-first");
    const error = new Error("authority revoked after model replay dispatch");
    let active = true;
    const pending = context.runtime
      .setMode({
        handle: context.handle,
        mode: "plan",
        assertActive: () => {
          if (!active) {
            throw error;
          }
        },
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    await context.wait("received-1");
    active = false;
    await context.write("release-first");
    const failure = await pending;
    t.diagnostic(JSON.stringify({ originalAuthorityError: failure === error }));
    await context.controls([{ method: "session/set_config_option", value: "first-model" }]);
    assert.equal(failure, error);
    const record = await context.record();
    assert.equal(record?.acpx?.current_model_id, "first-model");
    assert.equal(record?.acpx?.session_options?.model, "first-model");
    assert.equal(record?.acpx?.desired_config_options?.effort, "low");
    assert.equal(
      record?.acpx?.config_options?.find((option) => option.id === "effort")?.currentValue,
      "low",
    );
  },
);

test(
  "reconnect without authority fields replays saved controls and executes the requested mode",
  { timeout: 15_000 },
  async (t) => {
    const context = await fixture(t, "config");
    await context.runtime.setMode({ handle: context.handle, mode: "plan" });
    await context.controls([
      { method: "session/set_config_option", value: "first-model" },
      { method: "session/set_config_option", value: "high" },
      { method: "session/set_mode", value: "plan" },
    ]);
    const record = await context.record();
    assert.equal(record?.acpx?.current_model_id, "first-model");
    assert.equal(record?.acpx?.desired_config_options?.effort, "high");
    assert.equal(record?.acpx?.desired_mode_id, "plan");
  },
);

test(
  "fresh mode replacement rejects cancellation before saved controls dispatch",
  { timeout: 15_000 },
  async (t) => {
    const context = await fixture(t, "config", true);
    await context.write("no-load");
    await context.write("hold-new");
    const controller = new AbortController();
    const error = new Error("authority revoked during fresh session creation");
    const pending = context.runtime
      .setMode({
        handle: context.handle,
        mode: "auto",
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    await context.wait("new-started");
    controller.abort(error);
    await context.write("release-new");
    const failure = await pending;
    t.diagnostic(JSON.stringify({ originalAuthorityError: failure === error }));
    await context.controls([]);
    assert.equal(failure, error);
    assert.deepEqual((await context.record())?.acpx, context.before?.acpx);
  },
);

test("oneshot mode replacement skips a retired mode and restores sibling selections", async (t) => {
  const context = await fixture(t, "config", true);
  await context.write("no-load");
  await context.write("retired-plan");
  await context.runtime.setMode({ handle: context.handle, mode: "auto" });
  await context.controls([
    { method: "session/set_config_option", value: "first-model" },
    { method: "session/set_config_option", value: "high" },
    { method: "session/set_mode", value: "auto" },
  ]);
  const record = await context.record();
  assert.equal(record?.acpx?.desired_mode_id, "auto");
  assert.equal(record?.acpx?.session_options?.model, "first-model");
  assert.equal(record?.acpx?.desired_config_options?.effort, "high");
});

test("rejected oneshot mode replacement preserves the prior mode and accepted siblings", async (t) => {
  const context = await fixture(t, "config", true);
  await context.write("no-load");
  await context.write("retired-plan");
  await context.write("reject-auto");
  await assert.rejects(
    context.runtime.setMode({ handle: context.handle, mode: "auto" }),
    /for mode "auto"/u,
  );
  const siblings = [
    { method: "session/set_config_option", value: "first-model" },
    { method: "session/set_config_option", value: "high" },
  ];
  await context.controls([...siblings, { method: "session/set_mode", value: "auto" }], siblings);
  const record = await context.record();
  assert.equal(record?.acpx?.desired_mode_id, "plan");
  assert.equal(record?.acpx?.session_options?.model, "first-model");
  assert.equal(record?.acpx?.desired_config_options?.effort, "high");
});

test("persistent mode replacement still requires the original native session", async (t) => {
  const context = await fixture(t, "config", true, "persistent");
  await context.write("no-load");
  await context.write("retired-plan");
  await assert.rejects(context.runtime.setMode({ handle: context.handle, mode: "auto" }), {
    name: "SessionResumeRequiredError",
  });
  await context.controls([]);
  const record = await context.record();
  assert.deepEqual(record?.acpx, context.before?.acpx);
  assert.equal(record?.acpSessionId, context.before?.acpSessionId);
});

test("mode replacement preserves admitted model replay when authority is later revoked", async (t) => {
  const context = await fixture(t, "config", true);
  await context.write("no-load");
  await context.write("retired-plan");
  await context.write("hold-first");
  const revoked = new Error("replacement authority revoked after model dispatch");
  let active = true;
  const pending = context.runtime
    .setMode({
      handle: context.handle,
      mode: "auto",
      assertActive: () => {
        if (!active) {
          throw revoked;
        }
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await context.wait("received-1");
  active = false;
  await context.write("release-first");
  assert.equal(await pending, revoked);
  await context.controls([{ method: "session/set_config_option", value: "first-model" }]);
  const record = await context.record();
  assert.equal(record?.acpx?.desired_mode_id, "plan");
  assert.equal(record?.acpx?.session_options?.model, "first-model");
  assert.equal(record?.acpx?.desired_config_options?.effort, "low");
});
