import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import {
  createSharedAcpRuntime,
  createAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type SessionWatchEvent,
} from "../src/runtime.js";
import { findSession } from "../src/session/persistence.js";
import { readQueueOwnerRecord } from "../src/session/queue/lease-store.js";
import { extractAgentMessageChunkText } from "./jsonrpc-test-helpers.js";
import { withTempHome } from "./runtime-test-helpers.js";

const run = promisify(execFile);
const CLI = fileURLToPath(import.meta.resolve("acpx/dist/cli.js"));
const AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function withSharedSession(
  check: (fixture: {
    runtime: ReturnType<typeof createSharedAcpRuntime>;
    handle: AcpRuntimeHandle;
    cli: (...args: string[]) => Promise<string>;
    home: string;
    pidFile: string;
    command: string;
  }) => Promise<void>,
  permissionMode: "deny-all" | "approve-reads" = "deny-all",
  agentArgs: string[] = [],
): Promise<void> {
  await withTempHome("acpx-shared-runtime-", async (home) => {
    const pidFile = path.join(home, "agent.pid");
    const command = normalizeAgentCommandInput([
      process.execPath,
      AGENT,
      "--supports-load-session",
      ...agentArgs,
      "--pid-file",
      pidFile,
    ]).agentCommand;
    const runtime = createSharedAcpRuntime({
      cwd: home,
      agentRegistry: createAgentRegistry({ overrides: { mock: command } }),
      permissionMode,
      ttlMs: 60_000,
    });
    const cli = async (...args: string[]) => {
      const result = await run(
        process.execPath,
        [CLI, "--cwd", home, "--agent", command, `--${permissionMode}`, ...args],
        { env: process.env, timeout: 15_000 },
      );
      return result.stdout;
    };
    const handle = await runtime.ensureSession({
      sessionKey: "shared",
      agent: "mock",
      mode: "persistent",
    });
    try {
      await check({ runtime, handle, cli, home, pidFile, command });
    } finally {
      const record = await findSession({ agentCommand: command, cwd: home, name: "shared" });
      if (record) {
        await cli("sessions", "close", "shared");
      }
      await runtime.shutdown();
    }
  });
}

async function output(events: AsyncIterable<AcpRuntimeEvent>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.type === "text_delta" && event.stream === "output") {
      text += event.text;
    }
  }
  return text;
}

test("shared runtime and external CLI use the same owner and connection", async () => {
  await withSharedSession(async ({ runtime, handle, cli, pidFile }) => {
    const first = runtime.startTurn({
      handle,
      text: "stream-sleep 250 first-shared",
      requestId: "first",
      mode: "prompt",
    });
    const firstOutput = output(first.events);
    await first.promptStarted;
    const pid = await fs.readFile(pidFile, "utf8");
    await cli("prompt", "--no-wait", "-s", "shared", "echo cli-middle");
    assert.equal((await first.result).status, "completed");
    assert.match(await firstOutput, /first-shared/u);
    const last = runtime.startTurn({
      handle,
      text: "echo runtime-last",
      requestId: "last",
      mode: "prompt",
    });
    assert.equal(await output(last.events), "runtime-last");
    assert.equal((await last.result).status, "completed");
    assert.equal(await fs.readFile(pidFile, "utf8"), pid);
    assert.equal((await runtime.getStatus({ handle })).lastRequestId, "last");
    assert.match(await cli("sessions", "read", "shared"), /cli-middle/u);
    const active = runtime.startTurn({
      handle,
      text: "sleep 10000",
      requestId: "cancel-from-cli",
      mode: "prompt",
    });
    await active.promptStarted;
    await cli("cancel", "-s", "shared");
    assert.equal((await active.result).status, "cancelled");
  });
});

test("public watch reports uncertainty after its owner dies", { timeout: 20_000 }, async () => {
  await withSharedSession(async ({ runtime, handle }) => {
    const turn = runtime.startTurn({
      handle,
      text: "sleep 10000",
      requestId: "owner-loss",
      mode: "prompt",
    });
    await turn.promptStarted;
    const watching = runtime.watchSession({ handle, signal: AbortSignal.timeout(10_000) });
    const iterator = watching[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "turn_started");
    const owner = await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName);
    assert.ok(owner);
    process.kill(owner.pid, "SIGKILL");
    await assert.rejects(async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Watch ended without reporting owner loss");
        }
      }
    }, /outcome is unknown/u);
    assert.equal((await turn.result).status, "failed");
  });
});

