#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "./cli-core.js";
import { installBrokenPipeHandler } from "./cli/broken-pipe.js";
import { buildQueueOwnerArgOverride } from "./cli/session/queue-owner-process.js";

export { formatPromptSessionBannerLine } from "./cli-core.js";
export { parseAllowedTools, parseMaxTurns, parseTtlSeconds } from "./cli/flags.js";

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
  const isQueueOwner = process.argv[2] === "__queue-owner";
  installBrokenPipeHandler(process.stdout, "exit");
  // After the submitting CLI exits, a detached owner loses its stderr reader.
  // Ignore that expected EPIPE so later diagnostics cannot kill the owner.
  installBrokenPipeHandler(process.stderr, isQueueOwner ? "ignore" : "exit");

  const queueOwnerArgOverride = buildQueueOwnerArgOverride(fileURLToPath(import.meta.url));
  if (queueOwnerArgOverride) {
    process.env.ACPX_QUEUE_OWNER_ARGS ??= queueOwnerArgOverride;
  }

  void main(process.argv);
}
