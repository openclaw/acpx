import { textPrompt, type PromptInput } from "../../prompt-content.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnResult,
} from "../public/contract.js";
import { AcpRuntimeError } from "../public/errors.js";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class AsyncEventQueue {
  private readonly items: AcpRuntimeEvent[] = [];
  private readonly waits: Deferred<AcpRuntimeEvent | null>[] = [];
  private closed = false;

  push(item: AcpRuntimeEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waits.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.resolve(null);
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  async next(): Promise<AcpRuntimeEvent | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    const waiter = createDeferred<AcpRuntimeEvent | null>();
    this.waits.push(waiter);
    return await waiter.promise;
  }

  async *iterate(): AsyncIterable<AcpRuntimeEvent> {
    while (true) {
      const next = await this.next();
      if (!next) {
        return;
      }
      yield next;
    }
  }
}

export function toPromptInput(
  text: string,
  attachments?: AcpRuntimeTurnAttachment[],
): PromptInput | string {
  if (!attachments || attachments.length === 0) {
    return text;
  }
  const blocks: PromptInput = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.mediaType.startsWith("image/")) {
      blocks.push({
        type: "image",
        mimeType: attachment.mediaType,
        data: attachment.data,
      });
      continue;
    }
    if (attachment.mediaType.startsWith("audio/")) {
      blocks.push({
        type: "audio",
        mimeType: attachment.mediaType,
        data: attachment.data,
      });
      continue;
    }
    throw new AcpRuntimeError(
      "ACP_TURN_FAILED",
      `Unsupported ACP runtime attachment media type: ${attachment.mediaType}`,
    );
  }
  return blocks.length > 0 ? blocks : textPrompt(text);
}

export function legacyTerminalEventFromTurnResult(result: AcpRuntimeTurnResult): AcpRuntimeEvent {
  if (result.status === "failed") {
    return {
      type: "error",
      message: result.error.message,
      ...(result.error.code ? { code: result.error.code } : {}),
      ...(result.error.detailCode ? { detailCode: result.error.detailCode } : {}),
      ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
    };
  }
  return {
    type: "done",
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
  };
}
