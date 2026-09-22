import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SessionConfigOption, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.js";
import { connectAndLoadSession } from "../src/runtime/engine/reconnect.js";
import { applyConfigOptionSelection } from "../src/session/config-options.js";
import { createOwnedSessionControls } from "../src/session/execution/owned-controls.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

function selectOption(id: string, currentValue: string, category?: string): SessionConfigOption {
  return {
    id,
    name: id,
    type: "select",
    ...(category === undefined ? {} : { category }),
    currentValue,
    options: ["auto", "plan", "review", "high", "normal"].map((value) => ({
      value,
      name: value,
    })),
  };
}

function configResponse(configId: string, value: string): SetSessionConfigOptionResponse {
  return {
    configOptions: [selectOption(configId, value), selectOption("verbosity", "normal")],
  };
}

type Connection = "fresh" | "load";
type ControlCall = { method: string; sessionId: string; key: string; value: string };

function fixture(t: TestContext, connection: Connection, configId = "mode") {
  const record = makeSessionRecord({
    acpxRecordId: "config-mode-record",
    acpSessionId: "previous-session",
    agentSessionId: "previous-native",
    agentCommand: "unused-config-mode-agent",
    cwd: process.cwd(),
  });
  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    permissionMode: "deny-all",
  });
  const calls: ControlCall[] = [];
  let failure: Error | undefined;
  let acceptsLegacyMode = false;
  let checkpoints = 0;
  const initialState = {
    ...configResponse(configId, "auto"),
    configOptionsPresent: true,
    legacyModelMetadataPresent: false,
  };
  t.mock.method(client, "hasReusableSession", () => false);
  t.mock.method(client, "start", async () => {});
  t.mock.method(client, "getAgentLifecycleSnapshot", () => ({ running: false }));
  t.mock.method(client, "supportsResumeSession", () => false);
  t.mock.method(client, "supportsLoadSession", () => true);
  t.mock.method(client, "loadSessionWithOptions", async () => {
    if (connection === "fresh") {
      throw { code: -32002, message: "Resource not found" };
    }
    return { ...initialState, agentSessionId: "previous-native" };
  });
  t.mock.method(client, "createSession", async () => {
    assert.equal(connection, "fresh", "successful load must not create a session");
    return { ...initialState, sessionId: "fresh-session", agentSessionId: "fresh-native" };
  });
  t.mock.method(client, "setSessionMode", async (sessionId: string, value: string) => {
    calls.push({ method: "session/set_mode", sessionId, key: "mode", value });
    if (!acceptsLegacyMode) {
      throw new Error("config-only adapter does not support session/set_mode");
    }
  });
  t.mock.method(client, "setSessionModel", async () => {
    assert.fail("config-only fixture does not advertise model control");
  });
  t.mock.method(
    client,
    "setSessionConfigOption",
    async (sessionId: string, key: string, value: string) => {
      calls.push({ method: "session/set_config_option", sessionId, key, value });
      if (failure) {
        throw failure;
      }
      return configResponse(key, "review");
    },
  );
  const controls = createOwnedSessionControls({
    client,
    record,
    sessionId: () => record.acpSessionId,
    checkpoint: async () => {
      checkpoints++;
    },
    retire: async () => {
      assert.fail("ordinary acknowledged/rejected control must not retire the client");
    },
  });
  return {
    record,
    calls,
    controls,
    get checkpoints() {
      return checkpoints;
    },
    rejectConfig(error: Error) {
      failure = error;
    },
    acceptLegacyMode() {
      acceptsLegacyMode = true;
    },
    async select() {
      // Exercise the real accepted-control reducer/checkpoint path; do not seed
      // desired_config_options directly and thereby miss the transport-loss bug.
      const response = await controls.setSessionConfigOption(configId, "plan");
      assert.deepEqual(response, configResponse(configId, "review"));
      assert.deepEqual(calls, [
        {
          method: "session/set_config_option",
          sessionId: "previous-session",
          key: configId,
          value: "plan",
        },
      ]);
      assert.equal(checkpoints, 1);
      calls.length = 0;
    },
    reconnect() {
      return connectAndLoadSession({
        client,
        record,
        activeController: {
          ...controls,
          hasActivePrompt: () => false,
          requestCancelActivePrompt: async () => false,
        },
      });
    },
  };
}

