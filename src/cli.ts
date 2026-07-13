#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "./cli-core.js";
import { handleMainRejection, handleStreamError } from "./cli-fatal.js";
import { buildQueueOwnerArgOverride } from "./cli/session/queue-owner-process.js";

export { formatPromptSessionBannerLine } from "./cli-core.js";
export { parseAllowedTools, parseMaxTurns, parseTtlSeconds } from "./cli/flags.js";

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
