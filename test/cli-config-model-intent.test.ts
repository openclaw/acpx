import assert from "node:assert/strict";
import test from "node:test";
import { modelStateFromConfigOptions } from "../src/acp/model-config-state.js";
import {
  assertRequestedModelSupported,
  normalizeCliConfigOptionValue,
  resolveRequestedConfigOption,
} from "../src/acp/model-support.js";
import { parseNonBlankOpaqueValue, parseNonEmptyValue } from "../src/cli/flags.js";
import { parseQueueRequest } from "../src/session/queue/messages.js";

function catalog(configId: string, ids = ["model-a", "model-b"]) {
  const models = modelStateFromConfigOptions([
    {
      id: configId,
      name: "Synthetic model selector",
      type: "select",
      category: "model",
      currentValue: ids[0],
      options: ids.map((value) => ({ value, name: value })),
    },
  ]);
  assert.ok(models, "synthetic source catalog must be valid");
  return models;
}

test("acpx candidate: CLI non-model literal survives argument admission", () => {
  assert.equal(parseNonBlankOpaqueValue("Config option value", " compact "), " compact ");
  assert.throws(() => parseNonBlankOpaqueValue("Config option value", "  "), /must not be empty/);
  assert.equal(parseNonEmptyValue("Model", " model-a "), "model-a");
});

test("acpx candidate: non-model exact values survive CLI routing", () => {
  const models = catalog("engine");
  const value = normalizeCliConfigOptionValue({
    configId: "verbosity",
    value: " compact ",
    models,
    cliModelInput: true,
  });
  assert.equal(value, " compact ");
  assert.equal(
    resolveRequestedConfigOption({
      configId: "verbosity",
      value,
      models,
    }).resolvedValue,
    " compact ",
  );
});

test("acpx candidate: nonliteral model category normalizes CLI model input", () => {
  const models = catalog("engine");
  const value = normalizeCliConfigOptionValue({
    configId: "engine",
    value: " model-b ",
    models,
    cliModelInput: true,
  });
  assert.equal(value, "model-b");
  const selected = resolveRequestedConfigOption({ configId: "engine", value, models });
  assert.equal(selected.resolvedValue, "model-b");
  assert.equal(
    assertRequestedModelSupported({
      requestedModel: selected.resolvedValue,
      models,
      context: "apply",
      agentCommand: "node public-synthetic-agent",
    }),
    undefined,
  );
});

test("acpx candidate: embedded model value remains untrimmed", () => {
  const models = catalog("engine");
  const raw = " model-b ";
  const value = normalizeCliConfigOptionValue({ configId: "engine", value: raw, models });
  assert.equal(value, raw);
  const selected = resolveRequestedConfigOption({ configId: "engine", value, models });
  assert.equal(selected.resolvedValue, raw);
  assert.throws(
    () =>
      assertRequestedModelSupported({
        requestedModel: raw,
        models,
        context: "apply",
        agentCommand: "node public-synthetic-agent",
      }),
    /did not advertise/,
  );
});

test("acpx candidate: fresh catalog controls which model ID gets normalized", () => {
  const before = catalog("engine", ["model-a"]);
  const after = catalog("llm", ["model-b"]);
  assert.equal(
    normalizeCliConfigOptionValue({
      configId: "engine",
      value: " model-b ",
      models: after,
      cliModelInput: true,
    }),
    " model-b ",
  );
  assert.equal(
    normalizeCliConfigOptionValue({
      configId: "llm",
      value: " model-b ",
      models: after,
      cliModelInput: true,
    }),
    "model-b",
  );
  assert.equal(
    normalizeCliConfigOptionValue({
      configId: "engine",
      value: " model-a ",
      models: before,
      cliModelInput: true,
    }),
    "model-a",
  );
});

test("acpx R030: dedicated queue control kind preserves raw model input", () => {
  const request = parseQueueRequest({
    type: "set_cli_config_option",
    requestId: "public-new-control",
    ownerGeneration: 1,
    configId: "engine",
    value: " model-b ",
  });
  assert.ok(request && request.type === "set_cli_config_option");
  assert.equal(request.value, " model-b ");
  assert.equal(
    normalizeCliConfigOptionValue({
      configId: request.configId,
      value: request.value,
      models: catalog("engine"),
      cliModelInput: true,
    }),
    "model-b",
  );
});

test("acpx R030: legacy queue control remains exact and has no CLI intent", () => {
  const request = parseQueueRequest({
    type: "set_config_option",
    requestId: "public-legacy-control",
    ownerGeneration: 1,
    configId: "engine",
    value: " model-b ",
  });
  assert.ok(request && request.type === "set_config_option");
  assert.equal(request.value, " model-b ");
  assert.equal(
    normalizeCliConfigOptionValue({
      configId: request.configId,
      value: request.value,
      models: catalog("engine"),
    }),
    " model-b ",
  );
});

test("acpx R030: no inline intent flags or blank values can bypass queue validation", () => {
  const legacy = {
    type: "set_config_option",
    requestId: "public-legacy",
    ownerGeneration: 1,
    configId: "verbosity",
    value: " compact ",
  };
  assert.equal(parseQueueRequest({ ...legacy, cliModelInput: true }), null);
  assert.equal(parseQueueRequest({ ...legacy, cliModelInput: false }), null);
  assert.equal(parseQueueRequest({ ...legacy, cliModelInput: "true" }), null);
  assert.equal(
    parseQueueRequest({ ...legacy, type: "set_cli_config_option", cliModelInput: true }),
    null,
  );
  assert.equal(parseQueueRequest({ ...legacy, type: "set_cli_config_option", value: "   " }), null);
});

test("acpx R030: unrecognized owner request kind is rejected rather than downgraded", () => {
  const base = {
    requestId: "public-unknown-owner",
    ownerGeneration: 1,
    configId: "engine",
    value: " model-b ",
  };
  assert.equal(parseQueueRequest({ ...base, type: "set_cli_config_option_v2" }), null);
  const newControl = parseQueueRequest({ ...base, type: "set_cli_config_option" });
  assert.ok(newControl && newControl.type === "set_cli_config_option");
  const legacy = parseQueueRequest({ ...base, type: "set_config_option" });
  assert.ok(legacy && legacy.type === "set_config_option");
});
