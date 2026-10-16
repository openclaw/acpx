import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { FlowRunner, acp, action, defineFlow } from "../src/flows/runtime.js";
import { connectAndLoadSession } from "../src/runtime/engine/reconnect.js";
import { createSession } from "../src/session/execution/session-management.js";
import { readSessionRecord } from "../src/session/persistence.js";
import { withTempHome } from "./runtime-test-helpers.js";

const AGENT = fileURLToPath(new URL("./fixtures/reused-session-agent.js", import.meta.url));

test("explicit native resume without replay never becomes eligible for fresh recovery", async (t) => {
  await withTempHome("acpx-explicit-resume-", async (home) => {
    t.mock.method(AcpClient.prototype, "start", async () => {});
    t.mock.method(AcpClient.prototype, "supportsLoadSession", () => true);
    t.mock.method(AcpClient.prototype, "supportsResumeSession", () => false);
    t.mock.method(AcpClient.prototype, "loadSessionWithOptions", async () => ({}));
    t.mock.method(AcpClient.prototype, "createSession", async () => {
      throw new Error("must not replace an explicitly resumed session");
    });
    const options = {
      agentCommand: "synthetic-agent",
      cwd: home,
      permissionMode: "deny-all" as const,
      handleProcessInterrupts: false,
    };
    const resumed = await createSession({ ...options, resumeSessionId: "existing-native-session" });
    const record = await readSessionRecord(resumed.acpxRecordId);
    assert.ok(record);
    assert.equal(record.acpx?.session_origin, "resume");
    assert.deepEqual(record.messages, []);
    t.mock.method(AcpClient.prototype, "loadSessionWithOptions", async () => {
      throw { error: { code: -32603, message: "backend temporarily unavailable" } };
    });
    const client = new AcpClient(options);
    try {
      await assert.rejects(
        connectAndLoadSession({
          client,
          record,
          resumePolicy: "same-session-only",
          activeController: {
            hasActivePrompt: () => false,
            requestCancelActivePrompt: async () => false,
            setSessionMode: async () => {},
            setSessionModel: async () => {},
            setSessionConfigOption: async () => ({ configOptions: [] }),
          },
        }),
        /Persistent ACP session existing-native-session could not be resumed/,
      );
      assert.equal(record.acpSessionId, "existing-native-session");
    } finally {
      await client.close();
    }
  });
});

test("new sessions receive distinct local records when an adapter reuses its session ID", async (t) => {
  await withTempHome("acpx-session-collision-", async (home) => {
    t.mock.method(AcpClient.prototype, "start", async () => {});
    t.mock.method(AcpClient.prototype, "createSession", async () => ({
      sessionId: "reused-provider-id",
    }));
    const options = {
      agentCommand: "synthetic-agent",
      cwd: home,
      permissionMode: "deny-all" as const,
      handleProcessInterrupts: false,
    };
    const first = await createSession({ ...options, name: "flow-a" });
    const second = await createSession({ ...options, name: "flow-b" });
    assert.equal(first.acpx?.session_origin, "new");
    assert.equal((await readSessionRecord(first.acpxRecordId))?.acpx?.session_origin, "new");
    assert.equal(first.acpSessionId, second.acpSessionId);
    assert.notEqual(first.acpxRecordId, second.acpxRecordId);
    assert.equal((await readSessionRecord(first.acpxRecordId))?.name, "flow-a");
    assert.equal((await readSessionRecord(second.acpxRecordId))?.name, "flow-b");
  });
});

test("resuming an adapter ID cannot overwrite a different agent's local record", async (t) => {
  await withTempHome("acpx-resume-collision-", async (home) => {
    t.mock.method(AcpClient.prototype, "start", async () => {});
    t.mock.method(AcpClient.prototype, "createSession", async () => ({ sessionId: "provider-a" }));
    t.mock.method(AcpClient.prototype, "supportsLoadSession", () => true);
    t.mock.method(AcpClient.prototype, "loadSessionWithOptions", async () => ({}));
    const options = {
      cwd: home,
      permissionMode: "deny-all" as const,
      handleProcessInterrupts: false,
    };
    const original = await createSession({ ...options, agentCommand: "agent-a", name: "original" });
    const resumed = await createSession({
      ...options,
      agentCommand: "agent-b",
      name: "resumed",
      resumeSessionId: original.acpxRecordId,
    });
    assert.notEqual(resumed.acpxRecordId, original.acpxRecordId);
    assert.equal((await readSessionRecord(original.acpxRecordId))?.agentCommand, "agent-a");
    assert.equal((await readSessionRecord(original.acpxRecordId))?.name, "original");
    assert.equal(resumed.acpSessionId, original.acpxRecordId);
  });
});

