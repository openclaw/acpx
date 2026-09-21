import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { modelStateFromConfigOptions, type SessionModelState } from "../src/acp/model-support.js";
import { assertControlAuthority, type AcpControlAuthority } from "../src/async-control.js";
import {
  connectAndLoadSession,
  type ConnectAndLoadSessionOptions,
  type ConnectedSessionController,
} from "../src/runtime/engine/reconnect.js";
import { cloneSessionAcpxState, recordSessionUpdate } from "../src/session/conversation-model.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

function modelOption(id: string, model: string): SessionConfigOption {
  return {
    id,
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [{ value: model, name: `Name of ${model}` }],
  };
}

const effortOption: SessionConfigOption = {
  id: "effort",
  name: "Effort",
  type: "select",
  currentValue: "low",
  options: [{ value: "low", name: "Low" }],
};

const controller: ConnectedSessionController = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => undefined,
  setSessionConfigOption: async () => ({ configOptions: [] }),
};

function fixture(options: {
  initialOptions?: SessionConfigOption[];
  legacyModels?: SessionModelState;
  nextOptions: SessionConfigOption[];
  desiredModel?: string;
  replacingConfigOption?: ConnectAndLoadSessionOptions["replacingConfigOption"];
  replacingMode?: true;
  revokeAfterMode?: Error;
  modeError?: Error;
}) {
  const record = makeSessionRecord({
    acpxRecordId: "mode-metadata",
    acpSessionId: "original-session",
    agentSessionId: "original-native",
    agentCommand: "synthetic-agent",
    cwd: process.cwd(),
    acpx: {
      desired_mode_id: "plan",
      ...(options.desiredModel ? { session_options: { model: options.desiredModel } } : {}),
    },
  });
  const before = cloneSessionAcpxState(record.acpx);
  const calls: Array<{ method: string; value: string; models?: SessionModelState }> = [];
  let revoked = false;
  const client = {
    hasReusableSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: false }),
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    createSession: async () => ({
      sessionId: "fresh-session",
      agentSessionId: "fresh-native",
      configOptions: options.initialOptions,
      configOptionsPresent: options.initialOptions !== undefined,
      models: options.legacyModels ?? modelStateFromConfigOptions(options.initialOptions),
      legacyModelMetadataPresent: options.legacyModels !== undefined,
    }),
    setSessionMode: async (sessionId: string, mode: string) => {
      assert.equal(sessionId, "fresh-session");
      calls.push({ method: "mode", value: mode });
      record.acpx = recordSessionUpdate(record, record.acpx, {
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: options.nextOptions },
      });
      if (options.modeError) {
        throw options.modeError;
      }
      revoked = true;
    },
    setSessionModel: async (
      sessionId: string,
      model: string,
      models: SessionModelState | undefined,
      authority?: AcpControlAuthority,
    ) => {
      assertControlAuthority(authority);
      assert.equal(sessionId, "fresh-session");
      calls.push({ method: "model", value: model, models });
      return { configOptions: options.nextOptions };
    },
    setSessionConfigOption: async () => assert.fail("No generic selection was saved"),
  };
  return {
    record,
    before,
    calls,
    run: () =>
      connectAndLoadSession({
        record,
        client: client as never,
        activeController: controller,
        replacingConfigOption: options.replacingConfigOption,
        replacingMode: options.replacingMode,
        authority: {
          assertActive() {
            if (revoked && options.revokeAfterMode) {
              throw options.revokeAfterMode;
            }
          },
        },
      }),
  };
}

test("saved mode replay validates the model against the newly received catalog", async () => {
  const context = fixture({
    initialOptions: [modelOption("llm", "normal-model")],
    nextOptions: [modelOption("planner_llm", "planner-model")],
    desiredModel: "planner-model",
  });
  await context.run();
  assert.deepEqual(context.calls, [
    { method: "mode", value: "plan" },
    {
      method: "model",
      value: "planner-model",
      models: modelStateFromConfigOptions([modelOption("planner_llm", "planner-model")]),
    },
  ]);
  assert.equal(context.record.acpx?.current_model_id, "planner-model");
  assert.equal(context.record.acpx?.session_options?.model, "planner-model");
});

test("saved model replay routes through the control ID received during mode replay", async () => {
  const context = fixture({
    initialOptions: [modelOption("llm", "shared-model")],
    nextOptions: [modelOption("planner_llm", "shared-model")],
    desiredModel: "shared-model",
  });
  await context.run();
  assert.equal(context.calls[1]?.models?.configId, "planner_llm");
  assert.equal(context.record.acpx?.config_options?.[0]?.id, "planner_llm");
});

