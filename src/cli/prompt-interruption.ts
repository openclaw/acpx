import { randomUUID } from "node:crypto";
import { InterruptedError, TimeoutError, withTimeout } from "../async-control.js";

const INTERRUPT_CANCEL_WAIT_MS = 2_500;

export type ForegroundSubmission = {
  requestId: string;
  signal: AbortSignal;
  onQueueAccepted: () => void;
};

/** CLI interruption cancels its own request; ordinary observer detach does not. */
export async function withPromptInterrupts<T>(
  submit: (submission: ForegroundSubmission) => Promise<T>,
  cancel: (requestId: string) => Promise<unknown>,
): Promise<T> {
  const requestId = randomUUID();
  const observer = new AbortController();
  const interrupted = new InterruptedError();
  let accepted = false;
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let cancellation: Promise<unknown> | undefined;
  const onInterrupt = () => {
    cancellation ??= withTimeout(
      admission.then(async () => {
        if (accepted && !observer.signal.aborted) {
          await cancel(requestId);
        }
      }),
      INTERRUPT_CANCEL_WAIT_MS,
    )
      .catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new Error(
            "Timed out cancelling foreground prompt; request outcome is unknown. Inspect the same session with status, sessions history, or sessions watch before resubmitting.",
            { cause: error },
          );
        }
        throw error;
      })
      .finally(() => observer.abort(interrupted));
    // The submit path below owns reporting this failure, including old-owner refusal.
    void cancellation.catch(() => {});
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) {
    process.on(signal, onInterrupt);
  }
  try {
    const result = await submit({
      requestId,
      signal: observer.signal,
      onQueueAccepted: () => {
        accepted = true;
        releaseAdmission();
      },
    }).finally(releaseAdmission);
    if (cancellation) {
      await cancellation;
      throw interrupted;
    }
    return result;
  } catch (error) {
    if (cancellation && (accepted || error === interrupted)) {
      await cancellation;
      throw interrupted;
    }
    // Before acknowledgement a transport failure can mean an unknown outcome.
    // Do not disguise that as confirmed cancellation.
    throw error;
  } finally {
    releaseAdmission();
    for (const signal of signals) {
      process.off(signal, onInterrupt);
    }
  }
}