async function watchedTurn(
  events: AsyncIterable<SessionWatchEvent>,
  requestId: string,
): Promise<SessionWatchEvent[]> {
  const captured: SessionWatchEvent[] = [];
  for await (const event of events) {
    captured.push(event);
    if (event.type === "turn_result" && event.requestId === requestId) {
      return captured;
    }
  }
  throw new Error(`Watch ended without result for ${requestId}`);
}

function cliWatcher(
  home: string,
  command: string,
  extra: { global?: string[]; watch?: string[] } = {},
) {
  const child = spawn(
    process.execPath,
    [
      CLI,
      "--cwd",
      home,
      "--agent",
      command,
      "--format",
      "json",
      ...(extra.global ?? []),
      "sessions",
      "watch",
      "-s",
      "shared",
      ...(extra.watch ?? []),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const events = (async function* () {
    for await (const line of lines) {
      const event = JSON.parse(line) as SessionWatchEvent;
      assert.equal(typeof event.cursor, "string", line);
      yield event;
    }
  })();
  return {
    events,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
      }
      const [code] = await closed;
      assert.equal(code, 0, stderr);
    },
  };
}

test(
  "public and CLI watchers replay, follow and resume without affecting the shared turn",
  { timeout: 20_000 },
  async () => {
    await withSharedSession(async ({ runtime, handle, home, command, pidFile }) => {
      const turn = runtime.startTurn({
        handle,
        text: "stream-sleep 500 watch-one",
        requestId: "watch-one",
        mode: "prompt",
      });
      await turn.promptStarted;
      const pid = await fs.readFile(pidFile, "utf8");
      const cli = cliWatcher(home, command);
      try {
        const [apiEvents, cliEvents] = await Promise.all([
          watchedTurn(
            runtime.watchSession({ handle, signal: AbortSignal.timeout(10_000) }),
            "watch-one",
          ),
          watchedTurn(cli.events, "watch-one"),
        ]);
        assert.equal((await turn.result).status, "completed");
        assert.deepEqual(cliEvents, apiEvents);
        const messages = apiEvents.flatMap((event) =>
          event.type === "message" ? [event.message] : [],
        );
        assert.match(messages.map(extractAgentMessageChunkText).join(""), /watch-one/u);
        assert.equal(new Set(apiEvents.map((event) => event.cursor)).size, apiEvents.length);
        const cursor = apiEvents.at(-1)?.cursor;
        assert.ok(cursor);
        await cli.stop();
        const second = runtime.startTurn({
          handle,
          text: "echo watch-two",
          requestId: "watch-two",
          mode: "prompt",
        });
        const secondCli = cliWatcher(home, command, { watch: ["--cursor", cursor] });
        let resumed: SessionWatchEvent[];
        try {
          const [fromApi, fromCli] = await Promise.all([
            watchedTurn(
              runtime.watchSession({ handle, cursor, signal: AbortSignal.timeout(10_000) }),
              "watch-two",
            ),
            watchedTurn(secondCli.events, "watch-two"),
          ]);
          assert.deepEqual(fromCli, fromApi);
          resumed = fromApi;
        } finally {
          await secondCli.stop();
        }
        assert.equal((await second.result).status, "completed");
        assert.ok(resumed.every((event) => event.requestId !== "watch-one"));
        assert.equal(await fs.readFile(pidFile, "utf8"), pid);
      } finally {
        await cli.stop();
      }
    });
  },
);

test(
  "returning an idle public watcher does not start an owner or change session activity",
  { timeout: 10_000 },
  async () => {
    await withSharedSession(async ({ runtime, handle, pidFile }) => {
      const before = await runtime.getStatus({ handle });
      const pid = await fs.readFile(pidFile, "utf8");
      const iterator = runtime.watchSession({ handle })[Symbol.asyncIterator]();
      const pending = iterator.next();
      assert.ok(iterator.return);
      await iterator.return();
      assert.equal((await pending).done, true);
      assert.deepEqual(await runtime.getStatus({ handle }), before);
      assert.equal(await fs.readFile(pidFile, "utf8"), pid);
    });
  },
);

