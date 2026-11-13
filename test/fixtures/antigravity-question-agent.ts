import readline from "node:readline";
import type { AnyMessage, RequestPermissionResponse } from "@agentclientprotocol/sdk";

const send = (message: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
let promptId: string | number | null | undefined;

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line) as AnyMessage;
    if ("method" in message && "id" in message) {
      const { id, method } = message;
      if (method === "initialize") {
        send({
          id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "antigravity-acp", version: "test" },
            agentCapabilities: {},
          },
        });
      } else if (method === "session/new") {
        send({ id, result: { sessionId: "question-session" } });
      } else if (method === "session/prompt") {
        promptId = id;
        send({
          id: "question",
          method: "session/request_permission",
          params: {
            sessionId: "question-session",
            toolCall: {
              toolCallId: "interaction_question",
              title: "Choose a target",
              kind: "other",
            },
            options: [
              { optionId: "production", name: "Production", kind: "allow_once" },
              { optionId: "staging", name: "Staging", kind: "allow_once" },
            ],
          },
        });
      } else {
        send({ id, result: {} });
      }
    } else if ("result" in message && message.id === "question") {
      const { outcome } = message.result as RequestPermissionResponse;
      send({
        method: "session/update",
        params: {
          sessionId: "question-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: outcome.outcome === "selected" ? outcome.optionId : "cancelled",
            },
          },
        },
      });
      send({ id: promptId, result: { stopReason: "end_turn" } });
    }
  })
  .on("close", () => process.exit(0));
