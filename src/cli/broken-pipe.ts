export type BrokenPipeMode = "exit" | "ignore";

export function handleBrokenPipeError(
  error: NodeJS.ErrnoException,
  mode: BrokenPipeMode,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
  if (mode === "exit") {
    exit(0);
  }
}

export function installBrokenPipeHandler(
  stream: NodeJS.WritableStream,
  mode: BrokenPipeMode,
): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    handleBrokenPipeError(error, mode);
  });
}
