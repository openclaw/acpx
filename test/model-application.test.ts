import assert from "node:assert/strict";
import { test } from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src/acp/client.js";
import type { SessionModelState } from "../src/acp/model-support.js";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

function buildDevinModels(currentModelId: string): SessionModelState {
  return {
    configId: "model",
    currentModelId,
    availableModels: [
      { modelId: "swe-2-high", name: "SWE-2 High" },
      { modelId: "swe-2-max", name: "SWE-2 Max" },
    ],
  };
}

function stubClient(startupModel: string | undefined): {
  client: AcpClient;
  setSessionModelCalls: string[];
} {
  const setSessionModelCalls: string[] = [];
  const client = {
    getStartupModel: () => startupModel,
    setSessionModel: async (
      _sessionId: string,
      modelId: string,
    ): Promise<SetSessionConfigOptionResponse> => {
      setSessionModelCalls.push(modelId);
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
  const { client, setSessionModelCalls } = stubClient("swe-2-high");

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "swe-2-max",
    models: buildDevinModels("swe-2-high"),
    agentCommand: "devin acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, ["swe-2-max"]);
});

test("applyRequestedModelIfAdvertised skips the ACP update when the launch flag applied the model", async () => {
  const { client, setSessionModelCalls } = stubClient("swe-2-high");

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "swe-2-high",
    models: buildDevinModels("swe-2-high"),
    agentCommand: "devin acp",
  });

  assert.equal(result.applied, true);
  assert.deepEqual(setSessionModelCalls, []);
});

test("applyRequestedModelIfAdvertised warns when a running client cannot apply the model", async () => {
  const { client, setSessionModelCalls } = stubClient("swe-2-high");
  const warnings: string[] = [];

  const result = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "session-1",
    requestedModel: "swe-2-max",
    models: undefined,
    agentCommand: "devin acp",
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(result.applied, false);
  assert.deepEqual(setSessionModelCalls, []);
  assert.match(warnings[0] ?? "", /not applied to this running session/);
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
