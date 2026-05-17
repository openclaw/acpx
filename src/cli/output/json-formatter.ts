import { buildJsonRpcErrorResponse } from "../../acp/jsonrpc-error.js";
import { extractSessionUpdateNotification } from "../../acp/jsonrpc.js";
import type {
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  OutputFormatterContext,
  PromptResultEnvelopeInput,
} from "../../types.js";
import { isReadLikeTool, SUPPRESSED_READ_OUTPUT } from "./read-suppression.js";

type WritableLike = {
  write(chunk: string): void;
};

type JsonRpcRequestMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
};

type JsonRpcResponseMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
};

const DEFAULT_JSON_SESSION_ID = "unknown";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  return undefined;
}

function sanitizeReadResult(result: unknown): unknown {
  const record = asRecord(result);
  if (!record || typeof record.content !== "string") {
    return result;
  }
  return {
    ...record,
    content: SUPPRESSED_READ_OUTPUT,
  };
}

function sanitizeToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  return [
    {
      type: "content",
      content: {
        type: "text",
        text: SUPPRESSED_READ_OUTPUT,
      },
    },
  ];
}

function sanitizeToolMessage(message: unknown): unknown {
  const root = asRecord(message);
  const params = asRecord(root?.params);
  const update = asRecord(params?.update);
  if (!root || !params || !update) {
    return message;
  }

  return {
    ...root,
    params: {
      ...params,
      update: {
        ...update,
        rawOutput:
          Object.prototype.hasOwnProperty.call(update, "rawOutput") &&
          update.rawOutput !== undefined
            ? { content: SUPPRESSED_READ_OUTPUT }
            : update.rawOutput,
        content:
          Object.prototype.hasOwnProperty.call(update, "content") && update.content !== undefined
            ? sanitizeToolContent(update.content)
            : update.content,
      },
    },
  };
}

class JsonOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private readonly suppressReads: boolean;
  private readonly jsonStrict: boolean;
  private sessionId: string;
  private readonly requestMethodById = new Map<string, string>();
  private readonly toolStateById = new Map<string, { title?: string; kind?: string | null }>();
  private chunkText = "";
  private messageChunkCount = 0;
  private thoughtChunkCount = 0;
  private promptStartedAt: number | undefined;

  constructor(
    stdout: WritableLike,
    suppressReads: boolean,
    context?: OutputFormatterContext,
    jsonStrict = false,
  ) {
    this.stdout = stdout;
    this.suppressReads = suppressReads;
    this.sessionId = context?.sessionId?.trim() || DEFAULT_JSON_SESSION_ID;
    this.jsonStrict = jsonStrict;
  }

  setContext(context: OutputFormatterContext): void {
    this.sessionId = context.sessionId?.trim() || this.sessionId || DEFAULT_JSON_SESSION_ID;
  }

  beginPrompt(): void {
    this.chunkText = "";
    this.messageChunkCount = 0;
    this.thoughtChunkCount = 0;
    this.promptStartedAt = Date.now();
  }

  onAcpMessage(message: unknown): void {
    if (this.jsonStrict) {
      this.recordChunkSummary(message);
    }
    this.stdout.write(`${JSON.stringify(this.sanitizeMessage(message))}\n`);
  }

  private recordChunkSummary(message: unknown): void {
    const update = extractSessionUpdateNotification(message as never);
    if (!update) {
      return;
    }
    const sessionUpdate = update.update.sessionUpdate;
    if (sessionUpdate === "agent_message_chunk") {
      this.messageChunkCount += 1;
      const content = update.update.content;
      if (content?.type === "text" && typeof content.text === "string") {
        this.chunkText += content.text;
      }
    } else if (sessionUpdate === "agent_thought_chunk") {
      this.thoughtChunkCount += 1;
    }
  }

  emitPromptResultEnvelope(result: PromptResultEnvelopeInput): void {
    if (!this.jsonStrict) {
      return;
    }
    const elapsedMs = this.promptStartedAt !== undefined ? Date.now() - this.promptStartedAt : 0;
    const stopReason = result.stopReason ?? "unknown";
    const finalText = stopReason === "end_turn" ? this.chunkText : null;
    const envelope = {
      jsonrpc: "2.0",
      method: "acpx/prompt_result",
      params: {
        stopReason,
        sessionId: result.sessionId,
        finalText,
        hadMessageChunk: this.messageChunkCount > 0,
        messageChunkCount: this.messageChunkCount,
        thoughtChunkCount: this.thoughtChunkCount,
        elapsedMs,
      },
    };
    this.stdout.write(`${JSON.stringify(envelope)}\n`);
    this.promptStartedAt = undefined;
  }

  private sanitizeMessage(message: unknown): unknown {
    if (!this.suppressReads) {
      return message;
    }

    const sanitizedResponse = this.sanitizeReadResponse(message);
    if (sanitizedResponse !== message) {
      return sanitizedResponse;
    }

    const sanitizedToolMessage = this.sanitizeReadToolMessage(message);
    if (sanitizedToolMessage !== message) {
      return sanitizedToolMessage;
    }

    this.trackRequestMethod(message);
    return message;
  }

  private trackRequestMethod(message: unknown): void {
    const candidate = message as JsonRpcRequestMessage;
    if (typeof candidate.method !== "string") {
      return;
    }
    const idKey = jsonRpcIdKey(candidate.id);
    if (!idKey) {
      return;
    }
    this.requestMethodById.set(idKey, candidate.method);
  }

  private sanitizeReadResponse(message: unknown): unknown {
    const candidate = message as JsonRpcResponseMessage;
    const idKey = jsonRpcIdKey(candidate.id);
    if (!idKey || !Object.hasOwn(candidate, "result")) {
      return message;
    }

    const method = this.requestMethodById.get(idKey);
    this.requestMethodById.delete(idKey);
    if (method !== "fs/read_text_file") {
      return message;
    }

    const root = asRecord(message);
    if (!root) {
      return message;
    }

    return {
      ...root,
      result: sanitizeReadResult(candidate.result),
    };
  }

  private sanitizeReadToolMessage(message: unknown): unknown {
    const root = asRecord(message);
    if (root?.method !== "session/update") {
      return message;
    }

    const params = asRecord(root.params);
    const update = asRecord(params?.update);
    if (!params || !update) {
      return message;
    }

    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
      return message;
    }

    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!toolCallId) {
      return message;
    }

    const previous = this.toolStateById.get(toolCallId) ?? {};
    const current = {
      title: typeof update.title === "string" ? update.title : previous.title,
      kind: typeof update.kind === "string" || update.kind === null ? update.kind : previous.kind,
    };
    this.toolStateById.set(toolCallId, current);

    if (!isReadLikeTool(current)) {
      return message;
    }

    return sanitizeToolMessage(message);
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.stdout.write(
      `${JSON.stringify(
        buildJsonRpcErrorResponse({
          outputCode: params.code,
          detailCode: params.detailCode,
          origin: params.origin,
          message: params.message,
          retryable: params.retryable,
          timestamp: params.timestamp,
          sessionId: this.sessionId,
          acp: params.acp,
        }),
      )}\n`,
    );
  }

  onPermissionEscalation(): void {
    // JSON mode is raw ACP NDJSON. Escalation details ride on the ACP
    // request_permission response _meta instead of a synthetic acpx event line.
  }

  flush(): void {
    // no-op for streaming output
  }
}

export function createJsonOutputFormatter(
  stdout: WritableLike,
  suppressReads = false,
  context?: OutputFormatterContext,
  jsonStrict = false,
): OutputFormatter {
  return new JsonOutputFormatter(stdout, suppressReads, context, jsonStrict);
}
