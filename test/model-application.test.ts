import assert from "node:assert/strict";
import { test } from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src/acp/client.js";
import type { SessionModelState } from "../src/acp/model-support.js";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

function buildFxModels(currentModelId: string): SessionModelState {
  return {
    configId: "model",
    currentModelId,
    availableModels: [
      { modelId: "grok-4.5", name: "Grok 4.5" },
      { modelId: "grok-4.6", name: "Grok 4.6" },
    ],
  };
}

function stubClient(startupModel: string | undefined): {
  client: AcpClient;
  setSessionModelCalls: string[];
} {
  let appliedModel = startupModel;
  const setSessionModelCalls: string[] = [];
  const client = {
    getAppliedModel: () => appliedModel,
    setSessionModel: async (
      _sessionId: string,
      modelId: string,
    ): Promise<SetSessionConfigOptionResponse> => {
      setSessionModelCalls.push(modelId);
      appliedModel = modelId;
      return {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: modelId,
            options: [],
          },
        ],
      };
    },
  } as unknown as AcpClient;
  return { client, setSessionModelCalls };
}

test("applyRequestedModelIfAdvertised routes a changed model through ACP on a reused client", async () => {
  const { client, setSessionModelCalls } = stubClient("grok-4.6");

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "grok-4.5",
    models: buildFxModels("grok-4.6"),
    agentCommand: "fx acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, ["grok-4.5"]);
});

test("applyRequestedModelIfAdvertised reapplies the startup model after an in-session change", async () => {
  const { client, setSessionModelCalls } = stubClient("grok-4.6");

  await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "grok-4.5",
    models: buildFxModels("grok-4.6"),
    agentCommand: "fx acp",
  });
  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "grok-4.6",
    models: buildFxModels("grok-4.5"),
    agentCommand: "fx acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, ["grok-4.5", "grok-4.6"]);
});

test("applyRequestedModelIfAdvertised skips the ACP update when the launch flag applied the model", async () => {
  const { client, setSessionModelCalls } = stubClient("grok-4.6");

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "grok-4.6",
    models: buildFxModels("grok-4.6"),
    agentCommand: "fx acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, []);
});

test("applyRequestedModelIfAdvertised warns when a running client cannot apply the model", async () => {
  const { client, setSessionModelCalls } = stubClient("grok-4.6");
  const warnings: string[] = [];

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "grok-4.5",
    models: undefined,
    agentCommand: "fx acp",
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(result.applied, false);
  assert.deepEqual(setSessionModelCalls, []);
  assert.match(warnings[0] ?? "", /not applied to this running session/);
});

test("applyRequestedModelIfAdvertised covers devin launches through the same startup-flag path", async () => {
  const { client, setSessionModelCalls } = stubClient("swe-2-high");

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "swe-2-high",
    models: {
      configId: "model",
      currentModelId: "swe-2-high",
      availableModels: [{ modelId: "swe-2-high", name: "SWE-2 High" }],
    },
    agentCommand: "devin acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, []);
});

test("applyRequestedModelIfAdvertised keeps ACP model controls for non-startup agents", async () => {
  const { client, setSessionModelCalls } = stubClient(undefined);

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "gpt-5.4",
    models: {
      configId: "model",
      currentModelId: "default-model",
      availableModels: [
        { modelId: "default-model", name: "default-model" },
        { modelId: "gpt-5.4", name: "gpt-5.4" },
      ],
    },
    agentCommand: "agent acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, ["gpt-5.4"]);
});