test(
  "closed public watchers finish replay and reject foreign or invalid cursors",
  { timeout: 10_000 },
  async () => {
    await withSharedSession(async ({ runtime, handle, cli, home }) => {
      const turn = runtime.startTurn({
        handle,
        text: "echo before-close",
        requestId: "before-close",
        mode: "prompt",
      });
      const events = await watchedTurn(
        runtime.watchSession({ handle, signal: AbortSignal.timeout(5_000) }),
        "before-close",
      );
      assert.equal((await turn.result).status, "completed");
      await runtime.close({ handle, reason: "watch closed history" });
      const replay: SessionWatchEvent[] = [];
      for await (const event of runtime.watchSession({ handle })) {
        replay.push(event);
      }
      assert.deepEqual(replay, events);
      const text = await cli("sessions", "watch", "-s", "shared");
      assert.match(text, /\[before-close\] completed: end_turn/u);
      assert.doesNotMatch(text, /\[done\]/u);
      const quiet = await cli("--format", "quiet", "sessions", "watch", "-s", "shared");
      assert.equal(quiet.trim(), "before-close");
      const sessionDir = path.join(home, ".acpx", "sessions");
      const indexPath = path.join(sessionDir, "index.json");
      const index = JSON.stringify({ schema: "acpx.session-index.v1", files: [], entries: [] });
      await fs.writeFile(path.join(sessionDir, "corrupt-session.json"), "{");
      for (const contents of [undefined, "{", index]) {
        if (contents === undefined) {
          await fs.rm(indexPath, { force: true });
        } else {
          await fs.writeFile(indexPath, contents);
        }
        await fs.chmod(sessionDir, 0o500);
        try {
          const replay = await cli("--format", "json", "sessions", "watch", "-s", "shared");
          assert.deepEqual(
            replay
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
            events,
          );
          if (contents === undefined) {
            await assert.rejects(fs.readFile(indexPath), { code: "ENOENT" });
          } else {
            assert.equal(await fs.readFile(indexPath, "utf8"), contents);
          }
          if (process.platform !== "win32") {
            assert.equal((await fs.stat(sessionDir)).mode & 0o777, 0o500);
          }
        } finally {
          await fs.chmod(sessionDir, 0o700);
        }
      }
      for (const cursor of [
        "not-a-cursor",
        Buffer.from(JSON.stringify(["another-record", 0])).toString("base64url"),
      ]) {
        await assert.rejects(
          runtime.watchSession({ handle, cursor })[Symbol.asyncIterator]().next(),
          /cursor|another session/iu,
        );
      }
    });
  },
);

test(
  "resumed CLI watching suppresses raw read results without their request announcement",
  { timeout: 15_000 },
  async () => {
    await withSharedSession(async ({ runtime, handle, home, command }) => {
      const file = path.join(home, "read-fixture.txt");
      const sentinel = "SYNTHETIC_PRIVATE_READ_8274";
      await fs.writeFile(file, sentinel);
      const turn = runtime.startTurn({
        handle,
        text: `read ${file}`,
        requestId: "read-turn",
        mode: "prompt",
      });
      const all = await watchedTurn(
        runtime.watchSession({ handle, signal: AbortSignal.timeout(10_000) }),
        "read-turn",
      );
      assert.equal((await turn.result).status, "completed");
      const request = all.find(
        (event) =>
          event.type === "message" &&
          "method" in event.message &&
          event.message.method === "fs/read_text_file",
      );
      assert.ok(request);
      const watcher = cliWatcher(home, command, {
        global: ["--suppress-reads"],
        watch: ["--cursor", request.cursor],
      });
      try {
        const resumed = await watchedTurn(watcher.events, "read-turn");
        const results = resumed.flatMap((event) =>
          event.type === "message" && "result" in event.message
            ? [JSON.stringify(event.message.result)]
            : [],
        );
        assert.ok(
          results.some((result) => result.includes("[read output suppressed]")),
          JSON.stringify(results),
        );
        assert.ok(results.every((result) => !result.includes(sentinel)));
      } finally {
        await watcher.stop();
      }
    }, "approve-reads");
  },
);

