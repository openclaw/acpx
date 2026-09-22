import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root, type OpenResult } from "@openclaw/fs-safe";
import { statRegularFile } from "@openclaw/fs-safe/advanced";
import { z } from "zod";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { AcpxOperationalError } from "../errors.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import { sessionEventActivePath, sessionEventSegmentPath } from "./event-log.js";

export type SessionWatchResult =
  | {
      status: "completed" | "cancelled";
      stopReason?: string;
      _meta?: Record<string, unknown> | null;
    }
  | {
      status: "failed";
      error: { message: string; code?: string; detailCode?: string; retryable?: boolean };
    };

export type SessionWatchEvent = { cursor: string } & (
  | { type: "message"; requestId: string | null; message: AcpJsonRpcMessage }
  | { type: "turn_started"; requestId: string }
  | { type: "turn_result"; requestId: string; result: SessionWatchResult }
);

export const SESSION_JOURNAL_SCHEMA = "acpx.session.journal.v1";
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resultSchema = z.union([
  z.object({
    status: z.enum(["completed", "cancelled"]),
    stopReason: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
      detailCode: z.string().optional(),
      retryable: z.boolean().optional(),
    }),
  }),
]);
const markerSchema = z.discriminatedUnion("type", [
  z.object({
    schema: z.literal(SESSION_JOURNAL_SCHEMA),
    type: z.literal("segment"),
    record_id: z.string(),
    sequence: sequenceSchema,
    message_sequence: sequenceSchema,
    request_id: z.string().nullable(),
  }),
  z.object({
    schema: z.literal(SESSION_JOURNAL_SCHEMA),
    type: z.literal("turn_started"),
    request_id: z.string().min(1),
  }),
  z.object({
    schema: z.literal(SESSION_JOURNAL_SCHEMA),
    type: z.literal("turn_result"),
    request_id: z.string().min(1),
    result: resultSchema,
  }),
]);

export type SessionJournalMarker = z.infer<typeof markerSchema>;
type JournalEvent = SessionWatchEvent & { sequence: number };
type JournalPage = { events: JournalEvent[]; after: number; bytes: number; maxBytes: number };
type JournalReadOptions = { after?: number; maxBytes?: number };
const WATCH_PAGE_BYTES = 1024 * 1024;

function createJournalPage(options: JournalReadOptions = {}): JournalPage {
  const maxBytes = options.maxBytes ?? Infinity;
  if (!(maxBytes > 0)) {
    throw new Error("Session journal page size must be positive");
  }
  return { events: [], after: options.after ?? -1, bytes: 0, maxBytes };
}

function pageFull(page: JournalPage | undefined): boolean {
  return page !== undefined && page.bytes >= page.maxBytes;
}

function eventSink(
  page: JournalPage | undefined,
  sequence: number,
  bytes: number,
): JournalEvent[] | undefined {
  if (!page || sequence <= page.after) {
    return undefined;
  }
  page.bytes += bytes;
  return page.events;
}

export class SessionWatchError extends AcpxOperationalError {
  constructor(
    readonly code:
      | "WATCH_CURSOR_INVALID"
      | "WATCH_CURSOR_FOREIGN"
      | "WATCH_CURSOR_EXPIRED"
      | "WATCH_CURSOR_FUTURE"
      | "WATCH_OWNER_UNSUPPORTED"
      | "WATCH_OUTCOME_UNKNOWN"
      | "WATCH_JOURNAL_CORRUPT",
    message: string,
  ) {
    super(message, {
      outputCode: code.startsWith("WATCH_CURSOR_") ? "USAGE" : "RUNTIME",
      detailCode: code,
      origin: "runtime",
      retryable: false,
    });
  }
}

function corrupt(message: string): never {
  throw new SessionWatchError("WATCH_JOURNAL_CORRUPT", message);
}

function sessionWatchCursor(recordId: string, sequence: number): string {
  return Buffer.from(JSON.stringify([recordId, sequence])).toString("base64url");
}

