import type { AnyMessage, JsonRpcId } from "@agentclientprotocol/sdk";

type PendingWrite = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

/** Receipts belong to one transport, so reused request ids cannot cross connections. */
export class ResponseWrites {
  private readonly pending = new Map<JsonRpcId, PendingWrite>();

  track(requestId: JsonRpcId, signal: AbortSignal): Promise<void> {
    let entry: PendingWrite;
    const responseSent = new Promise<void>((resolve, reject) => {
      entry = { resolve, reject };
      this.pending.set(requestId, entry);
    });
    const abort = () => entry.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    // Hosts may ignore the optional observation. Always handle rejection internally.
    void responseSent
      .finally(() => {
        signal.removeEventListener("abort", abort);
        if (this.pending.get(requestId) === entry) {
          this.pending.delete(requestId);
        }
      })
      .catch(() => {});
    return responseSent;
  }

  written(message: AnyMessage): void {
    if ("id" in message && !("method" in message)) {
      this.pending.get(message.id)?.resolve();
    }
  }

  close(reason: unknown): void {
    for (const entry of this.pending.values()) {
      entry.reject(reason);
    }
    this.pending.clear();
  }
}

/** Direct internal handler calls have no response transport to observe. */
export function unavailableResponseSent(): Promise<void> {
  const result = Promise.reject<void>(new Error("ACP response transport is unavailable"));
  void result.catch(() => {});
  return result;
}
