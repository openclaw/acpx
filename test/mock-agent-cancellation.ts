export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

export async function sleepWithCancel(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  assertNotCancelled(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      run();
    };

    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(new CancelledError()));
    };

    const timer = setTimeout(() => {
      finish(() => resolve());
    }, ms);

    // Polling reuses one signal, so completed sleeps must remove this exact listener.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