function parseCursor(recordId: string, cursor: string): number {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new SessionWatchError("WATCH_CURSOR_INVALID", "Invalid session watch cursor");
  }
  const parsed = z.tuple([z.string(), sequenceSchema]).safeParse(value);
  if (!parsed.success || sessionWatchCursor(...parsed.data) !== cursor) {
    throw new SessionWatchError("WATCH_CURSOR_INVALID", "Invalid session watch cursor");
  }
  if (parsed.data[0] !== recordId) {
    throw new SessionWatchError("WATCH_CURSOR_FOREIGN", "Cursor belongs to another session");
  }
  return parsed.data[1];
}

type OpenSegment = { filePath: string; opened: OpenResult; identity: string };
type SegmentState = {
  offset: number;
  pending: Buffer;
  firstSequence?: number;
  sequence: number;
  messageSequence: number;
  requestId: string | null;
};

function fileIdentity(stat: BigIntStats): string {
  // Numeric inode receipts can alias distinct files and transfer a cached read offset.
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

async function pathIdentity(filePath: string): Promise<string | undefined> {
  try {
    return fileIdentity(await fs.lstat(filePath, { bigint: true }));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function emptySegment(): SegmentState {
  return { offset: 0, pending: Buffer.alloc(0), sequence: 0, messageSequence: 0, requestId: null };
}

function retryableSnapshotError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "not-found" || error.code === "path-mismatch")
  );
}

export class SessionJournalReader {
  private readonly states = new Map<string, SegmentState>();

  constructor(
    private readonly record: { acpxRecordId: string; eventLog: { max_segments: number } },
  ) {}

  private paths(): string[] {
    const paths: string[] = [];
    for (let index = this.record.eventLog.max_segments; index > 0; index -= 1) {
      paths.push(sessionEventSegmentPath(this.record.acpxRecordId, index));
    }
    paths.push(sessionEventActivePath(this.record.acpxRecordId));
    return paths;
  }

  private async openSnapshot(signal?: AbortSignal): Promise<OpenSegment[]> {
    for (;;) {
      signal?.throwIfAborted();
      const segments: OpenSegment[] = [];
      try {
        const paths = await this.openPresentSegments(segments);
        // Pin all files before reading: path renumbering must not skip or duplicate a segment.
        const current = await Promise.all(paths.map(pathIdentity));
        const identities = new Map(segments.map((entry) => [entry.filePath, entry.identity]));
        if (paths.every((filePath, index) => current[index] === identities.get(filePath))) {
          return segments;
        }
      } catch (error) {
        if (!retryableSnapshotError(error)) {
          await this.closeSnapshot(segments);
          throw error;
        }
      }
      await this.closeSnapshot(segments);
      await delay(5, undefined, { signal });
    }
  }

  private async openPresentSegments(segments: OpenSegment[]): Promise<string[]> {
    const paths = this.paths();
    const present = await Promise.all(paths.map((filePath) => statRegularFile(filePath)));
    if (present.every((entry) => entry.missing)) {
      return paths;
    }
    const directory = await root(path.dirname(paths[0]));
    const results = await Promise.allSettled(
      paths
        .filter((_, index) => !present[index].missing)
        .map(async (filePath) => {
          const opened = await directory.open(path.basename(filePath), {
            symlinks: "reject",
            nonBlockingRead: true,
          });
          try {
            const identity = fileIdentity(await opened.handle.stat({ bigint: true }));
            return { filePath, opened, identity };
          } catch (error) {
            // Failed entries never reach the snapshot's shared descriptor cleanup.
            await opened[Symbol.asyncDispose]();
            throw error;
          }
        }),
    );
    let failure: unknown;
    for (const result of results) {
      if (result.status === "fulfilled") {
        segments.push(result.value);
      } else {
        failure ??= result.reason;
      }
    }
    if (failure) {
      throw failure;
    }
    return paths;
  }

  private async closeSnapshot(segments: OpenSegment[]): Promise<void> {
    await Promise.all(segments.map(({ opened }) => opened[Symbol.asyncDispose]()));
  }

