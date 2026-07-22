import { writeSync } from "node:fs";

/**
 * Write a fatal diagnostic to fd 2 without relying on async stream buffers.
 * process.stderr.write + process.exit can drop the message on pipes.
 */
export function writeFatalLine(message: string): void {
  const line = message.endsWith("\n") ? message : `${message}\n`;
  try {
    writeSync(2, line);
  } catch {
    // stderr may already be closed or broken
  }
}

export function handleStreamError(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") {
    process.exit(0);
  }

  writeFatalLine(`[acpx] stream error: ${error.message}`);
  process.exit(1);
}

export function handleMainRejection(error: unknown): void {
  // Unexpected top-level failures should keep stack/file/line diagnostics.
  // Expected command errors are handled inside main() before reject.
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeFatalLine(`[acpx] ${message}`);
  process.exitCode = 1;
}
