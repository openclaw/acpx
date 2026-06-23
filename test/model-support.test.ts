import assert from "node:assert/strict";
import test from "node:test";
import { assertRequestedModelSupported } from "../src/acp/model-support.js";

test("Claude ACP model validation warns for unadvertised selectors", () => {
  const warning = assertRequestedModelSupported({
    requestedModel: "opus[1m]",
    models: {
      configId: "model",
      currentModelId: "sonnet",
      availableModels: [
        { modelId: "default", name: "Default" },
        { modelId: "sonnet", name: "Sonnet" },
      ],
    },
    agentCommand: "npx -y @agentclientprotocol/claude-agent-acp@^0.37.0",
    context: "apply",
  });

  assert.match(
    warning ?? "",
    /requested model "opus\[1m\]" was not in the Claude ACP advertised model list/,
  );
});

test("non-Claude model validation rejects unadvertised selectors", () => {
  assert.throws(
    () =>
      assertRequestedModelSupported({
        requestedModel: "missing-model",
        models: {
          configId: "model",
          currentModelId: "default",
          availableModels: [{ modelId: "default", name: "Default" }],
        },
        agentCommand: "mock-agent --advertise-models",
        context: "apply",
      }),
    /did not advertise that model/,
  );
});

test("Cursor model validation accepts a unique advertised suffix variant", () => {
  const warning = assertRequestedModelSupported({
    requestedModel: "composer-2.5",
    models: {
      configId: "model",
      currentModelId: "composer-2.5[fast=false]",
      availableModels: [{ modelId: "composer-2.5[fast=false]", name: "Composer 2.5" }],
    },
    agentCommand: "cursor-agent acp",
    context: "apply",
  });

  assert.match(warning ?? "", /advertised "composer-2\.5\[fast=false\]"/);
});

test("Cursor model validation keeps ambiguous suffix variants strict", () => {
  assert.throws(
    () =>
      assertRequestedModelSupported({
        requestedModel: "composer-2.5",
        models: {
          configId: "model",
          currentModelId: "composer-2.5[fast=false]",
          availableModels: [
            { modelId: "composer-2.5[fast=false]", name: "Composer 2.5" },
            { modelId: "composer-2.5[fast=true]", name: "Composer 2.5 Fast" },
          ],
        },
        agentCommand: "cursor-agent acp",
        context: "apply",
      }),
    /did not advertise that model/,
  );
});

test("Cursor model resolution preserves an exact advertised id", () => {
  const warning = assertRequestedModelSupported({
    requestedModel: "composer-2.5",
    models: {
      configId: "model",
      currentModelId: "composer-2.5",
      availableModels: [
        { modelId: "composer-2.5", name: "Composer 2.5" },
        { modelId: "composer-2.5[fast=false]", name: "Composer 2.5 Fast" },
      ],
    },
    agentCommand: "cursor-agent acp",
    context: "apply",
  });

  assert.equal(warning, undefined);
});