  async readAcpMessages(): Promise<AcpJsonRpcMessage[]> {
    const segments = await this.openSnapshot();
    const messages: AcpJsonRpcMessage[] = [];
    try {
      for (const { opened } of segments) {
        const payload = await opened.handle.readFile("utf8");
        for (const line of payload.split("\n")) {
          try {
            const value: unknown = JSON.parse(line);
            if (isAcpJsonRpcMessage(value)) {
              messages.push(value);
            }
          } catch {
            // Preserve the existing ACP-only snapshot tolerance for malformed lines.
          }
        }
      }
      return messages;
    } finally {
      await this.closeSnapshot(segments);
    }
  }

  async readTail(): Promise<{
    sequence: number;
    messageSequence?: number;
    requestId: string | null;
    activeSize: number;
    activeAnchored: boolean;
    activePartial: boolean;
  }> {
    const segments = await this.openSnapshot();
    let tail = emptySegment();
    let active = emptySegment();
    try {
      // A segment anchor makes recovery independent of the rest of retained history.
      for (const segment of segments.toReversed()) {
        const state = emptySegment();
        await this.readSegment(segment.opened.handle, segment.opened.stat.size, state, undefined);
        if (segment.filePath === sessionEventActivePath(this.record.acpxRecordId)) {
          active = state;
        }
        if (state.firstSequence !== undefined) {
          tail = state;
          break;
        }
      }
      return {
        sequence: tail.sequence,
        messageSequence: tail.firstSequence === undefined ? undefined : tail.messageSequence,
        requestId: tail.requestId,
        activeSize: active.offset,
        activeAnchored: active.firstSequence !== undefined,
        activePartial: active.pending.length > 0,
      };
    } finally {
      await this.closeSnapshot(segments);
    }
  }

  async read(
    signal?: AbortSignal,
    options?: JournalReadOptions,
  ): Promise<{
    events: JournalEvent[];
    hasMore: boolean;
    firstSequence?: number;
    sequence: number;
    messageSequence: number;
    requestId: string | null;
    activeSize: number;
    activeAnchored: boolean;
    activePartial: boolean;
  }> {
    const page = createJournalPage(options);
    const segments = await this.openSnapshot(signal);
    let hasMore = false;
    let firstSequence: number | undefined;
    let tail = emptySegment();
    let active = emptySegment();
    try {
      for (const segment of segments) {
        const state = this.states.get(segment.identity) ?? emptySegment();
        await this.readSegment(
          segment.opened.handle,
          segment.opened.stat.size,
          state,
          page,
          signal,
        );
        this.states.set(segment.identity, state);
        if (state.firstSequence !== undefined) {
          if (firstSequence === undefined) {
            firstSequence = state.firstSequence;
          } else if (state.firstSequence !== tail.sequence) {
            corrupt("Session journal segments are not contiguous");
          }
          tail = state;
        }
        if (segment.filePath === sessionEventActivePath(this.record.acpxRecordId)) {
          active = state;
        }
        if (pageFull(page)) {
          hasMore = true;
          break;
        }
      }
      this.pruneStates(segments);
      return {
        events: page.events,
        hasMore,
        firstSequence,
        sequence: tail.sequence,
        messageSequence: tail.messageSequence,
        requestId: tail.requestId,
        activeSize: active.offset,
        activeAnchored: active.firstSequence !== undefined,
        activePartial: active.pending.length > 0,
      };
    } finally {
      await this.closeSnapshot(segments);
    }
  }

  private pruneStates(segments: OpenSegment[]): void {
    const retained = new Set(segments.map((entry) => entry.identity));
    for (const identity of this.states.keys()) {
      if (!retained.has(identity)) {
        this.states.delete(identity);
      }
    }
  }

