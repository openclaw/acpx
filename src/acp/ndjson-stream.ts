import type { AnyMessage } from "@agentclientprotocol/sdk";
import { AcpxOperationalError } from "../errors.js";
import { shouldIgnoreNonJsonAgentOutputLine } from "./agent-command.js";
import { isAcpMessageObject } from "./jsonrpc.js";

export const DEFAULT_MAX_ACP_MESSAGE_BYTES = 64 * 1024 * 1024;

export class AcpMessageLimitError extends AcpxOperationalError {
  constructor(limit: number) {
    super(
      `ACP message exceeded ACPX_MAX_ACP_MESSAGE_BYTES (${limit} bytes). Increase the limit or set it to 0 for unlimited input.`,
      {
        outputCode: "RUNTIME",
        detailCode: "ACP_MESSAGE_TOO_LARGE",
        origin: "acp",
        retryable: false,
      },
    );
  }
}

export function readMaxAcpMessageBytes(
  raw = process.env.ACPX_MAX_ACP_MESSAGE_BYTES,
): number | undefined {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_MAX_ACP_MESSAGE_BYTES;
  }
  const bytes = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes)) {
    throw new Error(
      "ACPX_MAX_ACP_MESSAGE_BYTES must be a non-negative safe integer; zero is unlimited",
    );
  }
  return bytes === 0 ? undefined : bytes;
}

function countLineBytes(chunk: Uint8Array, retained: number, limit: number): number {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start);
    const end = newline < 0 ? chunk.length : newline;
    retained += end - start;
    if (retained > limit) {
      throw new AcpMessageLimitError(limit);
    }
    if (newline < 0) {
      return retained;
    }
    retained = 0;
    start = end + 1;
  }
  return retained;
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

function enqueueNdJsonChunk(
  agentCommand: string,
  chunk: string,
  fragments: string[],
  controller: ReadableStreamDefaultController<AnyMessage>,
): void {
  // Scan each chunk once; rescanning an unfinished line makes large,
  // fragmented messages quadratic. Join retained fragments only at LF.
  const lines = chunk.split("\n");
  const suffix = lines.pop() || "";
  if (lines.length > 0 && fragments.length > 0) {
    lines[0] = fragments.join("") + lines[0];
    fragments.length = 0;
  }
  for (const line of lines) {
    enqueueNdJsonLine(agentCommand, line, controller);
  }
  if (suffix) {
    fragments.push(suffix);
  }
}

export function createNdJsonMessageStream(
  agentCommand: string,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  maxMessageBytes?: number,
  onReadError?: (error: Error) => void,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const fragments: string[] = [];
      let retainedBytes = 0;
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (maxMessageBytes !== undefined) {
            retainedBytes = countLineBytes(value, retainedBytes, maxMessageBytes);
          }
          enqueueNdJsonChunk(
            agentCommand,
            textDecoder.decode(value, { stream: true }),
            fragments,
            controller,
          );
        }
        controller.close();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        controller.error(error);
        onReadError?.(error);
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
