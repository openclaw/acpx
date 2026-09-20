import { performance } from "node:perf_hooks";
import { TimeoutError } from "../async-control.js";

type OwnedOutcome = { ok: true } | { ok: false; error: unknown };

/** One node attempt owns admission and completion of its managed operations. */
export class FlowAttempt {
  readonly signal: AbortSignal;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly startedAt: string;
  terminationSignal: NodeJS.Signals = "SIGTERM";

  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<OwnedOutcome>>();
  private readonly cancellations = new Set<(signal: NodeJS.Signals) => Promise<void>>();
  private readonly cleanupFailures: unknown[] = [];
  private readonly deadlineAt?: number;
  private readonly timeoutMs?: number;
  private readonly timer?: NodeJS.Timeout;
  private accepting = true;
  private finished = false;

  constructor(options: {
    nodeId: string;
    attemptId: string;
    startedAt: string;
    timeoutMs?: number;
  }) {
    this.nodeId = options.nodeId;
    this.attemptId = options.attemptId;
    this.startedAt = options.startedAt;
    this.signal = this.controller.signal;
    if (options.timeoutMs != null && options.timeoutMs > 0) {
      this.timeoutMs = options.timeoutMs;
      this.deadlineAt = performance.now() + options.timeoutMs;
      this.timer = setTimeout(
        () => this.cancel(new TimeoutError(options.timeoutMs!)),
        options.timeoutMs,
      );
    }
  }

  get active(): boolean {
    return this.accepting && !this.signal.aborted;
  }

  assertActive(): void {
    this.checkDeadline();
    this.signal.throwIfAborted();
    if (!this.accepting) {
      throw new Error("Flow attempt has finished accepting work");
    }
  }

  remainingTimeoutMs(): number | undefined {
    this.assertActive();
    return this.deadlineAt === undefined
      ? undefined
      : Math.max(1, Math.ceil(this.deadlineAt - performance.now()));
  }

  cancel(reason: unknown, signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.finished || this.signal.aborted) {
      return;
    }
    this.accepting = false;
    this.terminationSignal = signal;
    this.controller.abort(reason);
    for (const cancel of this.cancellations) {
      this.trackCancellation(cancel);
    }
  }

  registerCancellation(cancel: (signal: NodeJS.Signals) => Promise<void>): () => void {
    if (!this.active) {
      this.trackCancellation(cancel);
      return () => {};
    }
    this.cancellations.add(cancel);
    return () => {
      this.cancellations.delete(cancel);
    };
  }

  /** Track runtime work, never an arbitrary user callback that may ignore cancellation. */
  own<T>(run: () => Promise<T>, options: { bestEffort?: boolean } = {}): Promise<T> {
    this.assertActive();
    const operation = run().then((value) => {
      this.checkDeadline();
      if (this.signal.aborted) {
        this.signal.throwIfAborted();
      }
      return value;
    });
    const outcome = operation.then<OwnedOutcome, OwnedOutcome>(
      () => ({ ok: true }),
      (error: unknown) => (options.bestEffort ? { ok: true } : { ok: false, error }),
    );
    this.pending.add(outcome);
    void outcome.then(() => this.pending.delete(outcome));
    return operation;
  }

  async run<T>(run: () => Promise<T>): Promise<T> {
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(this.signal.reason);
    this.signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.assertActive();
      const value = await Promise.race([run(), aborted]);
      this.accepting = false;
      const errors = await this.drain();
      if (errors.length > 0) {
        throw this.cleanupError(errors);
      }
      this.checkDeadline();
      this.signal.throwIfAborted();
      return value;
    } catch (error) {
      this.cancel(error);
      const errors = await this.drain();
      if (errors.length > 0) {
        throw this.cleanupError([error, ...errors]);
      }
      throw error;
    } finally {
      this.accepting = false;
      this.finished = true;
      clearTimeout(this.timer);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  private checkDeadline(): void {
    if (this.deadlineAt !== undefined && performance.now() >= this.deadlineAt) {
      this.cancel(new TimeoutError(this.timeoutMs!));
    }
  }

  private async drain(): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (this.pending.size > 0) {
      for (const outcome of await Promise.all(this.pending)) {
        if (!outcome.ok && outcome.error !== this.signal.reason) {
          errors.push(outcome.error);
        }
      }
    }
    return [...new Set([...errors, ...this.cleanupFailures.splice(0)])];
  }

  private trackCancellation(cancel: (signal: NodeJS.Signals) => Promise<void>): void {
    const outcome = Promise.resolve()
      .then(() => cancel(this.terminationSignal))
      .then<OwnedOutcome, OwnedOutcome>(
        () => ({ ok: true }),
        (error: unknown) => {
          this.cleanupFailures.push(error);
          return { ok: true };
        },
      );
    this.pending.add(outcome);
    void outcome.then(() => this.pending.delete(outcome));
  }

  private cleanupError(errors: unknown[]): Error {
    const reason: unknown = this.signal.reason;
    const failures = [...new Set([...(this.signal.aborted ? [reason] : []), ...errors])];
    return new AggregateError(failures, "Flow attempt cleanup failed", { cause: failures[0] });
  }
}