test(
  "CLI watch selects the open named session after an older session is closed",
  { timeout: 15_000 },
  async () => {
    await withSharedSession(async ({ runtime, handle, home, command }) => {
      await runtime.close({ handle, reason: "replace closed session" });
      const current = await runtime.ensureSession({
        sessionKey: "shared",
        agent: "mock",
        mode: "persistent",
      });
      assert.notEqual(current.acpxRecordId, handle.acpxRecordId);
      const watcher = cliWatcher(home, command);
      try {
        const turn = runtime.startTurn({
          handle: current,
          text: "echo new-open-session",
          requestId: "new-open",
          mode: "prompt",
        });
        const events = await watchedTurn(watcher.events, "new-open");
        assert.equal((await turn.result).status, "completed");
        assert.ok(
          events.some((event) => event.type === "turn_result" && event.requestId === "new-open"),
        );
      } finally {
        await watcher.stop();
      }
    });
  },
);

test("shared turn cancellation never cancels a different active turn", async () => {
  await withSharedSession(async ({ runtime, handle }) => {
    const first = runtime.startTurn({
      handle,
      text: "stream-sleep 500 active-survives",
      requestId: "active",
      mode: "prompt",
    });
    await first.promptStarted;
    const controller = new AbortController();
    const queued = runtime.startTurn({
      handle,
      text: "echo must-not-run",
      requestId: "queued",
      mode: "prompt",
      signal: controller.signal,
    });
    controller.abort();
    assert.equal((await queued.result).status, "cancelled");
    await assert.rejects(queued.promptStarted);
    assert.equal((await first.result).status, "completed");
    const next = runtime.startTurn({
      handle,
      text: "echo after-cancel",
      requestId: "after",
      mode: "prompt",
    });
    assert.equal(await output(next.events), "after-cancel");
    assert.equal((await next.result).status, "completed");
  });
});

test("shared client shutdown detaches without stopping another client's work", async () => {
  await withSharedSession(async ({ runtime, handle, cli, pidFile }) => {
    const turn = runtime.startTurn({
      handle,
      text: "stream-sleep 300 keep-running",
      requestId: "detached",
      mode: "prompt",
    });
    await turn.promptStarted;
    const pid = await fs.readFile(pidFile, "utf8");
    await runtime.shutdown();
    assert.equal((await turn.result).status, "failed");
    assert.match(await cli("prompt", "-s", "shared", "echo cli-after-detach"), /cli-after-detach/u);
    assert.equal(await fs.readFile(pidFile, "utf8"), pid);
    assert.match(await cli("sessions", "read", "shared"), /keep-running/u);
    assert.throws(
      () => runtime.startTurn({ handle, text: "echo no", requestId: "closed", mode: "prompt" }),
      /shut down/u,
    );
  });
});

test("concurrent shared and CLI ensure resolve one named session", async () => {
  await withSharedSession(async ({ runtime, cli }) => {
    const request = { sessionKey: "racing", agent: "mock", mode: "persistent" as const };
    const [one, two, fromCli] = await Promise.all([
      runtime.ensureSession(request),
      runtime.ensureSession(request),
      cli("--format", "json", "sessions", "ensure", "--name", "racing"),
    ]);
    assert.equal(one.acpxRecordId, two.acpxRecordId);
    assert.ok(one.acpxRecordId);
    assert.ok(fromCli.includes(one.acpxRecordId));
    assert.equal((await runtime.findSession(request))?.acpxRecordId, one.acpxRecordId);
    await runtime.close({ handle: one, reason: "test complete" });
  });
});

