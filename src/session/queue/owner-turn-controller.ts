import type { QueueOwnerControlMethods } from "./control-admission.js";

export type QueueOwnerTurnState = "idle" | "starting" | "active" | "closing";

export type QueueOwnerActiveSessionController = QueueOwnerControlMethods & {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
};

export class QueueOwnerTurnController {
  private state: QueueOwnerTurnState = "idle";
  private pendingCancel = false;
  private activeController?: QueueOwnerActiveSessionController;
  private waitingTurn?: AbortController;

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
}