  private async readSegment(
    handle: FileHandle,
    size: number,
    state: SegmentState,
    page: JournalPage | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (size < state.offset) {
      corrupt("Session journal was truncated while watching");
    }
    const buffer = Buffer.alloc(Math.min(64 * 1024, size - state.offset));
    for (;;) {
      signal?.throwIfAborted();
      this.consumePending(state, page);
      if (pageFull(page) || state.offset >= size) {
        return;
      }
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - state.offset),
        state.offset,
      );
      if (bytesRead === 0) {
        corrupt("Session journal changed while reading");
      }
      state.offset += bytesRead;
      state.pending = Buffer.concat([state.pending, buffer.subarray(0, bytesRead)]);
    }
  }

  private consumePending(state: SegmentState, page: JournalPage | undefined): void {
    const pending = state.pending;
    let start = 0;
    for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
      this.consumeLine(pending.subarray(start, end).toString("utf8"), state, page, end - start + 1);
      start = end + 1;
      if (pageFull(page)) {
        break;
      }
    }
    state.pending = Buffer.from(pending.subarray(start));
  }

  private consumeLine(
    line: string,
    state: SegmentState,
    page: JournalPage | undefined,
    bytes: number,
  ): void {
    const entry = decodeJournalLine(line, state.firstSequence !== undefined);
    if (!entry) {
      return;
    }
    if (entry.type === "marker") {
      this.consumeMarker(entry.marker, state, page, bytes);
      return;
    }
    if (state.firstSequence === undefined) {
      return;
    }
    this.advance(state);
    state.messageSequence += 1;
    eventSink(page, state.sequence, bytes)?.push({
      ...this.eventPosition(state),
      type: "message",
      requestId: state.requestId,
      message: entry.message,
    });
  }

  private advance(state: SegmentState): void {
    state.sequence += 1;
    if (!Number.isSafeInteger(state.sequence)) {
      corrupt("Session journal sequence exceeds its supported range");
    }
  }

  private eventPosition(state: SegmentState): { sequence: number; cursor: string } {
    return {
      sequence: state.sequence,
      cursor: sessionWatchCursor(this.record.acpxRecordId, state.sequence),
    };
  }

  private consumeMarker(
    marker: SessionJournalMarker,
    state: SegmentState,
    page: JournalPage | undefined,
    bytes: number,
  ): void {
    if (marker.type === "segment") {
      this.acceptAnchor(marker, state);
      return;
    }
    if (state.firstSequence === undefined) {
      corrupt("Session journal lifecycle record has no segment anchor");
    }
    this.advance(state);
    if (marker.type === "turn_started") {
      state.requestId = marker.request_id;
      eventSink(page, state.sequence, bytes)?.push({
        ...this.eventPosition(state),
        type: "turn_started",
        requestId: state.requestId,
      });
    } else {
      if (state.requestId !== marker.request_id) {
        corrupt("Session journal result does not match the active request");
      }
      eventSink(page, state.sequence, bytes)?.push({
        ...this.eventPosition(state),
        type: "turn_result",
        requestId: state.requestId,
        result: marker.result,
      });
      state.requestId = null;
    }
  }

  private acceptAnchor(
    anchor: Extract<SessionJournalMarker, { type: "segment" }>,
    state: SegmentState,
  ): void {
    if (state.firstSequence !== undefined || anchor.record_id !== this.record.acpxRecordId) {
      corrupt("Invalid session journal segment anchor");
    }
    state.firstSequence = anchor.sequence;
    state.sequence = anchor.sequence;
    state.messageSequence = anchor.message_sequence;
    state.requestId = anchor.request_id;
  }
}

function decodeJournalLine(
  line: string,
  anchored: boolean,
):
  | { type: "message"; message: AcpJsonRpcMessage }
  | { type: "marker"; marker: SessionJournalMarker }
  | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    if (anchored) {
      corrupt("Invalid complete line in session journal");
    }
    return undefined;
  }
  if (isAcpJsonRpcMessage(value)) {
    return { type: "message", message: value };
  }
  const marker = markerSchema.safeParse(value);
  if (marker.success) {
    return { type: "marker", marker: marker.data };
  }
  if (anchored || hasJournalSchema(value)) {
    corrupt("Invalid record in session journal");
  }
  return undefined;
}

function hasJournalSchema(value: unknown): boolean {
  return value !== null && typeof value === "object" && "schema" in value;
}

type WatchSessionOptions = {
  record: SessionRecord | Promise<SessionRecord>;
  cursor?: string;
  signal?: AbortSignal;
  continueWatching?: (record: SessionRecord, pendingRequestId: string | null) => Promise<boolean>;
};

type WatchPage = {
  hasMore: boolean;
  requestId: string | null;
  events: readonly JournalEvent[];
};
type WatchObservation = {
  terminal?: { requestId: string | null; error?: SessionWatchError };
};

