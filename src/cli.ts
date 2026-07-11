#!/usr/bin/env node

import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "./cli-core.js";
import { buildQueueOwnerArgOverride } from "./cli/session/queue-owner-process.js";

export { formatPromptSessionBannerLine } from "./cli-core.js";
export { parseAllowedTools, parseMaxTurns, parseTtlSeconds } from "./cli/flags.js";

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
  const message = error instanceof Error ? error.message : String(error);
  writeFatalLine(`[acpx] ${message}`);
  process.exitCode = 1;
}

function installBrokenPipeHandler(stream: NodeJS.WritableStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    handleStreamError(error);
  });
}

function isCliEntrypoint(argv: string[]): boolean {
  const entry = argv[1];
  if (!entry) {
    return false;
  }

  try {
    // Resolve symlinks so global npm installs match (argv[1] is the
    // symlink in node_modules/.bin, import.meta.url is the real path).
    const resolved = pathToFileURL(realpathSync(entry)).href;
    return import.meta.url === resolved;
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv)) {
  installBrokenPipeHandler(process.stdout);
  installBrokenPipeHandler(process.stderr);

  const queueOwnerArgOverride = buildQueueOwnerArgOverride(fileURLToPath(import.meta.url));
  if (queueOwnerArgOverride) {
    process.env.ACPX_QUEUE_OWNER_ARGS ??= queueOwnerArgOverride;
  }

  void main(process.argv).catch(handleMainRejection);
}
