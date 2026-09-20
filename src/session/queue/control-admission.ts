import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { TimeoutError, type AcpControlAuthority } from "../../async-control.js";
import { QueueConnectionError } from "../../errors.js";

export class QueueControlDeadline {
  private readonly controller = new AbortController();
  private readonly admissionSignal: AbortSignal;
  private readonly expiresAt: number | undefined;
  private readonly expired: Promise<never>;
  private readonly timeoutError: TimeoutError | undefined;
  private rejectExpiry!: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private nativeSettled = false;
  private admitted = false;

  constructor(timeoutMs?: number, ownerSignal?: AbortSignal) {
    this.admissionSignal = ownerSignal
      ? AbortSignal.any([this.controller.signal, ownerSignal])
      : this.controller.signal;
    this.expiresAt = timeoutMs != null && timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
    this.timeoutError = this.expiresAt === undefined ? undefined : new TimeoutError(timeoutMs!);
    this.expired = new Promise<never>((_resolve, reject) => {
      this.rejectExpiry = reject;
      if (this.expiresAt !== undefined) {
        this.timer = setTimeout(() => this.expire(), timeoutMs);
      }
    });
    void this.expired.catch(() => {});
  }

  get signal(): AbortSignal {
    return this.admissionSignal;
  }

  get timeoutSignal(): AbortSignal {
    return this.controller.signal;
  }

  get remainingMs(): number | undefined {
    this.assertActive();
    return this.expiresAt === undefined || this.nativeSettled
      ? undefined
      : Math.max(1, this.expiresAt - performance.now());
  }

  get nativeAdmitted(): boolean {
    return this.admitted;
  }

  get authority(): AcpControlAuthority {
    return {
      signal: this.signal,
      assertActive: () => {
        this.assertActive();
        this.admitted = true;
      },
    };
  }

  assertActive(): void {
    if (this.expiresAt !== undefined && performance.now() >= this.expiresAt) {
      this.expire();
    }
    this.signal.throwIfAborted();
  }

  private expire(): void {
    if (this.nativeSettled || this.timeoutSignal.aborted || !this.timeoutError) {
      return;
    }
    this.controller.abort(this.timeoutError);
    this.rejectExpiry(this.timeoutError);
  }

  responseSettled(): void {
    this.nativeSettled = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  isExpired(error: unknown): boolean {
    return this.timeoutSignal.aborted && error === this.timeoutSignal.reason;
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    return await Promise.race([operation, this.expired]);
  }
}

export type QueueOwnerControlMethods = {
  setSessionMode: (modeId: string, deadline?: QueueControlDeadline) => Promise<void>;
  setSessionModel: (
    modelId: string,
    deadline?: QueueControlDeadline,
  ) => Promise<SetSessionConfigOptionResponse | undefined>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    deadline?: QueueControlDeadline,
  ) => Promise<SetSessionConfigOptionResponse>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function drained(operation: Promise<unknown>): Promise<void> {
  return operation.then(
    () => {},
    () => {},
  );
}

export type PromptControlTicket = {
  ready: ReturnType<typeof deferred<QueueOwnerControlMethods>>;
  released: ReturnType<typeof deferred<void>>;
  rawTail: Promise<void>;
  sealed: boolean;
};

type ControlInvocation<T> = (
  controls: QueueOwnerControlMethods,
  deadline: QueueControlDeadline,
) => Promise<T>;

export type IdleControlOptions = {
  deadline: QueueControlDeadline;
  replacingConfigOption?: { key: string };
};

type ControlAdmissionOptions = {
  runIdle: <T>(invoke: ControlInvocation<T>, options: IdleControlOptions) => Promise<T>;
};

export class QueueOwnerControlAdmission {
  private readonly options: ControlAdmissionOptions;
  private idleTail: Promise<void> = Promise.resolve();
  private ticket: PromptControlTicket | undefined;
  private readonly stopped = new AbortController();
  private pending = 0;

  constructor(options: ControlAdmissionOptions) {
    this.options = options;
  }

  get hasPending(): boolean {
    return this.pending > 0;
  }

  beginPrompt(): { ticket: PromptControlTicket; priorIdle: Promise<void> } {
    const ticket: PromptControlTicket = {
      ready: deferred<QueueOwnerControlMethods>(),
      released: deferred<void>(),
      rawTail: Promise.resolve(),
      sealed: false,
    };
    this.ticket = ticket;
    return { ticket, priorIdle: this.idleTail };
  }

  publish(ticket: PromptControlTicket, controls: QueueOwnerControlMethods): void {
    if (!ticket.sealed) {
      ticket.ready.resolve(controls);
    }
  }

  seal(ticket: PromptControlTicket): Promise<void> {
    ticket.sealed = true;
    ticket.ready.reject(
      new QueueConnectionError("Prompt ended before controls became ready", {
        detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
        origin: "queue",
        retryable: true,
      }),
    );
    return ticket.rawTail;
  }

  release(ticket: PromptControlTicket): void {
    if (this.ticket === ticket) {
      this.ticket = undefined;
    }
    ticket.released.resolve();
  }

  stopAdmission(): void {
    this.stopped.abort(
      new QueueConnectionError("Queue owner is closing", {
        detailCode: "QUEUE_OWNER_SHUTTING_DOWN",
        origin: "queue",
        retryable: true,
      }),
    );
  }

  async drainAdmitted(): Promise<void> {
    await Promise.all([this.idleTail, this.ticket?.rawTail]);
  }

  async run<T>(
    invoke: ControlInvocation<T>,
    timeoutMs?: number,
    replacingConfigOption?: { key: string },
  ): Promise<T> {
    const deadline = new QueueControlDeadline(timeoutMs, this.stopped.signal);
    this.pending += 1;
    const operation = this.enqueue(invoke, { deadline, replacingConfigOption });
    void operation
      .finally(() => {
        this.pending -= 1;
        deadline.responseSettled();
      })
      .catch(() => {});
    return await deadline.wait(operation);
  }

  private async enqueue<T>(invoke: ControlInvocation<T>, options: IdleControlOptions): Promise<T> {
    options.deadline.assertActive();
    const ticket = this.ticket;
    if (ticket?.sealed) {
      return ticket.released.promise.then(() => this.enqueue(invoke, options));
    }
    if (ticket) {
      const operation = ticket.rawTail.then(async () => {
        const controls = await ticket.ready.promise.catch((error: unknown) => {
          options.deadline.assertActive();
          throw error;
        });
        options.deadline.assertActive();
        return await invoke(controls, options.deadline);
      });
      ticket.rawTail = drained(operation);
      return operation;
    }
    const operation = this.idleTail.then(async () => {
      options.deadline.assertActive();
      return await this.options.runIdle(invoke, options);
    });
    this.idleTail = drained(operation);
    return operation;
  }
}
