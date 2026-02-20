import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";

export type QueueOwnerTurnState = "idle" | "starting" | "active" | "closing";

export type QueueOwnerActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

type QueueOwnerTurnControllerOptions = {
  withTimeout: <T>(run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  setSessionModeFallback: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOptionFallback: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
};

export class QueueOwnerTurnController {
  private readonly options: QueueOwnerTurnControllerOptions;
  private state: QueueOwnerTurnState = "idle";
  private pendingCancel = false;
  private activeController?: QueueOwnerActiveSessionController;

  constructor(options: QueueOwnerTurnControllerOptions) {
    this.options = options;
  }

  get lifecycleState(): QueueOwnerTurnState {
    return this.state;
  }

  get hasPendingCancel(): boolean {
    return this.pendingCancel;
  }

  beginTurn(): void {
    this.state = "starting";
    this.pendingCancel = false;
  }

  markPromptActive(): void {
    if (this.state === "starting" || this.state === "active") {
      this.state = "active";
    }
  }

  endTurn(): void {
    this.state = "idle";
    this.pendingCancel = false;
  }

  beginClosing(): void {
    this.state = "closing";
    this.pendingCancel = false;
    this.activeController = undefined;
  }

  setActiveController(controller: QueueOwnerActiveSessionController): void {
    this.activeController = controller;
  }

  clearActiveController(): void {
    this.activeController = undefined;
  }

  private assertCanHandleControlRequest(): void {
    if (this.state === "closing") {
      throw new Error("Queue owner is closing");
    }
  }

  async requestCancel(): Promise<boolean> {
    const activeController = this.activeController;
    if (activeController?.hasActivePrompt()) {
      const cancelled = await activeController.requestCancelActivePrompt();
      if (cancelled) {
        this.pendingCancel = false;
      }
      return cancelled;
    }

    if (this.state === "starting" || this.state === "active") {
      this.pendingCancel = true;
      return true;
    }

    return false;
  }

  async applyPendingCancel(): Promise<boolean> {
    const activeController = this.activeController;
    if (
      !this.pendingCancel ||
      !activeController ||
      !activeController.hasActivePrompt()
    ) {
      return false;
    }

    const cancelled = await activeController.requestCancelActivePrompt();
    if (cancelled) {
      this.pendingCancel = false;
    }
    return cancelled;
  }

  async setSessionMode(modeId: string, timeoutMs?: number): Promise<void> {
    this.assertCanHandleControlRequest();
    const activeController = this.activeController;
    if (activeController) {
      await this.options.withTimeout(
        async () => await activeController.setSessionMode(modeId),
        timeoutMs,
      );
      return;
    }

    await this.options.setSessionModeFallback(modeId, timeoutMs);
  }

  async setSessionConfigOption(
    configId: string,
    value: string,
    timeoutMs?: number,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertCanHandleControlRequest();
    const activeController = this.activeController;
    if (activeController) {
      return await this.options.withTimeout(
        async () => await activeController.setSessionConfigOption(configId, value),
        timeoutMs,
      );
    }

    return await this.options.setSessionConfigOptionFallback(
      configId,
      value,
      timeoutMs,
    );
  }
}