test("a newly advertised model control can replace a stale saved selection", async () => {
  const context = fixture({
    initialOptions: [modelOption("llm", "retired-model")],
    nextOptions: [modelOption("planner_llm", "planner-model")],
    desiredModel: "retired-model",
    replacingConfigOption: { key: "planner_llm" },
  });
  await context.run();
  assert.deepEqual(context.calls, [{ method: "mode", value: "plan" }]);
  assert.equal(context.record.acpx?.session_options?.model, "retired-model");
  assert.equal(context.record.acpx?.current_model_id, "planner-model");
});

for (const initialOptions of [[modelOption("llm", "normal-model")], undefined]) {
  test(`mode-only replay preserves ${initialOptions ? "changed" : "introduced"} model metadata`, async () => {
    const nextOptions = [modelOption("planner_llm", "planner-model")];
    const context = fixture({ initialOptions, nextOptions });
    await context.run();
    assert.deepEqual(context.calls, [{ method: "mode", value: "plan" }]);
    assert.deepEqual(context.record.acpx?.config_options, nextOptions);
    assert.equal(context.record.acpx?.current_model_id, "planner-model");
    assert.deepEqual(context.record.acpx?.available_models, ["planner-model"]);
    assert.deepEqual(context.record.acpx?.available_model_names, {
      "planner-model": "Name of planner-model",
    });
    assert.equal(context.record.acpx?.model_control, "config_option");
    assert.equal(context.record.acpx?.session_options, undefined);
  });
}

for (const nextOptions of [[], [effortOption]]) {
  test(`mode-only replay retains explicit model removal with ${nextOptions.length} remaining options`, async () => {
    const context = fixture({
      initialOptions: [modelOption("llm", "normal-model")],
      nextOptions,
    });
    await context.run();
    assert.deepEqual(context.record.acpx?.config_options, nextOptions);
    for (const field of [
      "current_model_id",
      "available_models",
      "available_model_names",
      "model_control",
    ]) {
      assert.equal(Object.hasOwn(context.record.acpx ?? {}, field), false, field);
    }
  });
}

test("model removal during mode replay rejects a saved model before dispatch", async () => {
  const context = fixture({
    initialOptions: [modelOption("llm", "normal-model")],
    nextOptions: [],
    desiredModel: "normal-model",
  });
  await assert.rejects(context.run(), { name: "SessionModelReplayError" });
  assert.deepEqual(context.calls, [{ method: "mode", value: "plan" }]);
  assert.deepEqual(context.record.acpx, context.before);
  assert.equal(context.record.acpSessionId, "original-session");
});

test("mode-introduced config options preserve independent legacy model support", async () => {
  const legacyModels: SessionModelState = {
    currentModelId: "legacy-model",
    availableModels: [{ modelId: "legacy-model", name: "Legacy model" }],
  };
  const context = fixture({ legacyModels, nextOptions: [effortOption] });
  await context.run();
  assert.deepEqual(context.record.acpx?.config_options, [effortOption]);
  assert.equal(context.record.acpx?.current_model_id, "legacy-model");
  assert.deepEqual(context.record.acpx?.available_models, ["legacy-model"]);
  assert.equal(context.record.acpx?.model_control, "legacy_set_model");
});

test("acknowledged mode metadata survives later revoked model admission", async () => {
  const revoked = new Error("authority revoked after accepted mode");
  const context = fixture({
    initialOptions: [modelOption("llm", "normal-model")],
    nextOptions: [modelOption("planner_llm", "planner-model")],
    desiredModel: "planner-model",
    revokeAfterMode: revoked,
  });
  await assert.rejects(context.run(), (error: unknown) => error === revoked);
  assert.deepEqual(context.calls, [{ method: "mode", value: "plan" }]);
  assert.equal(context.record.acpx?.current_model_id, "planner-model");
  assert.equal(context.record.acpSessionId, "fresh-session");
});

test("a rejected mode replay restores original metadata after a notification", async () => {
  const context = fixture({
    initialOptions: [modelOption("llm", "normal-model")],
    nextOptions: [modelOption("planner_llm", "planner-model")],
    modeError: new Error("mode rejected"),
  });
  await assert.rejects(context.run(), { name: "SessionModeReplayError" });
  assert.deepEqual(context.record.acpx, context.before);
  assert.equal(context.record.acpSessionId, "original-session");
  assert.equal(context.record.agentSessionId, "original-native");
});

test("explicit mode replacement keeps the fresh advertisement without saved-mode replay", async () => {
  const initialOptions = [modelOption("llm", "normal-model")];
  const context = fixture({
    initialOptions,
    nextOptions: [modelOption("planner_llm", "planner-model")],
    replacingMode: true,
  });
  await context.run();
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.record.acpx?.config_options, initialOptions);
  assert.equal(context.record.acpx?.current_model_id, "normal-model");
  assert.equal(context.record.acpx?.desired_mode_id, "plan");
});