test("resuming a local record uses its distinct adapter session ID", async (t) => {
  await withTempHome("acpx-local-resume-", async (home) => {
    t.mock.method(AcpClient.prototype, "start", async () => {});
    t.mock.method(AcpClient.prototype, "createSession", async () => ({
      sessionId: "provider-resume-id",
    }));
    t.mock.method(AcpClient.prototype, "supportsLoadSession", () => true);
    let loadedId: string | undefined;
    t.mock.method(AcpClient.prototype, "loadSessionWithOptions", async (sessionId: string) => {
      loadedId = sessionId;
      return {};
    });
    const options = {
      agentCommand: "synthetic-agent",
      cwd: home,
      permissionMode: "deny-all" as const,
      handleProcessInterrupts: false,
    };
    const original = await createSession(options);
    assert.notEqual(original.acpxRecordId, original.acpSessionId);
    const resumed = await createSession({ ...options, resumeSessionId: original.acpxRecordId });
    assert.equal(loadedId, "provider-resume-id");
    assert.equal(resumed.acpxRecordId, original.acpxRecordId);
    assert.equal(resumed.acpSessionId, original.acpSessionId);
    assert.equal(resumed.closed, false);
  });
});

test(
  "concurrent native resumes create independent local records",
  { timeout: 10_000 },
  async (t) => {
    await withTempHome("acpx-concurrent-resume-", async (home) => {
      t.mock.method(AcpClient.prototype, "start", async () => {});
      t.mock.method(AcpClient.prototype, "supportsLoadSession", () => true);
      let release!: () => void;
      const bothLoading = new Promise<void>((resolve) => {
        release = resolve;
      });
      let loading = 0;
      t.mock.method(AcpClient.prototype, "loadSessionWithOptions", async () => {
        loading += 1;
        if (loading === 2) {
          release();
        }
        await bothLoading;
        return {};
      });
      const options = {
        cwd: home,
        resumeSessionId: "shared-native-id",
        permissionMode: "deny-all" as const,
        handleProcessInterrupts: false,
      };
      const [first, second] = await Promise.all([
        createSession({ ...options, agentCommand: "agent-a", name: "first" }),
        createSession({ ...options, agentCommand: "agent-b", name: "second" }),
      ]);
      assert.notEqual(first.acpxRecordId, second.acpxRecordId);
      assert.equal(first.acpSessionId, "shared-native-id");
      assert.equal(second.acpSessionId, "shared-native-id");
      assert.equal((await readSessionRecord(first.acpxRecordId))?.name, "first");
      assert.equal((await readSessionRecord(second.acpxRecordId))?.name, "second");
    });
  },
);

test("flow runs retain separate histories when adapter session IDs repeat", async () => {
  await withTempHome("acpx-flow-session-collision-", async (home) => {
    const options = {
      resolveAgent: () => ({
        agentName: "synthetic",
        agentCommand: "reused-session-agent",
        agentArgv: [process.execPath, AGENT],
        cwd: home,
      }),
      permissionMode: "deny-all" as const,
      outputRoot: path.join(home, "runs"),
      defaultNodeTimeoutMs: 10_000,
    };
    let secondId: string | undefined;
    const result = await new FlowRunner(options).run(
      defineFlow({
        name: "flow-a",
        startAt: "first",
        nodes: {
          first: acp({ prompt: () => "from-A-first" }),
          other: action({
            run: async () => {
              const other = await new FlowRunner(options).run(
                defineFlow({
                  name: "flow-b",
                  startAt: "only",
                  nodes: { only: acp({ prompt: () => "from-B-only" }) },
                  edges: [],
                }),
                {},
              );
              secondId = Object.values(other.state.sessionBindings)[0].acpxRecordId;
              return "done";
            },
          }),
          last: acp({ prompt: () => "from-A-last" }),
        },
        edges: [
          { from: "first", to: "other" },
          { from: "other", to: "last" },
        ],
      }),
      {},
    );
    const firstId = Object.values(result.state.sessionBindings)[0].acpxRecordId;
    assert.ok(firstId);
    assert.ok(secondId);
    assert.notEqual(firstId, secondId);
    const first = await readSessionRecord(firstId);
    const second = await readSessionRecord(secondId);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.acpSessionId, second.acpSessionId);
    assert.match(JSON.stringify(first.messages), /from-A-first/);
    assert.match(JSON.stringify(first.messages), /from-A-last/);
    assert.doesNotMatch(JSON.stringify(first.messages), /from-B-only/);
    assert.match(JSON.stringify(second.messages), /from-B-only/);
    assert.doesNotMatch(JSON.stringify(second.messages), /from-A/);
  });
});

test("sessions new leaves the replacement open when the adapter repeats its ID", async () => {
  await withTempHome("acpx-cli-session-collision-", async (home) => {
    const create = () => {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("dist/cli.js"),
          "--cwd",
          home,
          "--agent",
          `${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT)}`,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        {
          cwd: home,
          env: { ...process.env, HOME: home, USERPROFILE: home },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return (JSON.parse(result.stdout) as { acpxRecordId: string }).acpxRecordId;
    };
    const prior = create();
    const current = create();
    assert.notEqual(current, prior);
    assert.equal((await readSessionRecord(prior))?.closed, true);
    assert.equal((await readSessionRecord(current))?.closed, false);
  });
});
