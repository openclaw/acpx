import { methods, type AnyMessage, type JsonRpcId } from "@agentclientprotocol/sdk";
import type { AcpMessageDirection } from "../types.js";
import { isSessionUpdateNotification } from "./jsonrpc.js";

type MessageStream = {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
};

type PromptOwner = { requestId: JsonRpcId; sessionId: string };

type ObservedStreamOptions<T> = {
  onMessage: (direction: AcpMessageDirection, message: AnyMessage) => void;
  suppressReplaySessionUpdates: () => boolean;
  bindPromptOwner: (owner: PromptOwner) => T | undefined;
  onPromptRequestWritten: (active: T, owner: PromptOwner) => void;
};

export function observeAcpStream<T>(
  base: MessageStream,
  options: ObservedStreamOptions<T>,
): MessageStream {
  const elicitationRequestIds = new Set<JsonRpcId>();
  const shouldSuppressInboundReplaySessionUpdate = (message: AnyMessage): boolean => {
    return options.suppressReplaySessionUpdates() && isSessionUpdateNotification(message);
  };
  const observeInbound = (message: AnyMessage): void => {
    const requestId = elicitationRequestId(message);
    if (requestId !== undefined) {
      elicitationRequestIds.add(requestId);
      return;
    }
    if (!shouldSuppressInboundReplaySessionUpdate(message)) {
      options.onMessage("inbound", message);
    }
  };

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const reader = base.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          observeInbound(value);
          if (isExtensionNotification(value)) {
            continue;
          }
          controller.enqueue(value);
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const promptOwner = promptRequestOwner(message);
      const activePrompt = promptOwner ? options.bindPromptOwner(promptOwner) : undefined;
      const id = responseId(message);
      const sensitive = id !== undefined && elicitationRequestIds.delete(id);
      if (!sensitive) {
        options.onMessage("outbound", message);
      }
      const writer = base.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
      if (activePrompt && promptOwner) {
        options.onPromptRequestWritten(activePrompt, promptOwner);
      }
    },
  });

  return { readable, writable };
}

function isExtensionNotification(message: AnyMessage): boolean {
  if (!("method" in message) || "id" in message || typeof message.method !== "string") {
    return false;
  }
  return (
    message.method !== methods.client.session.update &&
    message.method !== methods.client.elicitation.complete &&
    message.method !== methods.protocol.cancelRequest
  );
}

function elicitationRequestId(message: AnyMessage): JsonRpcId | undefined {
  if (
    !("method" in message) ||
    message.method !== methods.client.elicitation.create ||
    !("id" in message)
  ) {
    return undefined;
  }
  return message.id;
}

function responseId(message: AnyMessage): JsonRpcId | undefined {
  if (!("id" in message) || "method" in message) {
    return undefined;
  }
  return message.id;
}

function promptRequestOwner(
  message: AnyMessage,
): { requestId: JsonRpcId; sessionId: string } | undefined {
  if (
    !("method" in message) ||
    message.method !== methods.agent.session.prompt ||
    !("id" in message)
  ) {
    return undefined;
  }
  const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof sessionId === "string" ? { requestId: message.id, sessionId } : undefined;
}
