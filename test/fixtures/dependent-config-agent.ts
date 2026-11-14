import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const [directory] = process.argv.slice(2);
if (!directory) {
  throw new Error("Expected a fixture directory");
}

const sessionId = "dependent-config-session";
const file = (name: string) => path.join(directory, name);
const marked = (name: string) => existsSync(file(name));
const note = (event: string) => appendFileSync(file("events"), `${process.pid} ${event}\n`);
const modelFile = file("model");
let model = existsSync(modelFile) ? readFileSync(modelFile, "utf8") : "model-1";
const reasoning = {
  "reasoning-a": { current: "low", values: ["low", "high"] },
  "reasoning-b": { current: "minimal", values: ["minimal", "max"] },
};

const reasoningId = () => (model === "model-2" ? "reasoning-b" : "reasoning-a");

function select(
  id: string,
  name: string,
  currentValue: string,
  values: string[],
  category: "model" | "thought_level",
): SessionConfigOption {
  return {
    id,
    name,
    type: "select",
    category,
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

function configOptions(): SessionConfigOption[] {
  const id = reasoningId();
  return [
    select("model", "Model", model, ["model-1", "model-2"], "model"),
    select(id, "Reasoning", reasoning[id].current, reasoning[id].values, "thought_level"),
  ];
}

async function hold(operation: string): Promise<void> {
  if (!marked(`hold-${operation}`)) {
    return;
  }
  writeFileSync(file(`held-${operation}`), "");
  while (!marked(`release-${operation}`)) {
    await setTimeout(5);
  }
}

note("start");
process.on("exit", () => note("exit"));
const agent: Agent = {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } };
  },
  async authenticate() {},
  async newSession() {
    note("new");
    return { sessionId, configOptions: configOptions() };
  },
  async loadSession(input) {
    note("load");
    await hold("load");
    if (input.sessionId !== sessionId || marked("refuse-load")) {
      throw RequestError.internalError(undefined, "controlled load failure");
    }
    if (marked("replay-history")) {
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replayed history" },
        },
      });
    }
    return { configOptions: configOptions() };
  },
  async prompt(input) {
    if (input.sessionId !== sessionId) {
      throw RequestError.invalidParams();
    }
    note("prompt");
    return { stopReason: "end_turn" };
  },
  async cancel() {},
  async setSessionConfigOption({ sessionId: receivedId, configId, value }) {
    const change = `${configId}=${String(value)}`;
    note(`write:${change}`);
    const id = reasoningId();
    if (receivedId !== sessionId || typeof value !== "string") {
      throw RequestError.invalidParams();
    }
    if (configId === "model" && ["model-1", "model-2"].includes(value)) {
      model = value;
      writeFileSync(modelFile, model);
    } else if (configId === id && reasoning[id].values.includes(value)) {
      reasoning[id].current = value;
    } else {
      throw RequestError.invalidParams({ configId, value });
    }
    note(`mutated:${change}`);
    await hold(configId);
    if (marked(`refuse-${configId}`)) {
      note(`refused:${change}`);
      throw RequestError.internalError(undefined, "refused after mutation");
    }
    note(`ack:${change}`);
    if (marked("omit-catalog")) {
      // Exercise a wire response from a peer that omits configOptions.
      return {} as Awaited<ReturnType<NonNullable<Agent["setSessionConfigOption"]>>>;
    }
    return { configOptions: marked("empty-catalog") ? [] : configOptions() };
  },
};

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
      process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  },
});
const connection = new AgentSideConnection(() => agent, ndJsonStream(output, input));
await connection.closed;
