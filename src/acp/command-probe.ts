import type { ChildProcess } from "node:child_process";

// Internal classification: ordinary command failure is soft, host admission is not.
export class CommandProbeAdmissionError extends Error {
  constructor(readonly reason: unknown) {
    super("Agent command admission rejected", { cause: reason });
    this.name = "CommandProbeAdmissionError";
  }
}

export async function admitCommandProbe<T>(admit: () => T | Promise<T>): Promise<T> {
  try {
    return await admit();
  } catch (error) {
    throw new CommandProbeAdmissionError(error);
  }
}

/** Collect only this short adapter command; its client owns process retirement. */
export function captureCommandProbeOutput(
  child: ChildProcess,
  timeoutMs: number,
  retire: () => Promise<void>,
): { result: Promise<string | undefined>; dispose: () => void } {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (value: string | undefined) => void;
  const result = new Promise<string | undefined>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (value: string | undefined) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolveResult(value);
  };
  const fail = () => {
    if (disposed) {
      return;
    }
    finish(undefined);
    // The owning operation awaits this same idempotent retirement in finally.
    void retire().catch(() => {});
  };
  const onStdout = (chunk: string) => {
    if (!settled) {
      stdout += chunk;
    }
  };
  const onStderr = (chunk: string) => {
    if (!settled) {
      stderr += chunk;
    }
  };
  const onClose = () => finish(`${stdout}\n${stderr}`);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.on("error", fail);
  child.stdout?.on("error", fail);
  child.stderr?.on("error", fail);
  child.once("close", onClose);
  timer = setTimeout(fail, timeoutMs);

  return {
    result,
    dispose: () => {
      disposed = true;
      finish(undefined);
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("close", onClose);
      // Keep benign error listeners through late stream destruction; remove no
      // lifecycle or descendant listener owned by the client.
    },
  };
}
