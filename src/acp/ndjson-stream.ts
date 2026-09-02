import type { AnyMessage } from "@agentclientprotocol/sdk";
import { shouldIgnoreNonJsonAgentOutputLine } from "./agent-command.js";
import { isAcpMessageObject } from "./jsonrpc.js";

export const MAX_NDJSON_INCOMPLETE_LINE_BYTES = 8 * 1024 * 1024;

export function assertNdJsonIncompleteLineWithinLimit(content: string): void {
  if (Buffer.byteLength(content) > MAX_NDJSON_INCOMPLETE_LINE_BYTES) {
    throw new Error(`Incomplete NDJSON line exceeded ${MAX_NDJSON_INCOMPLETE_LINE_BYTES} bytes`);
  }
}

export function parseAcpJsonMessageLine(line: string): AnyMessage | undefined {
  const message: unknown = JSON.parse(line);
  return isAcpMessageObject(message) ? message : undefined;
}

function enqueueNdJsonLine(
  agentCommand: string,
  line: string,
  controller: ReadableStreamDefaultController<AnyMessage>,
): void {
  const trimmedLine = line.trim();
  if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) {
    return;
  }
  try {
    const message = parseAcpJsonMessageLine(trimmedLine);
    if (message) {
      controller.enqueue(message);
    }
  } catch (err) {
    console.error("Failed to parse JSON message:", trimmedLine, err);
  }
}

function enqueueNdJsonLines(
  agentCommand: string,
  lines: string[],
  controller: ReadableStreamDefaultController<AnyMessage>,
): void {
  for (const line of lines) {
    enqueueNdJsonLine(agentCommand, line, controller);
  }
}

export function createNdJsonMessageStream(
  agentCommand: string,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          assertNdJsonIncompleteLineWithinLimit(content);
          const lines = content.split("\n");
          content = lines.pop() || "";
          enqueueNdJsonLines(agentCommand, lines, controller);
        }
        controller.close();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}
