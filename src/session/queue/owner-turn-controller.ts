import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError } from "../../errors.js";

export type QueueOwnerTurnState = "idle" | "starting" | "active" | "closing";

export type QueueOwnerActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<SetSessionConfigOptionResponse | undefined>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

type QueueOwnerTurnControllerOptions = {
  withTimeout: <T>(run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  setSessionModeFallback: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionModelFallback: (
    modelId: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse | undefined>;
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
  private waitingTurn?: AbortController;

  constructor(options: QueueOwnerTurnControllerOptions) {
    this.options = options;
  }

  get lifecycleState(): QueueOwnerTurnState {
    return this.state;
  }

  get hasPendingCancel(): boolean {
    return this.pendingCancel;
  }

  beginTurn(): AbortSignal {
    this.state = "starting";
    this.pendingCancel = false;
    this.waitingTurn = new AbortController();
    return this.waitingTurn.signal;
  }

  markPromptActive(): void {
    if (this.state === "starting" || this.state === "active") {
      this.state = "active";
    }
  }

  endTurn(): void {
    this.state = "idle";
    this.pendingCancel = false;
    this.waitingTurn = undefined;
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
      throw new QueueConnectionError("Queue owner is closing", {
        detailCode: "QUEUE_OWNER_SHUTTING_DOWN",
        origin: "queue",
        retryable: true,
      });
    }
  }

  async requestCancel(): Promise<boolean> {
    const activeController = this.activeController;
    if (activeController?.hasActivePrompt()) {
      return await this.cancelActivePrompt(activeController);
    }

    if (this.state === "starting" || this.state === "active") {
      this.pendingCancel = true;
      this.waitingTurn?.abort();
      return true;
    }

    return false;
  }

  async applyPendingCancel(): Promise<boolean> {
    const activeController = this.activeController;
    if (!this.pendingCancel || !activeController || !activeController.hasActivePrompt()) {
      return false;
    }

    return await this.cancelActivePrompt(activeController);
  }

  private async cancelActivePrompt(
    activeController: QueueOwnerActiveSessionController,
  ): Promise<boolean> {
    const turn = this.waitingTurn;
    // Start the native cancellation before abort callbacks can reenter.
    const cancellation = activeController.requestCancelActivePrompt();
    turn?.abort();
    const cancelled = await cancellation;
    if (cancelled && this.waitingTurn === turn) {
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

  async setSessionModel(
    modelId: string,
    timeoutMs?: number,
  ): Promise<SetSessionConfigOptionResponse | undefined> {
    this.assertCanHandleControlRequest();
    const activeController = this.activeController;
    if (activeController) {
      return await this.options.withTimeout(
        async () => await activeController.setSessionModel(modelId),
        timeoutMs,
      );
    }

    return await this.options.setSessionModelFallback(modelId, timeoutMs);
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

    return await this.options.setSessionConfigOptionFallback(configId, value, timeoutMs);
  }
}