export function watchSession(options: WatchSessionOptions): AsyncIterable<SessionWatchEvent> {
  return {
    [Symbol.asyncIterator]() {
      const stopped = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, stopped.signal])
        : stopped.signal;
      const iterator = iterateSession({ ...options, signal });
      return {
        next: () => iterator.next(),
        return: async () => {
          stopped.abort();
          return await iterator.return();
        },
      };
    },
  };
}

async function* iterateSession(
  options: WatchSessionOptions & { signal: AbortSignal },
): AsyncGenerator<SessionWatchEvent, void> {
  const { signal } = options;
  if (signal.aborted) {
    return;
  }
  const record = await settleUnlessAborted(Promise.resolve(options.record), signal);
  if (!record) {
    return;
  }
  yield* iterateJournal(record, options);
}

async function* iterateJournal(
  record: SessionRecord,
  options: WatchSessionOptions & { signal: AbortSignal },
): AsyncGenerator<SessionWatchEvent, void> {
  const { signal } = options;
  let after = options.cursor === undefined ? -1 : parseCursor(record.acpxRecordId, options.cursor);
  const reader = new SessionJournalReader(record);
  let first = true;
  const observation: WatchObservation = {};
  for (;;) {
    if (signal.aborted) {
      return;
    }
    const snapshot = await settleUnlessAborted(
      reader.read(signal, { after, maxBytes: WATCH_PAGE_BYTES }),
      signal,
    );
    if (!snapshot) {
      return;
    }
    assertRetainedCursor(after, snapshot, first);
    first = false;
    for (const { sequence, ...event } of snapshot.events) {
      if (signal.aborted) {
        return;
      }
      after = sequence;
      yield event;
    }
    if (!(await continueAfterPage(record, snapshot, options, observation))) {
      return;
    }
  }
}

async function continueAfterPage(
  record: SessionRecord,
  snapshot: WatchPage,
  options: WatchSessionOptions & { signal: AbortSignal },
  observation: WatchObservation,
): Promise<boolean> {
  if (options.signal.aborted || confirmsTerminalObservation(snapshot, observation)) {
    return false;
  }
  if (!snapshot.hasMore && options.continueWatching) {
    const decision = await settleUnlessAborted(
      options.continueWatching(record, snapshot.requestId),
      options.signal,
    ).catch((error: unknown) => {
      if (error instanceof SessionWatchError && error.code === "WATCH_OUTCOME_UNKNOWN") {
        return error;
      }
      throw error;
    });
    if (decision !== true) {
      // Drain fresh history before acting on closure or an unknown-outcome decision.
      observation.terminal = {
        requestId: snapshot.requestId,
        error: decision instanceof SessionWatchError ? decision : undefined,
      };
      return !options.signal.aborted;
    }
  }
  await settleUnlessAborted(
    delay(snapshot.hasMore ? 0 : 100, undefined, { signal: options.signal }),
    options.signal,
  );
  return !options.signal.aborted;
}

function confirmsTerminalObservation(snapshot: WatchPage, observation: WatchObservation): boolean {
  const terminal = observation.terminal;
  delete observation.terminal;
  if (
    !terminal ||
    snapshot.events.length > 0 ||
    snapshot.hasMore ||
    snapshot.requestId !== terminal.requestId
  ) {
    return false;
  }
  // Apply the saved decision before another awaited policy check can stale this read.
  if (terminal.error) {
    throw terminal.error;
  }
  return true;
}

function assertRetainedCursor(
  after: number,
  snapshot: { firstSequence?: number; sequence: number },
  first: boolean,
): void {
  if (after < 0) {
    return;
  }
  if (after > snapshot.sequence) {
    throw new SessionWatchError(
      first ? "WATCH_CURSOR_FUTURE" : "WATCH_CURSOR_EXPIRED",
      "Cursor is beyond the available session journal",
    );
  }
  if (snapshot.firstSequence !== undefined && after < snapshot.firstSequence) {
    throw new SessionWatchError(
      "WATCH_CURSOR_EXPIRED",
      "Cursor is older than retained session history",
    );
  }
}

async function settleUnlessAborted<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (signal?.aborted) {
      return undefined;
    }
    throw error;
  }
}
