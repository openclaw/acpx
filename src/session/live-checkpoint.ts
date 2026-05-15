const DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS = 500;

export type LiveSessionCheckpointOptions = {
  save: () => Promise<void>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export class LiveSessionCheckpoint {
  private readonly save: () => Promise<void>;
  private readonly intervalMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private dirty = false;
  private flushing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LiveSessionCheckpointOptions) {
    this.save = options.save;
    this.intervalMs = options.intervalMs ?? DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS;
    this.onError = options.onError;
  }

  request(): void {
    this.dirty = true;
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error: unknown) => {
        this.onError?.(error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async checkpoint(): Promise<void> {
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) {
        return;
      }
    }

    this.flushing = this.flushDirty();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushDirty(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      await this.save();
    }
  }
}
