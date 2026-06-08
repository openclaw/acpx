import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "../src/cli/session/prompt-runner.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

test("runSessionSetModeDirect resumes a load-capable session and closes the client once", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-resume",
      acpSessionId: "prompt-runner-resume-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });
    await writeSessionRecord(homeDir, record);

    let clientAvailableCalls = 0;
    let clientClosedCalls = 0;
    let controllerOperations: Promise<unknown> | undefined;

    const result = await runSessionSetModeDirect({
      sessionRecordId: record.acpxRecordId,
      modeId: "review",
      timeoutMs: 5_000,
      onClientAvailable: (controller) => {
        clientAvailableCalls += 1;
        controllerOperations = Promise.all([
          controller.setSessionMode("preload"),
          controller.setSessionConfigOption("reasoning_effort", "high"),
        ]);
      },
      onClientClosed: () => {
        clientClosedCalls += 1;
      },
    });
    await controllerOperations;

    assert.equal(result.resumed, true);
    assert.equal(result.loadError, undefined);
    assert.equal(clientAvailableCalls, 1);
    assert.equal(clientClosedCalls, 1);
    assert.equal(result.record.closed, false);
    assert.equal(result.record.closedAt, undefined);
    assert.equal(result.record.acpSessionId, record.acpSessionId);
    assert.equal(result.record.protocolVersion, 1);

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpSessionId, record.acpSessionId);
    assert.equal(persisted.closed, false);
    assert.equal(persisted.protocolVersion, 1);
    assert.equal(typeof persisted.lastUsedAt, "string");
  });
});

test("runSessionSetConfigOptionDirect falls back to createSession and returns updated options", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-config",
      acpSessionId: "stale-session-id",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --load-session-fails-on-empty`,
      cwd,
      messages: [],
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetConfigOptionDirect({
      sessionRecordId: record.acpxRecordId,
      configId: "reasoning_effort",
      value: "high",
      timeoutMs: 5_000,
    });

    assert.equal(result.resumed, false);
    assert.match(result.loadError ?? "", /internal error/i);
    assert.notEqual(result.record.acpSessionId, "stale-session-id");
    assert.deepEqual(result.response.configOptions, [
      {
        id: "mode",
        name: "Session Mode",
        category: "mode",
        type: "select",
        currentValue: "auto",
        options: [
          {
            value: "read-only",
            name: "Read Only",
          },
          {
            value: "auto",
            name: "Default",
          },
          {
            value: "full-access",
            name: "Full Access",
          },
          {
            value: "plan",
            name: "Plan",
          },
          {
            value: "default",
            name: "Default",
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default-model",
        options: [
          {
            value: "default-model",
            name: "default-model",
          },
          {
            value: "fast-model",
            name: "fast-model",
          },
          {
            value: "smart-model",
            name: "smart-model",
          },
          {
            value: "gpt-5.4",
            name: "gpt-5.4",
          },
          {
            value: "gpt-5.2",
            name: "gpt-5.2",
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          {
            value: "low",
            name: "Low",
          },
          {
            value: "medium",
            name: "Medium",
          },
          {
            value: "high",
            name: "High",
          },
          {
            value: "xhigh",
            name: "Xhigh",
          },
        ],
      },
    ]);

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpSessionId, result.record.acpSessionId);
    assert.equal(persisted.protocolVersion, 1);
    assert.equal(persisted.closed, false);
    assert.deepEqual(persisted.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
  });
});

test("runSessionSetConfigOptionDirect promotes a custom model config preference", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-custom-model-config",
      acpSessionId: "prompt-runner-custom-model-config-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --advertise-models --model-config-id llm`,
      cwd,
      acpx: {
        desired_config_options: {
          llm: "stale-model",
          reasoning_effort: "high",
        },
      },
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetConfigOptionDirect({
      sessionRecordId: record.acpxRecordId,
      configId: "llm",
      value: "smart-model",
      timeoutMs: 5_000,
    });

    assert.equal(result.record.acpx?.current_model_id, "smart-model");
    assert.equal(result.record.acpx?.session_options?.model, "smart-model");
    assert.deepEqual(result.record.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
    assert.equal(
      result.record.acpx?.config_options?.find((option) => option.id === "llm")?.currentValue,
      "smart-model",
    );
  });
});

test("runSessionSetModelDirect updates current and desired model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-model",
      acpSessionId: "prompt-runner-model-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --advertise-models --model-config-id llm`,
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
      acpx: {
        desired_config_options: {
          llm: "stale-model",
          reasoning_effort: "high",
        },
      },
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetModelDirect({
      sessionRecordId: record.acpxRecordId,
      modelId: "gpt-5.4",
      timeoutMs: 5_000,
    });

    assert.equal(result.resumed, true);
    assert.equal(result.record.acpx?.current_model_id, "gpt-5.4");
    assert.equal(result.record.acpx?.session_options?.model, "gpt-5.4");
    assert.deepEqual(result.record.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
    assert.equal(
      result.record.acpx?.config_options?.find((option) => option.category === "model")
        ?.currentValue,
      "gpt-5.4",
    );

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpx?.current_model_id, "gpt-5.4");
    assert.equal(persisted.acpx?.session_options?.model, "gpt-5.4");
    assert.deepEqual(persisted.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
    assert.equal(
      persisted.acpx?.config_options?.find((option) => option.category === "model")?.currentValue,
      "gpt-5.4",
    );
  });
});

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-prompt-runner-home-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}
