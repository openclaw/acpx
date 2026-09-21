import fs from "node:fs/promises";
import readline from "node:readline";

type Operation = {
  method: "fs/read_text_file" | "fs/write_text_file";
  path: string;
  content?: string;
};
type Message = {
  id?: number;
  method?: string;
  params?: { cwd?: string };
  result?: unknown;
  error?: unknown;
};
type Config = {
  receiptPath: string;
  requests: Operation[];
  cleanupSwap?: { source: string; moved: string; target: string };
};

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], "utf8")) as Config;
  const pending = new Map<number, (response: Message) => void>();
  const receipts: Array<{ operation: Operation; response: Message }> = [];
  let nextId = 1000;
  let sessionCwd: string | undefined;
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const request = (operation: Operation) =>
    new Promise<Message>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({
        jsonrpc: "2.0",
        id,
        method: operation.method,
        params: {
          sessionId: "synthetic-session",
          path: operation.path,
          ...(operation.content === undefined ? {} : { content: operation.content }),
        },
      });
    });
  async function handle(message: Message) {
    if (!message.method) {
      if (message.id === undefined) {
        return;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
      return;
    }
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "synthetic-filesystem-probe", version: "1.0.0" },
        },
      });
    } else if (message.method === "session/new") {
      sessionCwd = message.params?.cwd;
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "synthetic-session" } });
    } else if (message.method === "session/prompt") {
      for (const operation of config.requests) {
        receipts.push({ operation, response: await request(operation) });
      }
      // Deterministic cleanup-boundary probe, not a race or sandbox test.
      if (config.cleanupSwap) {
        await fs.rename(config.cleanupSwap.source, config.cleanupSwap.moved);
        await fs.symlink(config.cleanupSwap.target, config.cleanupSwap.source, "dir");
      }
      await fs.writeFile(
        config.receiptPath,
        JSON.stringify({
          sessionCwd,
          agentCwd: process.cwd(),
          receipts,
        }),
      );
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    void handle(JSON.parse(line) as Message).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
      lines.close();
      process.stdin.destroy();
    });
  });
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
