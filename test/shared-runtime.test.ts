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
): Promise<void> {
  await withTempHome("acpx-shared-runtime-", async (home) => {
    const pidFile = path.join(home, "agent.pid");
    const command = normalizeAgentCommandInput([
      process.execPath,
      AGENT,
      "--supports-load-session",
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
      const index = await fs.readFile(indexPath, "utf8");
      await fs.writeFile(path.join(sessionDir, "corrupt-session.json"), "{");
      for (const contents of [undefined, "{", index]) {
        if (contents === undefined) {
          await fs.unlink(indexPath);
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
