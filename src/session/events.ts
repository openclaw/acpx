import fs from "node:fs/promises";
import { appendRegularFile } from "@openclaw/fs-safe/advanced";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { incrementPerfCounter, measurePerf } from "../perf-metrics.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import {
  DEFAULT_EVENT_MAX_SEGMENTS,
  DEFAULT_EVENT_SEGMENT_MAX_BYTES,
  sessionBaseDir,
  sessionEventActivePath as activeEventPath,
  sessionEventSegmentPath as segmentEventPath,
} from "./event-log.js";
import {
  SESSION_JOURNAL_SCHEMA,
  SessionJournalReader,
  type SessionJournalMarker,
  type SessionWatchResult,
} from "./journal.js";
import { resolveSessionRecord, writeSessionRecord } from "./persistence.js";

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true, mode: 0o700 });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countExistingSegments(sessionId: string, maxSegments: number): Promise<number> {
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

async function resolveInitialSegmentCount(
  record: SessionRecord,
  maxSegments: number,
): Promise<number> {
  if (Number.isInteger(record.eventLog.segment_count) && record.eventLog.segment_count > 0) {
    return record.eventLog.segment_count;
  }
  return (await countExistingSegments(record.acpxRecordId, maxSegments)) || 1;
}

async function resolveSessionMaxSegments(sessionId: string): Promise<number> {
  try {
    const record = await resolveSessionRecord(sessionId);
    const configured = record.eventLog.max_segments;
    if (Number.isInteger(configured) && configured > 0) {
      return configured;
    }
  } catch {
    // Fall back to defaults when metadata is unavailable.
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

type SessionEventWriterOptions = {
  maxSegmentBytes?: number;
  maxSegments?: number;
};

type AppendOptions = {
  checkpoint?: boolean;
};

export class SessionEventWriter {
  private readonly record: SessionRecord;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private readonly activePath: string;
  private activeSizeBytes: number;
  private segmentCount: number;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  private appendFailure?: { error: unknown };
  private sequence: number;
  private requestId: string | null;
  private recoveryPending: boolean;
  private needsAnchor: boolean;
  private needsRotation: boolean;
  private activeEntries: number;

  private constructor(
    record: SessionRecord,
    options: Required<SessionEventWriterOptions>,
    state: {
      activePath: string;
      activeSizeBytes: number;
      segmentCount: number;
      sequence: number;
      requestId: string | null;
      anchored: boolean;
      partial: boolean;
    },
  ) {
    this.record = record;
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxSegments = options.maxSegments;
    this.activePath = state.activePath;
    this.activeSizeBytes = state.activeSizeBytes;
    this.segmentCount = state.segmentCount;
    this.sequence = state.sequence;
    this.requestId = state.requestId;
    this.recoveryPending = state.requestId !== null;
    this.needsAnchor = !state.anchored;
    this.needsRotation = state.activeSizeBytes > 0 && (!state.anchored || state.partial);
    this.activeEntries = state.anchored ? 1 : 0;
  }

  static async open(
    record: SessionRecord,
    options: SessionEventWriterOptions = {},
  ): Promise<SessionEventWriter> {
    const maxSegmentBytes =
      options.maxSegmentBytes ??
      record.eventLog.max_segment_bytes ??
      DEFAULT_EVENT_SEGMENT_MAX_BYTES;
    const maxSegments =
      options.maxSegments ?? record.eventLog.max_segments ?? DEFAULT_EVENT_MAX_SEGMENTS;
    const activePath = activeEventPath(record.acpxRecordId);
    const tail = await new SessionJournalReader({
      ...record,
      eventLog: { ...record.eventLog, max_segments: maxSegments },
    }).readTail();
    if (tail.messageSequence !== undefined) {
      record.lastSeq = tail.messageSequence;
    }
    const segmentCount = await resolveInitialSegmentCount(record, maxSegments);
    return new SessionEventWriter(
      record,
      {
        maxSegmentBytes,
        maxSegments,
      },
      {
        activePath,
        activeSizeBytes: tail.activeSize,
        segmentCount,
        sequence: tail.sequence,
        requestId: tail.requestId,
        anchored: tail.activeAnchored,
        partial: tail.activePartial,
      },
    );
  }

  getRecord(): SessionRecord {
    return this.record;
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("SessionEventWriter is closed"));
    }
    const operation = this.pending.then(run);
    this.pending = operation.catch(() => {});
    return operation;
  }

  async beginTurn(requestId: string): Promise<void> {
    if (!requestId) {
      throw new Error("Session journal request ID must not be empty");
    }
    await this.enqueue(async () => {
      if (this.requestId !== null) {
        if (!this.recoveryPending) {
          throw new Error("A session journal turn is already active");
        }
        await this.appendEntry({
          schema: SESSION_JOURNAL_SCHEMA,
          type: "turn_result",
          request_id: this.requestId,
          result: {
            status: "failed",
            error: {
              message:
                "The previous owner ended without recording a settled result; the turn outcome is unknown.",
              detailCode: "WATCH_OUTCOME_UNKNOWN",
              retryable: false,
            },
          },
        });
        this.requestId = null;
      }
      this.recoveryPending = false;
      await this.appendEntry({
        schema: SESSION_JOURNAL_SCHEMA,
        type: "turn_started",
        request_id: requestId,
      });
      this.requestId = requestId;
    });
  }

  async finishTurn(requestId: string, result: SessionWatchResult): Promise<void> {
    await this.enqueue(async () => {
      if (requestId !== this.requestId) {
        throw new Error("Session journal result does not match the active request");
      }
      await this.appendEntry({
        schema: SESSION_JOURNAL_SCHEMA,
        type: "turn_result",
        request_id: requestId,
        result,
      });
      this.requestId = null;
    });
  }

  async appendMessage(message: AcpJsonRpcMessage, options: AppendOptions = {}): Promise<void> {
    await this.appendMessages([message], options);
  }

  async appendMessages(messages: AcpJsonRpcMessage[], options: AppendOptions = {}): Promise<void> {
    await this.enqueue(async () => {
      await measurePerf("session.events.append_batch", async () => {
        for (const message of messages) {
          if (!isAcpJsonRpcMessage(message)) {
            throw new Error("Attempted to persist invalid ACP JSON-RPC payload");
          }
          await this.appendEntry(message);
          this.record.lastSeq += 1;
          if (Object.hasOwn(message, "id")) {
            const id = (message as { id?: unknown }).id;
            if (typeof id === "string" || typeof id === "number") {
              this.record.lastRequestId = String(id);
            }
          }
        }
      });
      if (options.checkpoint === true) {
        await writeSessionRecord(this.record);
      }
    });
  }

  private async appendEntry(entry: AcpJsonRpcMessage | SessionJournalMarker): Promise<void> {
    if (this.appendFailure) {
      throw this.appendFailure.error;
    }
    try {
      await this.writeEntry(entry);
    } catch (error) {
      // A checkpoint can recover; an incomplete append needs a newly recovered writer.
      this.appendFailure = { error };
      throw error;
    }
  }

  private async writeEntry(entry: AcpJsonRpcMessage | SessionJournalMarker): Promise<void> {
    if (!Number.isSafeInteger(this.sequence + 1)) {
      throw new Error("Session journal sequence exceeds its supported range");
    }
    await ensureSessionDir();
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (
      this.needsRotation ||
      (this.activeEntries > 0 && this.activeSizeBytes + lineBytes > this.maxSegmentBytes)
    ) {
      await rotateSegments(this.record.acpxRecordId, this.maxSegments);
      this.activeSizeBytes = 0;
      this.activeEntries = 0;
      this.needsAnchor = true;
      this.needsRotation = false;
      this.segmentCount = Math.min(this.segmentCount + 1, this.maxSegments);
      incrementPerfCounter("session.events.rotate");
    }
    if (this.needsAnchor) {
      const anchor: SessionJournalMarker = {
        schema: SESSION_JOURNAL_SCHEMA,
        type: "segment",
        record_id: this.record.acpxRecordId,
        sequence: this.sequence,
        message_sequence: this.record.lastSeq,
        request_id: this.requestId,
      };
      const header = `${JSON.stringify(anchor)}\n`;
      await appendRegularFile({ filePath: this.activePath, content: header, mode: 0o600 });
      this.activeSizeBytes += Buffer.byteLength(header);
      this.needsAnchor = false;
    }
    await appendRegularFile({ filePath: this.activePath, content: line, mode: 0o600 });
    this.activeSizeBytes += lineBytes;
    this.activeEntries += 1;
    this.sequence += 1;
    const writeTs = new Date().toISOString();
    this.record.lastUsedAt = writeTs;
    this.record.eventLog = {
      active_path: this.activePath,
      segment_count: this.segmentCount,
      max_segment_bytes: this.maxSegmentBytes,
      max_segments: this.maxSegments,
      last_write_at: writeTs,
      last_write_error: null,
    };
  }

  async checkpoint(): Promise<void> {
    await this.enqueue(async () => await writeSessionRecord(this.record));
  }

  async close(options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.pending;
    if (this.appendFailure) {
      throw this.appendFailure.error;
    }
    if (options.checkpoint !== false) {
      await writeSessionRecord(this.record);
    }
  }
}

export async function listSessionEvents(
  sessionId: string,
  maxSegments?: number,
): Promise<AcpJsonRpcMessage[]> {
  maxSegments ??= await resolveSessionMaxSegments(sessionId);
  return await new SessionJournalReader({
    acpxRecordId: sessionId,
    eventLog: { max_segments: maxSegments },
  }).readAcpMessages();
}