test("shared mode rejects in-process callbacks and unsupported session modes", async () => {
  await withSharedSession(async ({ runtime, handle, home }) => {
    for (const callbacks of [
      { onPermissionRequest: () => "approve" },
      { sessionPermissions: () => ({ permissionMode: "approve-all" }) },
      { fs: false },
      { terminal: false },
    ]) {
      assert.throws(
        () =>
          createSharedAcpRuntime({
            cwd: home,
            permissionMode: "deny-all",
            ...callbacks,
          }),
        /in-process/u,
      );
    }
    assert.throws(
      () => runtime.ensureSession({ sessionKey: "one", agent: "mock", mode: "oneshot" }),
      /persistent mode/u,
    );
    assert.throws(
      () => runtime.startTurn({ handle, requestId: "steer", mode: "steer", text: "no" }),
      /steering/u,
    );
    assert.throws(
      () =>
        runtime.startTurn({
          handle,
          requestId: "callback",
          mode: "prompt",
          text: "no",
          onPermissionRequest: async () => ({ outcome: "allow_once" }),
        }),
      /callbacks/u,
    );
    assert.throws(
      () =>
        runtime.startTurn({
          handle,
          requestId: "authority",
          mode: "prompt",
          text: "no",
          assertActive: () => {},
        }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
  });
});

async function withOwnerRunning(
  runtime: ReturnType<typeof createSharedAcpRuntime>,
  handle: AcpRuntimeHandle,
  requestId: string,
): Promise<void> {
  const turn = runtime.startTurn({ handle, text: "echo owner-up", requestId, mode: "prompt" });
  assert.equal((await turn.result).status, "completed");
  assert.ok(await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName));
}

test("shared session controls run on the running owner's connection", async () => {
  await withSharedSession(
    async ({ runtime, handle, cli, pidFile }) => {
      const asRuntime: AcpRuntime = runtime;
      assert.equal(typeof asRuntime.setConfigOption, "function");
      // Controls sent while the owner holds an active turn must travel over that
      // live connection instead of starting another one.
      const turn = runtime.startTurn({
        handle,
        text: "stream-sleep 1500 controls-active",
        requestId: "controls-active",
        mode: "prompt",
      });
      const streamed = output(turn.events);
      await turn.promptStarted;
      const pid = await fs.readFile(pidFile, "utf8");
      const owner = await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName);
      assert.ok(owner);

      await runtime.setModel({ handle, model: "fast-model" });
      await runtime.setMode({ handle, mode: "plan" });
      const response = await runtime.setConfigOption({
        handle,
        key: "reasoning_effort",
        value: "high",
      });

      assert.ok(response);
      assert.deepEqual(Object.keys(response), ["configOptions"]);
      assert.equal(
        response.configOptions?.find((option) => option.id === "reasoning_effort")?.currentValue,
        "high",
      );
      assert.equal(await fs.readFile(pidFile, "utf8"), pid);
      assert.deepEqual(
        await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName),
        owner,
      );

      assert.match(await streamed, /controls-active/u);
      assert.equal((await turn.result).status, "completed");
      assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, "fast-model");

      // Shared key lookup uses the persisted advertisement.
      await assert.rejects(runtime.setConfigOption({ handle, key: "nope", value: "x" }), {
        code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      });

      const shown = await cli("--format", "json", "sessions", "show", "shared");
      const record = JSON.parse(shown) as {
        acpx?: { current_model_id?: string; desired_mode_id?: string };
      };
      assert.equal(record.acpx?.current_model_id, "fast-model");
      assert.equal(record.acpx?.desired_mode_id, "plan");
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("an idle shared owner serves controls on its retained connection", async () => {
  await withSharedSession(
    async ({ runtime, handle }) => {
      await withOwnerRunning(runtime, handle, "idle-owner");
      const owner = await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName);
      assert.ok(owner);
      const before = await runtime.getStatus({ handle });

      // Between turns the owner serves the control on its retained connection.
      // The shared client never opens one, and the owner and the saved provider
      // session both survive the control.
      await runtime.setModel({ handle, model: "smart-model" });

      const after = await runtime.getStatus({ handle });
      assert.equal(after.models?.currentModelId, "smart-model");
      assert.equal(after.backendSessionId, before.backendSessionId);
      assert.deepEqual(
        await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName),
        owner,
      );
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("shared session controls fail closed when no owner holds the session", async () => {
  await withSharedSession(
    async ({ runtime, handle, pidFile }) => {
      assert.equal(
        await readQueueOwnerRecord(handle.acpxRecordId ?? handle.runtimeSessionName),
        undefined,
      );
      const before = await runtime.getStatus({ handle });
      const pid = await fs.readFile(pidFile, "utf8");

      for (const control of [
        () => runtime.setMode({ handle, mode: "plan" }),
        () => runtime.setModel({ handle, model: "fast-model" }),
        () => runtime.setConfigOption({ handle, key: "reasoning_effort", value: "high" }),
      ]) {
        await assert.rejects(control(), {
          code: "ACP_BACKEND_UNAVAILABLE",
          message: /No running owner holds this shared session/u,
        });
      }

      // Failing closed must leave both the saved session and the adapter process alone.
      assert.deepEqual(await runtime.getStatus({ handle }), before);
      assert.equal(await fs.readFile(pidFile, "utf8"), pid);
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("shared session controls check local authority before sending", async () => {
  await withSharedSession(
    async ({ runtime, handle }) => {
      await withOwnerRunning(runtime, handle, "authority-owner");
      const before = await runtime.getStatus({ handle });

      const inactive = () => {
        throw new Error("host is no longer active");
      };
      await assert.rejects(runtime.setMode({ handle, mode: "plan", assertActive: inactive }), {
        message: "host is no longer active",
      });
      await assert.rejects(
        runtime.setModel({ handle, model: "fast-model", assertActive: inactive }),
        { message: "host is no longer active" },
      );
      await assert.rejects(
        runtime.setConfigOption({
          handle,
          key: "reasoning_effort",
          value: "high",
          assertActive: inactive,
        }),
        { message: "host is no longer active" },
      );
      await assert.rejects(
        runtime.setModel({ handle, model: "fast-model", signal: AbortSignal.abort() }),
        { name: "AbortError" },
      );

      // A rejected control is never sent, so the saved selection is unchanged.
      assert.deepEqual(await runtime.getStatus({ handle }), before);
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("shared capabilities report the session's advertised config option keys", async () => {
  await withSharedSession(
    async ({ runtime, handle }) => {
      const base = await runtime.getCapabilities();
      assert.deepEqual(base, {
        controls: [
          "session/set_mode",
          "session/set_model",
          "session/set_config_option",
          "session/status",
        ],
      });

      // Handle-scoped capabilities add only what the session actually advertised.
      const advertised = await runtime.getCapabilities({ handle });
      assert.deepEqual(advertised.controls, base.controls);
      assert.deepEqual(advertised.configOptionKeys, ["mode", "model", "reasoning_effort"]);

      const unknown = await runtime.getCapabilities({
        handle: { ...handle, acpxRecordId: "missing-record" },
      });
      assert.deepEqual(unknown, base);
      assert.notStrictEqual(unknown, base);
      assert.notStrictEqual(base.controls, advertised.controls);
      assert.notStrictEqual(unknown.controls, base.controls);
      base.controls.length = 0;
      base.configOptionKeys = ["injected"];
      advertised.controls = ["session/status"];
      advertised.configOptionKeys?.push("changed");
      const expected = {
        controls: [
          "session/set_mode",
          "session/set_model",
          "session/set_config_option",
          "session/status",
        ],
      };
      assert.deepEqual(unknown, expected);
      assert.deepEqual(await runtime.getCapabilities(), expected);
      assert.deepEqual(await runtime.getCapabilities({ handle }), {
        ...expected,
        configOptionKeys: ["mode", "model", "reasoning_effort"],
      });
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("CLI set-mode during an active turn survives the turn's checkpoint", async () => {
  await withSharedSession(async ({ runtime, handle, cli }) => {
    const turn = runtime.startTurn({
      handle,
      text: "stream-sleep 1500 mode-during-turn",
      requestId: "mode-during-turn",
      mode: "prompt",
    });
    const streamed = output(turn.events);
    await turn.promptStarted;

    assert.match(await cli("set-mode", "plan", "-s", "shared"), /plan/u);

    assert.match(await streamed, /mode-during-turn/u);
    assert.equal((await turn.result).status, "completed");
    const record = JSON.parse(await cli("--format", "json", "sessions", "show", "shared")) as {
      acpx?: { desired_mode_id?: string };
    };
    assert.equal(record.acpx?.desired_mode_id, "plan");
  });
});

test("concurrent shared controls persist the last accepted selection", async () => {
  await withSharedSession(
    async ({ runtime, handle }) => {
      await withOwnerRunning(runtime, handle, "concurrent-owner");

      // One client's calls retain submission order through owner acknowledgement.
      await Promise.all([
        runtime.setModel({ handle, model: "fast-model" }),
        runtime.setModel({ handle, model: "smart-model" }),
        runtime.setModel({ handle, model: "gpt-5.4" }),
      ]);

      assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, "gpt-5.4");

      await assert.rejects(runtime.setModel({ handle, model: "not-advertised" }), {
        message: /not-advertised/u,
      });
      assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, "gpt-5.4");
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("authority withdrawn during a control's own lookup still blocks the send", async () => {
  await withSharedSession(
    async ({ runtime, handle }) => {
      await withOwnerRunning(runtime, handle, "late-authority-owner");
      const before = await runtime.getStatus({ handle });

      // setConfigOption reads the record to resolve the advertised key. Authority
      // revoked while that read is pending must still stop the control.
      let checks = 0;
      await assert.rejects(
        runtime.setConfigOption({
          handle,
          key: "reasoning_effort",
          value: "high",
          assertActive: () => {
            checks += 1;
            if (checks > 1) {
              throw new Error("host went inactive mid-lookup");
            }
          },
        }),
        { message: "host went inactive mid-lookup" },
      );
      assert.ok(checks > 1, `expected a recheck after the lookup, saw ${checks}`);
      assert.deepEqual(await runtime.getStatus({ handle }), before);
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("authority withdrawn during owner lookup and connect blocks the write", async () => {
  await withSharedSession(
    async ({ runtime, handle }) => {
      await withOwnerRunning(runtime, handle, "dispatch-guard-owner");
      const before = await runtime.getStatus({ handle });

      // The control still has to find the owner record and connect its socket
      // after the first check. Revoking authority across those awaits must stop
      // the request reaching the owner, so the selection never changes.
      for (const [control, run] of [
        [
          "setMode",
          (active: () => void) => runtime.setMode({ handle, mode: "plan", assertActive: active }),
        ],
        [
          "setModel",
          (active: () => void) =>
            runtime.setModel({ handle, model: "fast-model", assertActive: active }),
        ],
        [
          "setConfigOption",
          (active: () => void) =>
            runtime.setConfigOption({
              handle,
              key: "reasoning_effort",
              value: "high",
              assertActive: active,
            }),
        ],
      ] as const) {
        let checks = 0;
        const assertActive = () => {
          checks += 1;
          // Config controls also check after their saved-key lookup. Keep that
          // check active so every case reaches the final socket-write guard.
          if (checks === (control === "setConfigOption" ? 3 : 2)) {
            throw new Error(`${control} lost authority`);
          }
        };
        await assert.rejects(run(assertActive), { message: `${control} lost authority` });
        assert.equal(checks, control === "setConfigOption" ? 3 : 2);
      }

      assert.deepEqual(await runtime.getStatus({ handle }), before);
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});

test("shared controls settle accepted state after dispatch authority is revoked", async () => {
  await withSharedSession(
    async ({ runtime, handle, command, home }) => {
      await withOwnerRunning(runtime, handle, "settlement-owner");
      for (const [finalCheck, run] of [
        [
          2,
          (authority: { signal: AbortSignal; assertActive: () => void }) =>
            runtime.setMode({ handle, mode: "plan", ...authority }),
        ],
        [
          2,
          (authority: { signal: AbortSignal; assertActive: () => void }) =>
            runtime.setModel({ handle, model: "fast-model", ...authority }),
        ],
        [
          3,
          (authority: { signal: AbortSignal; assertActive: () => void }) =>
            runtime.setConfigOption({
              handle,
              key: "reasoning_effort",
              value: "high",
              ...authority,
            }),
        ],
      ] as const) {
        const abort = new AbortController();
        let checks = 0;
        let active = true;
        await run({
          signal: abort.signal,
          assertActive: () => {
            assert.ok(active, "authority was consulted after dispatch");
            if (++checks === finalCheck) {
              // The synchronous socket write precedes this microtask; the
              // asynchronous owner response must still be received and saved.
              queueMicrotask(() => {
                active = false;
                abort.abort(new Error("authority revoked after dispatch"));
              });
            }
          },
        });
        assert.equal(checks, finalCheck);
        assert.equal(abort.signal.aborted, true);
      }
      const state = await runtime.getStatus({ handle });
      assert.equal(state.models?.currentModelId, "fast-model");
      const record = await findSession({
        agentCommand: command,
        cwd: home,
        name: "shared",
      });
      assert.equal(record?.acpx?.desired_mode_id, "plan");
      assert.equal(record?.acpx?.desired_config_options?.reasoning_effort, "high");
    },
    "deny-all",
    ["--advertise-config-options"],
  );
});
