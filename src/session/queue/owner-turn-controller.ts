import type { QueueOwnerControlMethods } from "./control-admission.js";

export type QueueOwnerActiveSessionController = QueueOwnerControlMethods & {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
};

export class QueueOwnerTurnController {
  private pendingCancel = false;
  private activeController?: QueueOwnerActiveSessionController;
  private waitingTurn?: AbortController;

  beginTurn(): AbortSignal {
    this.pendingCancel = false;
    this.waitingTurn = new AbortController();
    return this.waitingTurn.signal;
  }

  endTurn(): void {
    this.pendingCancel = false;
    this.waitingTurn = undefined;
  }

  beginClosing(): void {
    this.endTurn();
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

    if (this.waitingTurn) {
      this.pendingCancel = true;
      this.waitingTurn.abort();
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
