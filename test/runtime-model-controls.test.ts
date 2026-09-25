import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  isRequestedModelUnsupportedError,
} from "../src/runtime.js";

const peer = fileURLToPath(
  new URL(
    `./fixtures/control-authority-agent${path.extname(fileURLToPath(import.meta.url))}`,
    import.meta.url,
  ),
);

async function withinDeadline<T>(t: TestContext, promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
        onAbort = () =>
          reject(t.signal.reason ?? new Error(`Test cancelled while waiting for ${label}`));
        t.signal.addEventListener("abort", onAbort, { once: true });
        if (t.signal.aborted) {
          onAbort();
        }
      }),
      promise,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      t.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function fixture(
  t: TestContext,
  agent = "cursor-agent",
  route: "config" | "legacy" = "config",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-model-controls-"));
  const executable = path.join(root, agent);
  await fs.symlink(process.execPath, executable);
  const store = createFileSessionStore({ stateDir: path.join(root, "state") });
  const pids: number[] = [];
  const options = {
    cwd: root,
    sessionStore: store,
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [executable, "--import", import.meta.resolve("tsx"), peer, root, route],
      },
    }),
    permissionMode: "deny-all" as const,
    processLifecycle: {
      onSpawned: async ({ pid }: { pid: number }) => {
        pids.push(pid);
      },
    },
  };
  let runtime = createAcpRuntime(options);
  t.after(async () => {
    await fs.writeFile(path.join(root, "release-prompt"), "release");
    await runtime.shutdown();
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "parameterized-models"), "enabled");
  await fs.writeFile(path.join(root, "received.jsonl"), "");
  const handle = await runtime.ensureSession({
    sessionKey: "model-controls",
    agent: "fixture",
    mode: "persistent",
  });
  return {
    get runtime() {
      return runtime;
    },
    store,
    handle,
    mark: (name: string) => fs.writeFile(path.join(root, name), "enabled"),
    read: (name: string) => fs.readFile(path.join(root, name), "utf8"),
    async restart() {
      await runtime.shutdown();
      runtime = createAcpRuntime(options);
    },
    async assertUnsupported(run: () => Promise<unknown>, ambiguous?: true) {
      const before = await fs.readFile(path.join(root, "received.jsonl"), "utf8");
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(isRequestedModelUnsupportedError(error));
        assert.equal(error.reason, "unadvertised-model");
        assert.equal(error.ambiguous, ambiguous);
        return true;
      });
      assert.equal(await fs.readFile(path.join(root, "received.jsonl"), "utf8"), before);
    },
  };
}

for (const active of [false, true]) {
  test(`model config controls resolve Cursor aliases with accepted sibling state (${active ? "active" : "idle"})`, async (t) => {
    const context = await fixture(t);
    const { runtime, handle } = context;
    await runtime.setConfigOption({ handle, key: "effort", value: "high" });
    const turn = active
      ? runtime.startTurn({ handle, text: "hold", mode: "prompt", requestId: "active-model" })
      : undefined;
    const events = turn
      ? (async () => {
          for await (const event of turn.events) {
            void event;
          }
        })()
      : undefined;
    await turn?.promptStarted;

    const response = await runtime.setConfigOption({ handle, key: "llm", value: "selected" });
    assert.equal(
      response.configOptions.find((option) => option.id === "llm")?.currentValue,
      "selected[fast=true]",
    );
    assert.equal(
      response.configOptions.find((option) => option.id === "effort")?.currentValue,
      "low",
    );
    const saved = await context.store.load(handle.acpxRecordId!);
    assert.equal(saved?.acpx?.current_model_id, "selected[fast=true]");
    assert.equal(saved?.acpx?.desired_config_options?.effort, "low");
    await context.assertUnsupported(() =>
      runtime.setConfigOption({ handle, key: "llm", value: "unknown" }),
    );

    const exact = "provider/selected[fast=true]";
    const accepted = await runtime.setConfigOption({ handle, key: "llm", value: exact });
    assert.equal(accepted.configOptions.find((option) => option.id === "llm")?.currentValue, exact);
    if (turn) {
      await context.mark("release-prompt");
      await events;
      assert.equal((await turn.result).status, "completed");
    }
  });
}

test("model config control rejects an alias made ambiguous by cold session load", async (t) => {
  const context = await fixture(t);
  const { handle } = context;
  assert.deepEqual((await context.runtime.getStatus({ handle })).models?.availableModelIds, [
    "default-model",
    "selected[fast=true]",
    "provider/selected[fast=true]",
  ]);
  await context.restart();
  await context.mark("ambiguous-models");
  await context.assertUnsupported(
    () => context.runtime.setConfigOption({ handle, key: "llm", value: "selected" }),
    true,
  );
  assert.equal(await context.read("sessions.jsonl"), '"new"\n"load"\n');
  const accepted = await context.runtime.setConfigOption({
    handle,
    key: "llm",
    value: "selected[fast=false]",
  });
  assert.equal(
    accepted.configOptions.find((option) => option.id === "llm")?.currentValue,
    "selected[fast=false]",
  );
  assert.equal(
    (await context.store.load(handle.acpxRecordId!))?.acpSessionId,
    handle.backendSessionId,
  );
});

for (const change of ["ambiguous-models", "remove-model-control"]) {
  test(`live model controls honor a ${change} notification`, async (t) => {
    const context = await fixture(t);
    const { runtime, handle } = context;
    await context.mark(change);
    const turn = runtime.startTurn({
      handle,
      text: "refresh-models",
      mode: "prompt",
      requestId: "model-update",
    });
    let notificationSeen = false;
    let updated!: () => void;
    const notification = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const events = (async () => {
      for await (const event of turn.events) {
        if (event.type === "status" && event.tag === "config_option_update") {
          notificationSeen = true;
          updated();
        }
      }
    })();
    const completed = events.then(async () => {
      const result = await turn.result;
      if (result.status === "failed") {
        throw Object.assign(new Error(result.error.message), result.error);
      }
      assert.ok(
        notificationSeen,
        `Turn ${result.status} without a config_option_update notification`,
      );
      assert.equal(result.status, "completed");
    });
    await withinDeadline(
      t,
      Promise.race([notification, completed]),
      `the ${change} config_option_update notification`,
    );
    const before = await context.read("received.jsonl");
    await assert.rejects(runtime.setModel({ handle, model: "selected" }), (error: unknown) => {
      assert.ok(isRequestedModelUnsupportedError(error));
      assert.equal(
        error.reason,
        change === "ambiguous-models" ? "unadvertised-model" : "missing-capability",
      );
      assert.equal(error.ambiguous, change === "ambiguous-models" ? true : undefined);
      return true;
    });
    assert.equal(await context.read("received.jsonl"), before);
    await context.mark("release-prompt");
    await withinDeadline(t, completed, `the ${change} turn to finish after release`);
  });
}

for (const route of ["config", "legacy"] as const) {
  test(`${route} model setter validates advertised models while preserving Claude forwarding`, async (t) => {
    const generic = await fixture(t, "fixture-agent", route);
    await generic.assertUnsupported(() =>
      generic.runtime.setModel({ handle: generic.handle, model: "selected" }),
    );
    await generic.runtime.setModel({ handle: generic.handle, model: "selected[fast=true]" });

    const claude = await fixture(t, "claude-agent-acp", route);
    await claude.runtime.setModel({ handle: claude.handle, model: "unlisted-claude-selector" });
    assert.equal(
      (await claude.runtime.getStatus({ handle: claude.handle })).models?.currentModelId,
      "unlisted-claude-selector",
    );
  });
}
