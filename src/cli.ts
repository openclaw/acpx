#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "./cli-core.js";
import { buildQueueOwnerArgOverride } from "./cli/session/queue-owner-process.js";

export { formatPromptSessionBannerLine } from "./cli-core.js";
export { parseAllowedTools, parseMaxTurns, parseTtlSeconds } from "./cli/flags.js";

function installBrokenPipeHandler(stream: NodeJS.WritableStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }

    // Event-emitter throws become uncaughtException. Surface and exit instead.
    try {
      process.stderr.write(`[acpx] stream error: ${error.message}\n`);
    } catch {
      // ignore secondary write failures
    }
    process.exit(1);
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

  void main(process.argv).catch((error: unknown) => {
    // Avoid unhandled promise rejections for top-level CLI failures.
    // Commander parse errors are already handled inside main(); this
    // catches unexpected throws and stream-handler rethrows.
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`[acpx] ${message}\n`);
    } catch {
      // stderr may already be broken
    }
    process.exitCode = 1;
  });
}
