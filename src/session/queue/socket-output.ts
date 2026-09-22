import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/secure-temp-root";
import type { QueueOwnerMessage } from "./messages.js";

const OUTPUT_CHUNK_BYTES = 64 * 1024;
const DRAIN_TIMEOUT_MS = 1_000;
type QueueOutputLimits = Readonly<{
  observerBytes: number;
  totalBytes: number;
  observers: number;
}>;
const DEFAULT_LIMITS: QueueOutputLimits = Object.freeze({
  observerBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  observers: 64,
});

export class QueueOutputBudget {
  private bytes = 0;
  private files = 0;
  private observers = 0;

  constructor(readonly limits = DEFAULT_LIMITS) {}

  acquire(): void {
    if (this.files >= this.limits.observers) {
      throw new Error("Queue output spool descriptor limit reached");
    }
    this.files += 1;
  }

  grow(bytes: number): void {
    if (bytes > this.limits.totalBytes - this.bytes) {
      throw new Error("Queue output spool storage limit reached");
    }
    this.bytes += bytes;
  }

  release(bytes: number): void {
    this.bytes -= bytes;
    this.files -= 1;
  }

  acquireObserver(): void {
    if (this.observers >= this.limits.observers) {
      throw new Error("Queue blocked observer limit reached");
    }
    this.observers += 1;
  }

  releaseObserver(): void {
    this.observers -= 1;
  }
}

class OutputRing {
  private fd: number | undefined;
  private physicalBytes = 0;
  private readOffset = 0;
  length = 0;

  constructor(private readonly budget: QueueOutputBudget) {
    budget.acquire();
    try {
      const root = resolveSecureTempRoot({ fallbackPrefix: "acpx-output" });
      const file = path.join(root, `${randomUUID()}.tmp`);
      this.fd = fs.openSync(file, "wx+", 0o600);
      // libuv permits deleting an open Windows file. No payload is written until
      // unlink succeeds, so abrupt owner exit cannot leave a named output backlog.
      fs.unlinkSync(file);
    } catch (error) {
      if (this.fd === undefined) {
        budget.release(0);
      } else {
        this.close();
      }
      throw error;
    }
  }

  append(bytes: Buffer, offset: number): void {
    const capacity = this.budget.limits.observerBytes;
    if (bytes.length - offset > capacity - this.length) {
      throw new Error("Queue observer output backlog limit reached");
    }
    while (offset < bytes.length) {
      const position = (this.readOffset + this.length) % capacity;
      const count = Math.min(OUTPUT_CHUNK_BYTES, bytes.length - offset, capacity - position);
      const growth = Math.max(0, position + count - this.physicalBytes);
      this.budget.grow(growth);
      this.physicalBytes += growth;
      const written = fs.writeSync(this.fd!, bytes, offset, count, position);
      if (written <= 0) {
        throw new Error("Queue output spool write made no progress");
      }
      offset += written;
      this.length += written;
    }
  }

  read(): Buffer {
    const capacity = this.budget.limits.observerBytes;
    const bytes = Buffer.allocUnsafe(
      Math.min(OUTPUT_CHUNK_BYTES, this.length, capacity - this.readOffset),
    );
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(
        this.fd!,
        bytes,
        offset,
        bytes.length - offset,
        this.readOffset + offset,
      );
      if (read <= 0) {
        throw new Error("Queue output spool ended before its committed bytes");
      }
      offset += read;
    }
    this.readOffset = (this.readOffset + bytes.length) % capacity;
    this.length -= bytes.length;
    return bytes;
  }

  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) {
      fs.closeSync(fd);
      // Consumed prefixes remain charged until this descriptor actually closes;
      // ring offsets bound physical storage even during a continuously slow read.
      this.budget.release(this.physicalBytes);
    }
  }
}

export class QueueSocketOutput {
  private ring?: OutputRing;
  private blocked = false;
  private ending = false;
  private disposed = false;
  private reserved = false;
  private pendingWrites = 0;