for (const connection of ["fresh", "load"] as const) {
  for (const configId of ["mode", "agent_mode", "__proto__", " custom "] as const) {
    test(`accepted config ${configId} keeps its transport after ${connection}`, async (t) => {
      const f = fixture(t, connection, configId);
      await f.select();
      const result = await f.reconnect();
      const sessionId = connection === "fresh" ? "fresh-session" : "previous-session";
      assert.equal(result.sessionId, sessionId);
      assert.equal(result.resumed, connection === "load");
      assert.deepEqual(f.calls, [
        { method: "session/set_config_option", sessionId, key: configId, value: "review" },
      ]);
      assert.deepEqual(f.record.acpx?.desired_config_options, { [configId]: "review" });
      assert.equal(f.record.acpx?.desired_mode_id, undefined);
      assert.equal(f.record.acpx?.desired_config_options?.verbosity, undefined);
    });
  }

  test(`rejected config mode replay restores saved state after ${connection}`, async (t) => {
    const f = fixture(t, connection);
    await f.select();
    const before = structuredClone(f.record.acpx);
    f.rejectConfig(new Error("config mode restore rejected"));
    await assert.rejects(f.reconnect(), {
      name: "SessionConfigOptionReplayError",
      message: /Failed to replay saved session config option mode/,
    });
    assert.deepEqual(f.calls, [
      {
        method: "session/set_config_option",
        sessionId: connection === "fresh" ? "fresh-session" : "previous-session",
        key: "mode",
        value: "review",
      },
    ]);
    assert.equal(f.record.acpSessionId, "previous-session");
    assert.equal(f.record.agentSessionId, "previous-native");
    assert.deepEqual(JSON.parse(JSON.stringify(f.record.acpx)), JSON.parse(JSON.stringify(before)));
  });

  test(`historical legacy mode is not inferred to be generic after ${connection}`, async (t) => {
    const f = fixture(t, connection);
    f.acceptLegacyMode();
    await f.controls.setSessionMode("legacy-plan");
    f.calls.length = 0;
    await f.reconnect();
    assert.deepEqual(
      f.calls,
      connection === "fresh"
        ? [
            {
              method: "session/set_mode",
              sessionId: "fresh-session",
              key: "mode",
              value: "legacy-plan",
            },
          ]
        : [],
    );
    assert.equal(f.record.acpx?.desired_mode_id, "legacy-plan");
    assert.equal(f.record.acpx?.desired_config_options, undefined);
  });
}

for (const change of ["adjusted", "removed"] as const) {
  test(`accepted sibling response reconciles config mode when ${change}`, () => {
    const selected = applyConfigOptionSelection(undefined, "mode", "plan", {
      configOptions: [selectOption("mode", "plan", "mode"), selectOption("verbosity", "normal")],
    });
    const before = structuredClone(selected);
    const next = applyConfigOptionSelection(selected, "effort", "high", {
      configOptions: [
        ...(change === "adjusted" ? [selectOption("mode", "review", "mode")] : []),
        selectOption("effort", "high"),
        selectOption("verbosity", "normal"),
      ],
    });
    assert.deepEqual(next.desired_config_options, {
      ...(change === "adjusted" ? { mode: "review" } : {}),
      effort: "high",
    });
    assert.equal(next.desired_mode_id, undefined);
    assert.deepEqual(
      selected,
      before,
      "accepted-state reduction must not mutate the caller snapshot",
    );
  });
}

test("independently selected legacy and generic modes remain separate", async (t) => {
  const f = fixture(t, "fresh");
  f.acceptLegacyMode();
  await f.controls.setSessionMode("legacy-plan");
  await f.controls.setSessionConfigOption("mode", "plan");
  assert.equal(f.record.acpx?.desired_mode_id, "legacy-plan");
  assert.deepEqual(f.record.acpx?.desired_config_options, { mode: "review" });
  await f.controls.setSessionMode("legacy-auto");
  assert.equal(f.record.acpx?.desired_mode_id, "legacy-auto");
  assert.deepEqual(f.record.acpx?.desired_config_options, { mode: "review" });
});

test("a model-category config named mode retains model selection semantics", () => {
  const response = { configOptions: [selectOption("mode", "review", "model")] };
  const next = applyConfigOptionSelection(
    { desired_mode_id: "legacy-plan" },
    "mode",
    "review",
    response,
  );
  assert.equal(next.session_options?.model, "review");
  assert.equal(next.current_model_id, "review");
  assert.equal(next.model_control, "config_option");
  assert.equal(next.desired_mode_id, "legacy-plan");
  assert.equal(next.desired_config_options, undefined);
});

test("a rejected subsequent config mode selection preserves the last acknowledgement", async (t) => {
  const f = fixture(t, "load");
  await f.select();
  const before = structuredClone(f.record.acpx);
  const failure = new Error("mode selection rejected");
  f.rejectConfig(failure);
  await assert.rejects(
    f.controls.setSessionConfigOption("mode", "auto"),
    (error) => error === failure,
  );
  assert.deepEqual(f.record.acpx, before);
  assert.equal(f.checkpoints, 1, "a rejected selection must not checkpoint a new preference");
});
