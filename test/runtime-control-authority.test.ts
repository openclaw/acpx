import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { AgentDisconnectedError } from "../src/errors.js";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpSessionStore,
} from "../src/runtime.js";

const peer = fileURLToPath(
  new URL(
    `./fixtures/control-authority-agent${path.extname(fileURLToPath(import.meta.url))}`,
    import.meta.url,
  ),
);

async function fixture(t: TestContext, route: "config" | "legacy", holdFirst = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-control-authority-"));
  const disk = createFileSessionStore({ stateDir: path.join(root, "state") });
  const store: AcpSessionStore = {
    load: (id) => disk.load(id),
    save: (record) => disk.save(record),
  };
  const pids: number[] = [];
  let recordId: string | undefined;
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: store,
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
  t.after(async () => {
    await fs.writeFile(path.join(root, "release-first"), "release");
    await fs.writeFile(path.join(root, "release-prompt"), "release");
    await runtime.shutdown();
    const record = recordId ? await disk.load(recordId) : undefined;
    t.diagnostic(
      JSON.stringify({
        received: await fs.readFile(path.join(root, "received.jsonl"), "utf8"),
        effects: await fs.readFile(path.join(root, "effects.jsonl"), "utf8"),
        selection: record?.acpx,
      }),
    );
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "received.jsonl"), "");
  await fs.writeFile(path.join(root, "effects.jsonl"), "");
  if (holdFirst) {
    await fs.writeFile(path.join(root, "hold-first"), "hold");
  }
  const handle = await runtime.ensureSession({
    sessionKey: "control-authority",
    agent: "fixture",
    mode: "persistent",
  });
  recordId = handle.acpxRecordId ?? handle.sessionKey;
  const method = route === "config" ? "session/set_config_option" : "session/set_model";
  return {
    runtime,
    store,
    disk,
    handle,
    release: () => fs.writeFile(path.join(root, "release-first"), "release"),
    releasePrompt: () => fs.writeFile(path.join(root, "release-prompt"), "release"),
    disconnectControl: () => fs.writeFile(path.join(root, "disconnect-control"), "disconnect"),
    async received() {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path.join(root, "received-1"))) {
        assert.ok(Date.now() < deadline, "peer did not receive first control");
        await setTimeout(5);
      }
    },
    async selection(model: string, count = 1) {
      const record = await disk.load(handle.acpxRecordId ?? handle.sessionKey);
      assert.equal(record?.acpx?.current_model_id, model);
      assert.equal(record?.acpx?.session_options?.model, model);
      assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, model);
      const entries = Array.from({ length: count }, (_, index) => ({
        sequence: index + 1,
        method,
        value: index === 0 ? "first-model" : "second-model",
      }));
      for (const name of ["received.jsonl", "effects.jsonl"]) {
        const records = (await fs.readFile(path.join(root, name), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line));
        assert.deepEqual(records, entries, name);
      }
    },
    async noControls() {
      assert.equal(await fs.readFile(path.join(root, "received.jsonl"), "utf8"), "");
      assert.equal(await fs.readFile(path.join(root, "effects.jsonl"), "utf8"), "");
    },
  };
}

for (const route of ["config", "legacy"] as const) {
  for (const reason of ["cancel", "timeout", "admission"] as const) {
    test(
      `${route} model control does not dispatch after queued ${reason}`,
      { timeout: 10_000 },
      async (t) => {
        const context = await fixture(t, route);
        const { runtime, handle } = context;
        const first = runtime.setModel({ handle, model: "first-model" });
        await context.received();
        const cancelled = new AbortController();
        const error = new Error("control admission revoked");
        let active = true;
        let markAdmitted!: () => void;
        const admitted = new Promise<void>((resolve) => {
          markAdmitted = resolve;
        });
        const signal = reason === "timeout" ? AbortSignal.timeout(25) : cancelled.signal;
        const input = {
          handle,
          model: "second-model",
          signal,
          assertActive: () => {
            if (!active) {
              throw error;
            }
            markAdmitted();
          },
        };
        const outcome = runtime.setModel(input).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        if (reason !== "timeout") {
          await admitted;
        }
        if (reason === "admission") {
          active = false;
        } else if (reason === "cancel") {
          cancelled.abort(error);
        } else {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await context.release();
        await first;
        const failure = await outcome;
        await context.selection("first-model");
        assert.equal(failure, reason === "admission" ? error : signal.reason);
      },
    );
  }

  test(
    `${route} model control settles an issued request after authority is revoked`,
    { timeout: 10_000 },
    async (t) => {
      const context = await fixture(t, route);
      const { runtime, handle } = context;
      const cancelled = new AbortController();
      let active = true;
      const input = {
        handle,
        model: "first-model",
        signal: cancelled.signal,
        assertActive: () => {
          assert.ok(active, "control admission revoked");
        },
      };
      const pending = runtime.setModel(input);
      await context.received();
      active = false;
      cancelled.abort(new Error("cancelled after dispatch"));
      await context.release();
      await pending;
      await context.selection("first-model");
      await runtime.setModel({ handle, model: "second-model" });
      await context.selection("second-model", 2);
    },
  );
}

for (const control of ["model", "mode", "config"] as const) {
  test(
    `${control} control checks authority after the session store wait`,
    { timeout: 10_000 },
    async (t) => {
      const context = await fixture(t, "config", false);
      const { runtime, handle, store, disk } = context;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      let releaseStore!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseStore = resolve;
      });
      t.signal.addEventListener("abort", releaseStore, { once: true });
      let wait = true;
      store.load = async (id) => {
        if (wait) {
          markEntered();
          await released;
        }
        return disk.load(id);
      };
      const error = new Error("admission expired during session read");
      let active = true;
      const authority = {
        handle,
        assertActive: () => {
          if (!active) {
            throw error;
          }
        },
      };
      const before = await disk.load(handle.acpxRecordId ?? handle.sessionKey);
      const input = {
        ...authority,
        model: "second-model",
        mode: "plan",
        key: "effort",
        value: "high",
      };
      const pending = (
        control === "model"
          ? runtime.setModel(input)
          : control === "mode"
            ? runtime.setMode(input)
            : runtime.setConfigOption(input)
      ).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      await entered;
      active = false;
      wait = false;
      releaseStore();
      const failure = await pending;
      await context.noControls();
      const after = await disk.load(handle.acpxRecordId ?? handle.sessionKey);
      assert.deepEqual(after?.acpx, before?.acpx);
      assert.equal(failure, error);
    },
  );
}

