import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
process.stdin.on("end", () => process.exit(0));
const sessionId = "capture-session";
const send = (value: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as {
    id?: number;
    method: string;
    params: { prompt: Array<{ text: string }> };
  };
  if (request.id === undefined) {
    continue;
  }
  let result;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
      break;
    case "session/new":
      result = { sessionId };
      break;
    case "session/load":
      result = {};
      break;
    case "session/prompt": {
      const input = JSON.parse(request.params.prompt[0].text) as {
        runDir: string;
        readyPath: string;
        releasePath: string;
        fail: boolean;
      };
      const manifest = JSON.parse(
        await fs.readFile(path.join(input.runDir, "manifest.json"), "utf8"),
      ) as { sessions: Array<{ eventsPath: string }> };
      const eventPath = path.join(input.runDir, manifest.sessions[0].eventsPath);
      // Let earlier writes create the file before replacing it with a directory.
      while (
        !(await fs.readFile(eventPath, "utf8").catch(() => "")).includes(
          '"method":"session/prompt"',
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await fs.writeFile(input.readyPath, "ready");
      await fs.rename(eventPath, eventPath + ".saved").catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
      await fs.mkdir(eventPath);
      send({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "CAPTURE_WRITE_PENDING" },
          },
        },
      });
      while (!(await fs.stat(input.releasePath).catch(() => undefined))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (input.fail) {
        send({ id: request.id, error: { code: -32077, message: "DISTINCTIVE_PROMPT_FAILURE" } });
        continue;
      }
      result = { stopReason: "end_turn" };
      break;
    }
    default:
      send({ id: request.id, error: { code: -32601, message: "unsupported" } });
      continue;
  }
  send({ id: request.id, result });
}
