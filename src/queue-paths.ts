import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function queueKeyForSession(sessionId: string): string {
  return shortHash(sessionId, 24);
}

export function queueBaseDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "queues");
}

export function queueSocketBaseDir(homeDir: string = os.homedir()): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  return path.join("/tmp", `acpx-${shortHash(homeDir, 10)}`);
}

export function queueLockFilePath(sessionId: string, homeDir: string = os.homedir()): string {
  return path.join(queueBaseDir(homeDir), `${queueKeyForSession(sessionId)}.lock`);
}

export function queueSocketPath(sessionId: string, homeDir: string = os.homedir()): string {
  const key = queueKeyForSession(sessionId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acpx-${key}`;
  }
  return path.join(queueSocketBaseDir(homeDir) ?? "/tmp", `${key}.sock`);
}