  constructor(
    private readonly socket: net.Socket,
    private readonly budget: QueueOutputBudget,
  ) {
    socket.on("drain", this.onDrain);
    socket.once("close", () => {
      this.disposed = true;
      socket.off("drain", this.onDrain);
      this.closeSpool();
      this.releaseObserver();
    });
  }

  send(message: QueueOwnerMessage): void {
    if (this.ending || this.socket.destroyed || !this.socket.writable) {
      return;
    }
    try {
      this.writeFrame(Buffer.from(`${JSON.stringify(message)}\n`));
    } catch (error) {
      this.fail(error);
    }
  }

  private writeFrame(bytes: Buffer): void {
    let offset = 0;
    while (!this.blocked && offset < bytes.length) {
      const end = Math.min(offset + OUTPUT_CHUNK_BYTES, bytes.length);
      // Copy rather than retain a view into the entire serialized frame while
      // the socket is blocked. Only the current frame remains transiently live.
      this.write(Buffer.from(bytes.subarray(offset, end)));
      offset = end;
    }
    if (offset < bytes.length) {
      this.ring ??= new OutputRing(this.budget);
      // send is synchronous; an async append chain would retain every payload
      // in pending promises and recreate the unbounded memory queue.
      this.ring.append(bytes, offset);
    }
  }

  end(): void {
    if (this.ending || this.socket.destroyed) {
      return;
    }
    this.ending = true;
    this.armTimeout();
    this.finishIfDrained();
  }

  private write(bytes: Buffer): void {
    // Reserve before queuing, including writes below the stream high-water mark.
    // destroy() alone does not prove queued bytes have been released.
    if (!this.reserved) {
      this.budget.acquireObserver();
      this.reserved = true;
    }
    this.pendingWrites += 1;
    try {
      this.blocked = !this.socket.write(bytes, this.onWrite);
    } catch (error) {
      this.pendingWrites -= 1;
      throw error;
    }
    if (this.blocked && !this.socket.timeout) {
      this.armTimeout();
    }
  }

  private readonly onWrite = (error?: Error | null): void => {
    this.pendingWrites -= 1;
    if (this.disposed) {
      return;
    }
    if (error) {
      this.fail(error);
      return;
    }
    this.releaseIfIdle();
  };

  private armTimeout(): void {
    // Windows exposes named-pipe progress only after an entire write completes.
    // Keep its existing exemption; byte and descriptor caps bound stalled output.
    if (process.platform !== "win32") {
      this.socket.setTimeout(DRAIN_TIMEOUT_MS);
    }
  }

  private readonly onDrain = (): void => {
    if (this.disposed) {
      return;
    }
    this.blocked = false;
    if (!this.ending) {
      this.socket.setTimeout(0);
    }
    try {
      this.pump();
      this.releaseIfIdle();
      this.finishIfDrained();
    } catch (error) {
      this.fail(error);
    }
  };

  private pump(): void {
    while (!this.blocked && this.ring && this.ring.length > 0) {
      this.write(this.ring.read());
    }
    if (this.ring?.length === 0) {
      this.closeSpool();
    }
  }

  private finishIfDrained(): void {
    if (this.ending && !this.ring?.length && !this.socket.writableEnded) {
      this.socket.end(() => this.socket.destroy());
    }
  }

  private releaseObserver(): void {
    if (this.reserved) {
      this.reserved = false;
      // The last copied chunk can outlive its ring descriptor. Keep this slot
      // until the socket actually drains or closes, including completed replies.
      this.budget.releaseObserver();
    }
  }

  private releaseIfIdle(): void {
    if (this.pendingWrites === 0 && !this.blocked && !this.ring?.length) {
      this.releaseObserver();
    }
  }

  private closeSpool(): void {
    const ring = this.ring;
    this.ring = undefined;
    try {
      ring?.close();
    } catch (error) {
      this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: unknown): void {
    // The existing client EOF contract reports a nonretryable unknown outcome.
    // Disconnect only this observer; admitted prompts and their journal continue.
    this.disposed = true;
    this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
    this.closeSpool();
  }
}