test(
  "active turn model control rejects a queued revoked request",
  { timeout: 10_000 },
  async (t) => {
    const context = await fixture(t, "config");
    const { runtime, handle } = context;
    const turn = runtime.startTurn({
      handle,
      text: "hold prompt",
      mode: "prompt",
      requestId: "active-control-authority",
    });
    const events = (async () => {
      for await (const event of turn.events) {
        void event;
      }
    })();
    await turn.promptStarted;
    const first = runtime.setModel({ handle, model: "first-model" });
    await context.received();
    const cancelled = new AbortController();
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    const input = {
      handle,
      model: "second-model",
      signal: cancelled.signal,
      assertActive: markAdmitted,
    };
    const pending = runtime.setModel(input).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    const error = new Error("active control cancelled while queued");
    await admitted;
    cancelled.abort(error);
    await context.release();
    await first;
    const failure = await pending;
    await context.releasePrompt();
    await events;
    assert.equal((await turn.result).status, "completed");
    await context.selection("first-model");
    assert.equal(failure, error);
  },
);

for (const route of ["config", "legacy"] as const) {
  test(
    `${route} client checks authority inside deferred native request`,
    { timeout: 10_000 },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-control-dispatch-"));
      const client = new AcpClient({
        agentCommand: process.execPath,
        agentArgv: [process.execPath, "--import", import.meta.resolve("tsx"), peer, root, route],
        cwd: root,
        permissionMode: "deny-all",
      });
      t.after(async () => {
        const pid = client.getAgentPid();
        await client.close();
        if (pid) {
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
        t.diagnostic(
          JSON.stringify({
            received: await fs.readFile(path.join(root, "received.jsonl"), "utf8"),
            effects: await fs.readFile(path.join(root, "effects.jsonl"), "utf8"),
          }),
        );
        await fs.rm(root, { recursive: true, force: true });
      });
      await fs.writeFile(path.join(root, "received.jsonl"), "");
      await fs.writeFile(path.join(root, "effects.jsonl"), "");
      await client.start();
      const { sessionId, models } = await client.createSession();
      const error = new Error("admission revoked before request microtask");
      const cancelled = new AbortController();
      let active = true;
      const authority = {
        signal: cancelled.signal,
        assertActive: () => {
          if (!active) {
            throw error;
          }
        },
      };
      const pending = client.setSessionModel(sessionId, "second-model", models, authority).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      if (route === "legacy") {
        cancelled.abort(error);
      } else {
        active = false;
      }
      const failure = await pending;
      assert.equal(await fs.readFile(path.join(root, "received.jsonl"), "utf8"), "");
      assert.equal(await fs.readFile(path.join(root, "effects.jsonl"), "utf8"), "");
      assert.equal(failure, error);
    },
  );
}

for (const route of ["config", "legacy"] as const) {
  test(
    `${route} model control preserves error context when the agent disconnects`,
    { timeout: 10_000 },
    async (t) => {
      const context = await fixture(t, route, false);
      await context.disconnectControl();
      const failure = await context.runtime
        .setModel({
          handle: context.handle,
          model: "second-model",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      assert(failure instanceof Error);
      t.diagnostic(
        JSON.stringify({ name: failure.name, message: failure.message, cause: failure.cause }),
      );
      const method = route === "config" ? "session/set_config_option" : "session/set_model";
      assert(failure.message.startsWith(`Failed ${method} for model "second-model":`));
      assert(failure.cause instanceof AgentDisconnectedError);
      assert.equal(failure.cause.detailCode, "AGENT_DISCONNECTED");
      const record = await context.disk.load(
        context.handle.acpxRecordId ?? context.handle.sessionKey,
      );
      assert.equal(record?.acpx?.current_model_id, "default-model");
    },
  );
}
