import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "../types.js";

export type QueueOwnerRuntimeOptions = {
  sessionId: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
};

type SessionSendLike = {
  sessionId: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
};

export function resolveQueueOwnerMainPath(baseUrl: string = import.meta.url): string {
  // In tsc output, queue-owner-process.js lives in `session-runtime/` and the
  // entrypoint is `../queue-owner-main.js`. In tsup bundle output, this code is
  // emitted into `dist/chunk-*.js`, so the entrypoint is `./queue-owner-main.js`.
  const candidates = [
    fileURLToPath(new URL("../queue-owner-main.js", baseUrl)),
    fileURLToPath(new URL("./queue-owner-main.js", baseUrl)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

const QUEUE_OWNER_MAIN_PATH = resolveQueueOwnerMainPath();

export function queueOwnerRuntimeOptionsFromSend(
  options: SessionSendLike,
): QueueOwnerRuntimeOptions {
  return {
    sessionId: options.sessionId,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    ttlMs: options.ttlMs,
  };
}

export function spawnQueueOwnerProcess(options: QueueOwnerRuntimeOptions): void {
  const payload = JSON.stringify(options);
  const child = spawn(process.execPath, [QUEUE_OWNER_MAIN_PATH], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ACPX_QUEUE_OWNER_PAYLOAD: payload,
    },
  });
  child.unref();
}
