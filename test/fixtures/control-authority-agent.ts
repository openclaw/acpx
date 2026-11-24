import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const [directory, route] = process.argv.slice(2);
if (!directory || !route) {
  throw new Error("Expected barrier directory and model route");
}
let model = "default-model";
let mode = "auto";
let effort = "low";
let controlCount = 0;

function modelIds(): string[] {
  return existsSync(path.join(directory, "parameterized-models"))
    ? [
        "default-model",
        "selected[fast=true]",
        "provider/selected[fast=true]",
        ...(existsSync(path.join(directory, "ambiguous-models")) ? ["selected[fast=false]"] : []),
      ]
    : ["default-model", "first-model", "second-model", "gpt-5.6-luna"];
}

function configOptions(): SessionConfigOption[] {
  return [
    ...(route === "config" && !existsSync(path.join(directory, "remove-model-control"))
      ? [
          {
            id: "llm",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: model,
            options: modelIds().map((value) => ({
              value,
              name: value,
            })),
          },
        ]
      : []),
    {
      id: "effort",
      name: "Effort",
      type: "select",
      currentValue: effort,
      options: ["low", "high", "xhigh"].map((value) => ({ value, name: value })),
    },
  ];
}

function sessionState() {
  return {
    configOptions: configOptions(),
    modes: {
      currentModeId: mode,
      availableModes: [
        "auto",
        ...(existsSync(path.join(directory, "retired-plan")) ? [] : ["plan"]),
      ].map((id) => ({ id, name: id })),
    },
    ...(route === "legacy"
      ? {
          models: {
            currentModelId: model,
            availableModels: modelIds().map((modelId) => ({
              modelId,
              name: modelId,
            })),
          },
        }
      : {}),
  };
}

async function control(method: string, value: string, apply: () => void) {
  const sequence = ++controlCount;
  const entry = JSON.stringify({ sequence, method, value }) + "\n";
  await fs.appendFile(path.join(directory, "received.jsonl"), entry);
  await fs.writeFile(path.join(directory, `received-${sequence}`), "received");
  if (existsSync(path.join(directory, "disconnect-control"))) {
    process.exit(23);
  }
  if (sequence === 1 && existsSync(path.join(directory, "hold-first"))) {
    while (!existsSync(path.join(directory, "release-first"))) {
      await setTimeout(5);
    }
  }
  if (existsSync(path.join(directory, "hold-control"))) {
    while (!existsSync(path.join(directory, "release-control"))) {
      await setTimeout(5);
    }
  }
  apply();
  await fs.appendFile(path.join(directory, "effects.jsonl"), entry);
}

const app = agent()
  .onRequest(methods.agent.initialize, async () => {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: !existsSync(path.join(directory, "no-load")),
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    };
  })
  .onRequest(methods.agent.authenticate, async () => {})
  .onRequest(methods.agent.session.new, async () => {
    await fs.appendFile(path.join(directory, "sessions.jsonl"), '"new"\n');
    if (existsSync(path.join(directory, "hold-new"))) {
      await fs.writeFile(path.join(directory, "new-started"), "started");
      while (!existsSync(path.join(directory, "release-new"))) {
        await setTimeout(5);
      }
    }
    return { sessionId: "authority-session", ...sessionState() };
  })
  .onRequest(methods.agent.session.load, async () => {
    await fs.appendFile(path.join(directory, "sessions.jsonl"), '"load"\n');
    if (existsSync(path.join(directory, "hold-load"))) {
      await fs.writeFile(path.join(directory, "load-started"), "started");
      while (!existsSync(path.join(directory, "release-load"))) {
        await setTimeout(5);
      }
    }
    if (existsSync(path.join(directory, "fail-load"))) {
      throw RequestError.internalError(undefined, "Controlled cold load failure");
    }
    return sessionState();
  })
  .onRequest(methods.agent.session.prompt, async ({ params: { sessionId, prompt } }) => {
    if (prompt.some((part) => part.type === "text" && part.text === "refresh-models")) {
      await connection.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
      });
    }
    const entry = JSON.stringify({ sessionId, prompt }) + "\n";
    await fs.appendFile(path.join(directory, "prompts.jsonl"), entry);
    await fs.writeFile(path.join(directory, "prompt-started"), "started");
    while (!existsSync(path.join(directory, "release-prompt"))) {
      await setTimeout(5);
    }
    if (existsSync(path.join(directory, "emit-final-state"))) {
      await connection.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "final answer while control waits" },
        },
      });
      await connection.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "after-control", description: "Final command metadata" }],
        },
      });
      await connection.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 12,
          size: 500,
          _meta: { usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } },
        },
      });
    }
    await fs.appendFile(path.join(directory, "prompt-effects.jsonl"), entry);
    return { stopReason: "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, async () => {})
  .onRequest(methods.agent.session.close, async () => {
    await fs.appendFile(path.join(directory, "sessions.jsonl"), '"close"\n');
    return {};
  })
  .onRequest(methods.agent.session.setMode, async ({ params: { modeId } }) => {
    await control("session/set_mode", modeId, () => {
      if (
        (modeId === "plan" && existsSync(path.join(directory, "retired-plan"))) ||
        (modeId === "auto" && existsSync(path.join(directory, "reject-auto")))
      ) {
        throw RequestError.invalidParams({ modeId });
      }
      mode = modeId;
    });
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params: { configId, value } }) => {
    if (typeof value !== "string") {
      throw new Error("Expected string config value");
    }
    await control("session/set_config_option", value, () => {
      if (configId === "llm") {
        model = value;
        if (existsSync(path.join(directory, "parameterized-models"))) {
          effort = "low";
        }
      } else {
        effort = value;
      }
    });
    return { configOptions: configOptions() };
  })
  .onRequest(
    "session/set_model",
    (params: unknown) => {
      const modelId =
        params !== null && typeof params === "object" && "modelId" in params
          ? params.modelId
          : undefined;
      if (typeof modelId !== "string") {
        throw new Error("Unsupported control request");
      }
      return { modelId };
    },
    async ({ params: { modelId } }) => {
      await control("session/set_model", modelId, () => {
        model = modelId;
      });
      return {};
    },
  );

const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => controller.enqueue(chunk));
    process.stdin.once("end", () => controller.close());
    process.stdin.once("error", (error: Error) => controller.error(error));
  },
  cancel() {
    process.stdin.destroy();
  },
});
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  },
});
const connection = app.connect(ndJsonStream(output, input));
await connection.closed;
