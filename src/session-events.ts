import fs from "node:fs/promises";
import { createAcpxEvent, isAcpxEvent } from "./events.js";
import { assertPersistedKeyPolicy } from "./persisted-key-policy.js";
import {
  DEFAULT_EVENT_MAX_SEGMENTS,
  DEFAULT_EVENT_SEGMENT_MAX_BYTES,
  sessionBaseDir,
  sessionEventActivePath as activeEventPath,
  sessionEventLockPath as eventsLockPath,
  sessionEventSegmentPath as segmentEventPath,
} from "./session-event-log.js";
import { resolveSessionRecord, writeSessionRecord } from "./session-persistence.js";
import type { AcpxEvent, AcpxEventDraft, SessionRecord } from "./types.js";

const LOCK_RETRY_MS = 15;

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

async function countExistingEventSegments(
  sessionId: string,
  maxSegments: number,
): Promise<number> {
  let count = 0;

  for (let segment = 1; segment <= maxSegments; segment += 1) {
    if (await pathExists(segmentEventPath(sessionId, segment))) {
      count += 1;
    }
  }

  if (await pathExists(activeEventPath(sessionId))) {
    count += 1;
  }

  return count;
}

async function resolveSessionMaxSegments(sessionId: string): Promise<number> {
  try {
    const record = await resolveSessionRecord(sessionId);
    const configured = record.eventLog.max_segments;
    if (Number.isInteger(configured) && configured > 0) {
      return configured;
    }
  } catch {
    // Fall back to default when session metadata is unavailable.
  }

  return DEFAULT_EVENT_MAX_SEGMENTS;
}

async function rotateSegments(sessionId: string, maxSegments: number): Promise<void> {
  const active = activeEventPath(sessionId);

  const overflow = segmentEventPath(sessionId, maxSegments);
  await fs.unlink(overflow).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });

  for (let segment = maxSegments - 1; segment >= 1; segment -= 1) {
    const from = segmentEventPath(sessionId, segment);
    const to = segmentEventPath(sessionId, segment + 1);
    if (!(await pathExists(from))) {
      continue;
    }
    await fs.rename(from, to);
  }

  if (await pathExists(active)) {
    await fs.rename(active, segmentEventPath(sessionId, 1));
  }
}

type LockHandle = {
  filePath: string;
};

async function acquireEventsLock(sessionId: string): Promise<LockHandle> {
  await ensureSessionDir();
  const lockPath = eventsLockPath(sessionId);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      created_at: new Date().toISOString(),
    },
    null,
    2,
  );

  for (;;) {
    try {
      await fs.writeFile(lockPath, `${payload}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { filePath: lockPath };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }
  }
}

async function releaseEventsLock(lock: LockHandle): Promise<void> {
  await fs.unlink(lock.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

type SessionEventWriterOptions = {
  maxSegmentBytes?: number;
  maxSegments?: number;
};

type AppendOptions = {
  checkpoint?: boolean;
};

export class SessionEventWriter {
  private readonly record: SessionRecord;
  private readonly lock: LockHandle;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private nextSeq: number;
  private closed = false;

  private constructor(
    record: SessionRecord,
    lock: LockHandle,
    options: Required<SessionEventWriterOptions>,
  ) {
    this.record = record;
    this.lock = lock;
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxSegments = options.maxSegments;
    this.nextSeq = record.lastSeq + 1;
  }

  static async open(
    record: SessionRecord,
    options: SessionEventWriterOptions = {},
  ): Promise<SessionEventWriter> {
    const lock = await acquireEventsLock(record.acpxRecordId);
    return new SessionEventWriter(record, lock, {
      maxSegmentBytes:
        options.maxSegmentBytes ??
        record.eventLog.max_segment_bytes ??
        DEFAULT_EVENT_SEGMENT_MAX_BYTES,
      maxSegments:
        options.maxSegments ??
        record.eventLog.max_segments ??
        DEFAULT_EVENT_MAX_SEGMENTS,
    });
  }

  getRecord(): SessionRecord {
    return this.record;
  }

  createEvent(draft: AcpxEventDraft): AcpxEvent {
    const event = createAcpxEvent(
      {
        sessionId: this.record.acpxRecordId,
        acpSessionId: this.record.acpSessionId,
        agentSessionId: this.record.agentSessionId,
        requestId: draft.request_id,
        seq: this.nextSeq,
      },
      draft,
    );
    this.nextSeq += 1;
    return event;
  }

  async appendEvent(event: AcpxEvent, options: AppendOptions = {}): Promise<void> {
    await this.appendEvents([event], options);
  }

  async appendEvents(events: AcpxEvent[], options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }

    if (events.length === 0) {
      return;
    }

    await ensureSessionDir();
    let activePath = activeEventPath(this.record.acpxRecordId);

    for (const event of events) {
      if (!isAcpxEvent(event)) {
        throw new Error("Attempted to persist invalid acpx.event.v1 payload");
      }

      if (event.seq !== this.record.lastSeq + 1) {
        throw new Error(
          `acpx event sequence mismatch: expected ${this.record.lastSeq + 1}, got ${event.seq}`,
        );
      }

      assertPersistedKeyPolicy(event);

      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line);
      const currentSize = await statSize(activePath);
      if (currentSize > 0 && currentSize + lineBytes > this.maxSegmentBytes) {
        await rotateSegments(this.record.acpxRecordId, this.maxSegments);
        activePath = activeEventPath(this.record.acpxRecordId);
      }

      await fs.appendFile(activePath, line, "utf8");

      this.record.lastSeq = event.seq;
      if (event.seq >= this.nextSeq) {
        this.nextSeq = event.seq + 1;
      }
      this.record.lastRequestId = event.request_id ?? this.record.lastRequestId;
      this.record.lastUsedAt = event.ts;
      this.record.eventLog = {
        active_path: activePath,
        segment_count: await countExistingEventSegments(
          this.record.acpxRecordId,
          this.maxSegments,
        ),
        max_segment_bytes: this.maxSegmentBytes,
        max_segments: this.maxSegments,
        last_write_at: event.ts,
        last_write_error: null,
      };
    }

    if (options.checkpoint === true) {
      await writeSessionRecord(this.record);
    }
  }

  async appendDraft(
    draft: AcpxEventDraft,
    options: AppendOptions = {},
  ): Promise<AcpxEvent> {
    const event = this.createEvent(draft);
    await this.appendEvent(event, options);
    return event;
  }

  async appendDrafts(
    drafts: AcpxEventDraft[],
    options: AppendOptions = {},
  ): Promise<AcpxEvent[]> {
    const events = drafts.map((draft) => this.createEvent(draft));
    await this.appendEvents(events, options);
    return events;
  }

  async checkpoint(): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }
    await writeSessionRecord(this.record);
  }

  async close(options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (options.checkpoint !== false) {
        await writeSessionRecord(this.record);
      }
    } finally {
      this.closed = true;
      await releaseEventsLock(this.lock);
    }
  }
}

export async function listSessionEvents(sessionId: string): Promise<AcpxEvent[]> {
  const maxSegments = await resolveSessionMaxSegments(sessionId);
  const files: string[] = [];

  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    const filePath = segmentEventPath(sessionId, segment);
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }

  const active = activeEventPath(sessionId);
  if (await pathExists(active)) {
    files.push(active);
  }

  const events: AcpxEvent[] = [];
  for (const filePath of files) {
    const payload = await fs.readFile(filePath, "utf8");
    const lines = payload.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (isAcpxEvent(parsed)) {
        events.push(parsed);
      }
    }
  }

  return events;
}
