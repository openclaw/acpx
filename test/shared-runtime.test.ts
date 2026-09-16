import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import {
  createSharedAcpRuntime,
  createAgentRegistry,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
} from "../src/runtime.js";
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
  }) => Promise<void>,
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
      permissionMode: "deny-all",
      ttlMs: 60_000,
    });
    const cli = async (...args: string[]) => {
      const result = await run(
        process.execPath,
        [CLI, "--cwd", home, "--agent", command, "--deny-all", ...args],
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
      await check({ runtime, handle, cli, home, pidFile });
    } finally {
      await cli("sessions", "close", "shared");
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
    const unsupportedOptions = {
      cwd: home,
      permissionMode: "deny-all" as const,
      onPermissionRequest: () => "approve",
    };
    assert.throws(() => createSharedAcpRuntime(unsupportedOptions), /in-process/u);
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
  });
});
