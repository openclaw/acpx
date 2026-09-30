import fs from "node:fs";
import readline from "node:readline";

type Request = {
  id?: string | number;
  method: string;
  params?: { sessionId?: string; prompt?: Array<{ text?: string }> };
};

const receipt = process.argv[2];
const send = (message: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, method, params } = JSON.parse(line) as Request;
    const reply = (result: Record<string, unknown>) => send({ id, result });
    if (method === "initialize") {
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    } else if (method === "session/new") {
      if (receipt) {
        fs.writeFileSync(receipt, JSON.stringify(params));
      }
      reply({ sessionId: "synthetic-flow-session" });
    } else if (method === "session/prompt") {
      send({
        method: "session/update",
        params: {
          sessionId: params?.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: params?.prompt?.[0]?.text ?? "" },
          },
        },
      });
      reply({ stopReason: "end_turn" });
    } else if (id !== undefined) {
      reply({});
    }
  })
  .on("close", () => process.exit(0));
