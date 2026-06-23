import { buildJsonRpcErrorResponse } from "../../acp/jsonrpc-error.js";
import type {
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  OutputFormatterContext,
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
  error?: unknown;
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
      update: sanitizeToolUpdate(update),
    },
  };
}

function sanitizeToolUpdate(update: Record<string, unknown>): Record<string, unknown> {
  return {
    ...update,
    rawOutput: sanitizedRawOutput(update),
    content: sanitizedContent(update),
  };
}

function sanitizedRawOutput(update: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(update, "rawOutput") && update.rawOutput !== undefined) {
    return { content: SUPPRESSED_READ_OUTPUT };
  }
  return update.rawOutput;
}

function sanitizedContent(update: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(update, "content") && update.content !== undefined) {
    return sanitizeToolContent(update.content);
  }
  return update.content;
}

class JsonOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private readonly suppressReads: boolean;
  private sessionId: string;
  private readonly requestMethodById = new Map<string, string>();
  private readonly toolStateById = new Map<string, { title?: string; kind?: string | null }>();

  constructor(stdout: WritableLike, suppressReads: boolean, context?: OutputFormatterContext) {
    this.stdout = stdout;
    this.suppressReads = suppressReads;
    this.sessionId = context?.sessionId?.trim() || DEFAULT_JSON_SESSION_ID;
  }

  setContext(context: OutputFormatterContext): void {
    this.sessionId = context.sessionId?.trim() || this.sessionId || DEFAULT_JSON_SESSION_ID;
  }

  onAcpMessage(message: unknown): void {
    this.stdout.write(`${JSON.stringify(this.sanitizeMessage(message))}\n`);
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
    if (!idKey) {
      return message;
    }

    const hasResult = Object.hasOwn(candidate, "result");
    const hasError = Object.hasOwn(candidate, "error");
    if (!hasResult && !hasError) {
      return message;
    }

    const method = this.requestMethodById.get(idKey);
    this.requestMethodById.delete(idKey);
    if (method !== "fs/read_text_file" || !hasResult) {
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
    const update = this.readToolUpdate(message);
    if (!update) {
      return message;
    }

    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!toolCallId) {
      return message;
    }

    const current = this.mergeToolState(toolCallId, update);
    this.toolStateById.set(toolCallId, current);

    return isReadLikeTool(current) ? sanitizeToolMessage(message) : message;
  }

  private readToolUpdate(message: unknown): Record<string, unknown> | undefined {
    const root = asRecord(message);
    if (root?.method !== "session/update") {
      return undefined;
    }
    const params = asRecord(root.params);
    const update = asRecord(params?.update);
    if (!params || !update) {
      return undefined;
    }

    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
      return undefined;
    }
    return update;
  }

  private mergeToolState(
    toolCallId: string,
    update: Record<string, unknown>,
  ): { title?: string; kind?: string | null } {
    const previous = this.toolStateById.get(toolCallId) ?? {};
    return {
      title: typeof update.title === "string" ? update.title : previous.title,
      kind: typeof update.kind === "string" || update.kind === null ? update.kind : previous.kind,
    };
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
): OutputFormatter {
  return new JsonOutputFormatter(stdout, suppressReads, context);
}
