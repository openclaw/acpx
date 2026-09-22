import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { assertPersistedKeyPolicy } from "../src/persisted-key-policy.js";
import {
  applyConfigOptionSelection,
  applyConfigOptionsToState,
  applyModelSelection,
} from "../src/session/config-options.js";
import {
  clearDesiredConfigOption,
  getDesiredConfigOptions,
} from "../src/session/mode-preference.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionAcpxState } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const sdk = (await import(
  new URL("./schema/zod.gen.js", import.meta.resolve("@agentclientprotocol/sdk")).href
)) as {
  zSessionConfigId: { parse(value: unknown): string };
  zSessionConfigValueId: { parse(value: unknown): string };
};

function select(id: string, currentValue: string, category?: string): SessionConfigOption {
  return {
    id,
    name: "Synthetic config control",
    type: "select",
    currentValue,
    ...(category === undefined ? {} : { category }),
    options: [{ value: currentValue, name: "Accepted choice" }],
  };
}

function roundTrip(state: SessionAcpxState): SessionAcpxState {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "opaque-config-record",
      acpSessionId: "opaque-config-session",
      agentCommand: "unused-synthetic-agent",
      cwd: "/tmp/acpx-opaque-config",
      acpx: state,
    }),
  );
  assertPersistedKeyPolicy(serialized);
  const parsed = parseSessionRecord(JSON.parse(JSON.stringify(serialized)));
  assert.ok(parsed?.acpx);
  return parsed.acpx;
}

for (const configId of ["ordinary", "__proto__", " custom ", "mode"]) {
  test(`accepted config ID ${JSON.stringify(configId)} survives the persisted replay boundary`, () => {
    const accepted = " accepted\t ";
    assert.equal(sdk.zSessionConfigId.parse(configId), configId);
    assert.equal(sdk.zSessionConfigValueId.parse(accepted), accepted);
    const original: SessionAcpxState = { desired_mode_id: "legacy-plan" };
    const next = applyConfigOptionSelection(original, configId, "requested", {
      configOptions: [select(configId, accepted), select("unselected", "default")],
    });
    const expected = { [configId]: accepted };
    assert.deepEqual(next.desired_config_options, expected);
    assert.ok(next.desired_config_options && Object.hasOwn(next.desired_config_options, configId));
    const restored = roundTrip(next);
    assert.deepEqual(restored.desired_config_options, expected);
    assert.deepEqual(getDesiredConfigOptions(restored), expected);
    assert.equal(restored.desired_mode_id, "legacy-plan");
    assert.deepEqual(original, { desired_mode_id: "legacy-plan" });
    clearDesiredConfigOption(restored, configId);
    assert.equal(Object.hasOwn(restored, "desired_config_options"), false);
    assert.equal(restored.desired_mode_id, "legacy-plan");
  });
}

test("config preference extraction preserves colliding spellings and empty string values", () => {
  // Empty IDs are helper/persistence contract controls, not new CLI admission claims.
  const entries: Array<[string, string]> = [
    ["custom", "canonical"],
    [" custom ", "padded"],
    ["__proto__", "own value"],
    ["", ""],
    [" \t ", " \tvalue\n "],
  ];
  for (const [key, value] of entries) {
    assert.equal(sdk.zSessionConfigId.parse(key), key);
    assert.equal(sdk.zSessionConfigValueId.parse(value), value);
  }
  const expected = Object.fromEntries(entries);
  const restored = roundTrip({ desired_config_options: expected });
  const desired = getDesiredConfigOptions(restored);
  assert.deepEqual(desired, expected);
  assert.equal(Object.hasOwn(desired, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(desired), Object.prototype);
  assert.deepEqual(getDesiredConfigOptions(undefined), {});
});

test("clearing a config preference removes only the literal requested key", () => {
  const entries: Array<[string, string]> = [
    ["custom", "canonical"],
    [" custom ", "padded"],
    ["__proto__", "own value"],
    ["", ""],
    [" \t ", "space-key"],
  ];
  for (const [key] of entries) {
    const original = Object.fromEntries(entries);
    const state: SessionAcpxState = { desired_config_options: original };
    clearDesiredConfigOption(state, key);
    assert.deepEqual(
      state.desired_config_options,
      Object.fromEntries(entries.filter(([id]) => id !== key)),
    );
    assert.deepEqual(
      original,
      Object.fromEntries(entries),
      "clear must not mutate a shared prior map",
    );
  }
  const state: SessionAcpxState = { desired_config_options: { "": "" } };
  clearDesiredConfigOption(state, undefined);
  assert.deepEqual(state.desired_config_options, { "": "" });
  clearDesiredConfigOption(state, "");
  assert.equal(Object.hasOwn(state, "desired_config_options"), false);
});

test("opaque selections retain accepted siblings and retire missing controls without pinning defaults", () => {
  const selected = applyConfigOptionSelection(
    { desired_config_options: { retired: "old" } },
    "__proto__",
    "requested",
    {
      configOptions: [
        select("__proto__", "first"),
        select("retired", "old"),
        select("default", "default"),
      ],
    },
  );
  const before = structuredClone(selected);
  const adjusted = applyConfigOptionSelection(selected, "trigger", "requested", {
    configOptions: [
      select("__proto__", ""),
      select("trigger", "accepted"),
      select("default", "default"),
    ],
  });
  assert.deepEqual(adjusted.desired_config_options, { ["__proto__"]: "", trigger: "accepted" });
  assert.deepEqual(selected, before);
  const snapshot = applyConfigOptionsToState(adjusted, [select("__proto__", "default")]);
  assert.deepEqual(snapshot.desired_config_options, adjusted.desired_config_options);
  const removed = applyConfigOptionSelection(adjusted, "trigger", "requested", {
    configOptions: [],
  });
  assert.equal(Object.hasOwn(removed, "desired_config_options"), false);
});

test("model selection clears its exact padded config ID while preserving its distinct sibling", () => {
  const modelKey = " llm ";
  const state: SessionAcpxState = {
    desired_mode_id: "legacy-plan",
    desired_config_options: { [modelKey]: "model-one", llm: "sibling" },
    config_options: [select(modelKey, "model-one", "model"), select("llm", "sibling")],
  };
  const next = applyModelSelection(state, "model-two", {
    configOptions: [select(modelKey, "model-two", "model"), select("llm", "sibling")],
  });
  assert.deepEqual(next.desired_config_options, { llm: "sibling" });
  assert.equal(next.session_options?.model, "model-two");
  assert.equal(next.desired_mode_id, "legacy-plan");
  assert.deepEqual(state.desired_config_options, { [modelKey]: "model-one", llm: "sibling" });
});
