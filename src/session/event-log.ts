import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionEventLog } from "../types.js";

export const DEFAULT_EVENT_SEGMENT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EVENT_MAX_SEGMENTS = 5;
/** Upper bound stored for a newly imported journal. */
export const MAX_EVENT_SEGMENTS = 1024;

export function retainedEventMaxSegments(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 0;
  }
  // Saved policies accept larger integers than exact segment-index arithmetic does.
  return Math.floor(value);
}

export function boundedEventMaxSegments(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_EVENT_SEGMENTS);
}

export function sessionBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "sessions");
}

export function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function sessionEventActivePath(sessionId: string): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.ndjson`);
}

export function sessionEventSegmentPath(sessionId: string, segment: number): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.${segment}.ndjson`);
}

export function sessionEventLockPath(sessionId: string): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.lock`);
}

export async function existingEventSegmentIndices(sessionId: string): Promise<number[]> {
  return (await sessionEventFiles(sessionId)).indices;
}

export async function sessionEventFiles(
  sessionId: string,
): Promise<{ indices: number[]; active: boolean }> {
  const activeName = `${safeSessionId(sessionId)}.stream.ndjson`;
  const indices: number[] = [];
  let active = false;
  for (const name of await readSessionDirNames()) {
    if (name === activeName) {
      active = true;
      continue;
    }
    const index = eventSegmentIndex(sessionId, name);
    if (index !== undefined) {
      indices.push(index);
    }
  }
  return { indices, active };
}

async function readSessionDirNames(): Promise<string[]> {
  try {
    return await fs.readdir(sessionBaseDir());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function eventSegmentIndex(sessionId: string, name: string): number | undefined {
  const prefix = `${safeSessionId(sessionId)}.stream.`;
  const suffix = ".ndjson";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return undefined;
  }
  const middle = name.slice(prefix.length, -suffix.length);
  if (!/^[1-9]\d*$/.test(middle)) {
    return undefined;
  }
  const index = Number(middle);
  return Number.isSafeInteger(index) ? index : undefined;
}

export function defaultSessionEventLog(sessionId: string): SessionEventLog {
  return {
    active_path: sessionEventActivePath(sessionId),
    segment_count: DEFAULT_EVENT_MAX_SEGMENTS,
    max_segment_bytes: DEFAULT_EVENT_SEGMENT_MAX_BYTES,
    max_segments: DEFAULT_EVENT_MAX_SEGMENTS,
    last_write_at: undefined,
    last_write_error: null,
  };
}
