import type { AcpClient } from "../../acp/client.js";
import { withTimeout } from "../../async-control.js";
import { AgentDisconnectedError } from "../../errors.js";

/** Internal ownership control; unrelated to a submitting client's detach signal. */
export type DirectExecutionControl = {
  signal: AbortSignal;
  handleProcessInterrupts?: boolean;
};

export function ownDirectClient(
  client: AcpClient,
  signal?: AbortSignal,
): (() => Promise<void>) & { release: () => void } {
  let closing: Promise<void> | undefined;
  const cancel = async () => {
    await withTimeout(client.cancelActivePrompt(2_500), 2_500).catch(() => {
      // Retirement still owns cleanup when cooperative cancellation fails or stalls.
    });
    await client.close();
  };
  const onAbort = () => {
    closing ??= cancel();
    void closing.catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  const release = () => signal?.removeEventListener("abort", onAbort);
  return Object.assign(
    () => {
      release();
      closing ??= client.close();
      return closing;
    },
    { release },
  );
}

export function directExecutionError(error: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted && error instanceof AgentDisconnectedError ? signal.reason : error;
}
