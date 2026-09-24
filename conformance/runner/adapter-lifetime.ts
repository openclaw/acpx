import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { isChildProcessRunning, waitForChildExit } from "../../src/acp/client-process.js";
import { ProcessDescendants } from "../../src/acp/process-descendants.js";
import { withTimeout } from "../../src/async-control.js";

const CLEANUP_BUDGET_MS = 8_000;
const SNAPSHOT_BUDGET_MS = 1_000;

export class AdapterRetirementError extends Error {}

function streamClosed(stream: Readable | Writable): Promise<void> {
  return stream.closed
    ? Promise.resolve()
    : new Promise((resolve) => {
        stream.once("close", resolve);
      });
}

/** Owns one direct adapter launch, its witnessed descendants, and its pipes. */
export class AdapterLifetime {
  private readonly descendants: ProcessDescendants;
  private readonly pipes: Array<Readable | Writable>;
  private readonly closed: Promise<void>;
  private stopping?: Promise<void>;
  private processError?: Error;

  constructor(private readonly child: ChildProcess) {
    this.descendants = new ProcessDescendants(child, { ownProcessGroup: true });
    this.pipes = [child.stdin, child.stdout, child.stderr].filter(
      (stream): stream is Readable | Writable => stream != null,
    );
    const rememberError = (error: Error) => {
      this.processError = error;
    };
    child.on("error", rememberError);
    for (const pipe of this.pipes) {
      pipe.on("error", rememberError);
      pipe.once("close", () => {
        pipe.off("error", rememberError);
      });
    }
    const childClosed = new Promise<void>((resolve) => {
      child.once("close", () => {
        child.off("error", rememberError);
        resolve();
      });
    });
    this.closed = Promise.all([childClosed, ...this.pipes.map(streamClosed)]).then(() => {});
  }

  async capture(): Promise<void> {
    if (this.child.pid !== undefined) {
      await this.descendants.capture(SNAPSHOT_BUDGET_MS);
    }
  }

  shutdown(connectionClosed: Promise<void>): Promise<void> {
    this.stopping ??= Promise.resolve().then(() => this.retire(connectionClosed));
    return this.stopping;
  }

  private async retire(connectionClosed: Promise<void>): Promise<void> {
    const deadline = performance.now() + CLEANUP_BUDGET_MS;
    const failures: unknown[] = [];
    try {
      if (this.child.pid !== undefined) {
        await this.descendants.capture(this.queryBudget(deadline));
        this.child.stdin?.end();
        const terminated =
          (await this.waitForRetirement(250, deadline)) ||
          (await this.signalAndWait("SIGTERM", 1_500, deadline));
        if (!terminated && !(await this.signalAndWait("SIGKILL", 1_000, deadline))) {
          throw new Error("Adapter process retirement could not be verified", {
            cause: this.processError,
          });
        }
        if (this.descendants.hasUnresolvedOwnership()) {
          throw new Error("Adapter process ownership could not be verified throughout cleanup");
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      this.descendants.retire();
      // Legacy ACP closes when its readable transport ends; join the native
      // handles too, because connection.closed alone is not a pipe-close receipt.
      for (const pipe of this.pipes) {
        pipe.destroy();
      }
      if (isChildProcessRunning(this.child)) {
        this.child.unref();
      }
      try {
        await withTimeout(
          Promise.all([this.closed, connectionClosed]),
          Math.max(1, deadline - performance.now()),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const detail = failures
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ");
      throw new AdapterRetirementError(`Adapter cleanup failed: ${detail}`, {
        cause: new AggregateError(failures),
      });
    }
  }

  private queryBudget(deadline: number): number {
    return Math.max(1, Math.min(SNAPSHOT_BUDGET_MS, deadline - performance.now()));
  }

  private async signalAndWait(
    signal: NodeJS.Signals,
    waitMs: number,
    deadline: number,
  ): Promise<boolean> {
    await this.descendants.signal(signal, this.queryBudget(deadline));
    if (isChildProcessRunning(this.child)) {
      try {
        this.child.kill(signal);
      } catch (error) {
        this.processError = error instanceof Error ? error : new Error(String(error));
      }
    }
    return await this.waitForRetirement(waitMs, deadline);
  }

  private async waitForRetirement(waitMs: number, deadline: number): Promise<boolean> {
    const phaseDeadline = Math.min(deadline, performance.now() + waitMs);
    await waitForChildExit(this.child, Math.max(0, phaseDeadline - performance.now()));
    if (isChildProcessRunning(this.child)) {
      return false;
    }
    // The first post-exit snapshot establishes custody; do not spend its query
    // budget on the remainder of a short cooperative grace period.
    if (!(await this.descendants.capture(this.queryBudget(deadline)))) {
      return false;
    }
    if (!this.descendants.hasTrackedProcesses()) {
      return true;
    }
    const descendantWait = Math.max(0, phaseDeadline - performance.now());
    return descendantWait > 0 && (await this.descendants.waitForExit(descendantWait));
  }
}
