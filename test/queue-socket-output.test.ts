import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type net from "node:net";
import test, { type TestContext } from "node:test";
import type { QueueOwnerMessage } from "../src/session/queue/messages.js";
import { QueueOutputBudget, QueueSocketOutput } from "../src/session/queue/socket-output.js";

const CHUNK_BYTES = 64 * 1024;

class PausedSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  timeout = 0;
  error?: Error;
  chunks: Buffer[] = [];
  deferEnd = false;
  finishEnd?: () => void;
  acceptWrites = false;
  callbacks: Array<(error?: Error | null) => void> = [];

  write(bytes: Buffer, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(bytes);
    this.callbacks.push(callback);
    return this.acceptWrites;
  }

  drain(): void {
    const completed = this.callbacks.splice(0);
    // Node emits drain before invoking the completed write callbacks.
    this.emit("drain");
    for (const callback of completed) {
      callback();
    }
  }

  setTimeout(value: number): this {
    this.timeout = value;
    return this;
  }

  end(callback: () => void): void {
    this.writableEnded = true;
    if (this.deferEnd) {
      this.finishEnd = callback;
    } else {
      callback();
    }
  }

  destroy(error?: Error): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.error = error;
      this.emit("close");
    }
    return this;
  }
}

function fixture(t: TestContext, budget = new QueueOutputBudget()) {
  const socket = new PausedSocket();
  const output = new QueueSocketOutput(socket as unknown as net.Socket, budget);
  t.after(() => {
    socket.destroy();
  });
  return { socket, output, budget };
}

function message(text: string): QueueOwnerMessage {
  return { type: "error", requestId: "fixture", message: text };
}

function wire(value: QueueOwnerMessage): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function counts(budget: QueueOutputBudget) {
  return budget as unknown as { bytes: number; files: number; observers: number };
}

function spoolHandles(t: TestContext): number[] {
  const handles: number[] = [];
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    handles.push(fd);
    return fd;
  });
  return handles;
}

function drain(socket: PausedSocket): void {
  for (let turn = 0; turn < 100 && !socket.destroyed; turn += 1) {
    socket.drain();
  }
  assert.equal(socket.destroyed, true, "bounded fixture drain must reach EOF or failure");
}

test("socket output copies bounded chunks and flushes exact UTF-8 before EOF", (t) => {
  const { socket, output, budget } = fixture(t);
  const first = message(`first:${"🍵".repeat(50_000)}`);
  const last = message("last");
  output.send(first);
  output.send(last);
  output.end();
  assert.equal(socket.chunks.length, 1, "a false write immediately stops socket admission");
  assert.equal(socket.writableEnded, false, "EOF waits for the committed disk backlog");
  assert.equal(counts(budget).files, 1);
  drain(socket);
  assert.equal(socket.error, undefined);
  assert.deepEqual(Buffer.concat(socket.chunks), Buffer.concat([wire(first), wire(last)]));
  for (const chunk of socket.chunks) {
    assert.ok(chunk.length <= CHUNK_BYTES);
    assert.ok(chunk.buffer.byteLength <= CHUNK_BYTES, "a queued chunk cannot retain the frame");
  }
  assert.equal(counts(budget).bytes, 0);
  assert.equal(counts(budget).files, 0);
  assert.equal(socket.listenerCount("drain"), 0);
});

test("ring reuse preserves order and bounds file extent across partial reads and writes", (t) => {
  const budget = new QueueOutputBudget({
    observerBytes: 4 * CHUNK_BYTES,
    totalBytes: 4 * CHUNK_BYTES,
    observers: 1,
  });
  const { socket, output } = fixture(t, budget);
  const handles = spoolHandles(t);
  const write = fs.writeSync;
  const read = fs.readSync;
  t.mock.method(
    fs,
    "writeSync",
    (fd: number, bytes: Buffer, offset: number, length: number, position: number) =>
      write(fd, bytes, offset, Math.min(length, 997), position),
  );
  t.mock.method(
    fs,
    "readSync",
    (fd: number, bytes: Buffer, offset: number, length: number, position: number) =>
      read(fd, bytes, offset, Math.min(length, 991), position),
  );
  const frames = [message("a".repeat(3 * CHUNK_BYTES))];
  output.send(frames[0]);
  for (let index = 0; index < 12; index += 1) {
    socket.drain();
    const next = message(`${index}:${"b".repeat(CHUNK_BYTES - 128)}`);
    frames.push(next);
    output.send(next);
    assert.equal(socket.destroyed, false);
    assert.ok(fs.fstatSync(handles[0]).size <= budget.limits.observerBytes);
    assert.ok(counts(budget).bytes <= budget.limits.totalBytes);
  }
  assert.equal(handles.length, 1, "continuous backlog reuses one descriptor");
  output.end();
  drain(socket);
  assert.deepEqual(Buffer.concat(socket.chunks), Buffer.concat(frames.map(wire)));
  assert.equal(counts(budget).bytes, 0);
  assert.throws(() => fs.fstatSync(handles[0]), { code: "EBADF" });
});

test("completed drainers remain charged to descriptor and aggregate storage admission", (t) => {
  const budget = new QueueOutputBudget({
    observerBytes: 4 * CHUNK_BYTES,
    totalBytes: 2 * CHUNK_BYTES,
    observers: 2,
  });
  const first = fixture(t, budget);
  first.output.send(message("a".repeat(CHUNK_BYTES + 100)));
  first.output.end();
  const retained = counts(budget).bytes;
  assert.ok(retained > 0);
  const second = fixture(t, budget);
  second.output.send(message("b".repeat(3 * CHUNK_BYTES)));
  assert.match(second.socket.error!.message, /storage limit/u);
  assert.equal(counts(budget).bytes, retained, "failed admission releases only its own extent");
  const third = fixture(t, budget);
  third.output.send(message("c".repeat(CHUNK_BYTES + 100)));
  third.output.end();
  const fourth = fixture(t, budget);
  fourth.output.send(message("d".repeat(CHUNK_BYTES + 100)));
  assert.match(fourth.socket.error!.message, /blocked observer limit/u);
  first.socket.destroy();
  third.socket.destroy();
  assert.equal(counts(budget).bytes, 0);
  assert.equal(counts(budget).files, 0);
  const successor = fixture(t, budget);
  successor.output.send(message("recovered"));
  successor.output.end();
  assert.equal(successor.socket.error, undefined);
});

test("observer byte cap fails visibly without admitting a terminal success", (t) => {
  const budget = new QueueOutputBudget({
    observerBytes: CHUNK_BYTES,
    totalBytes: CHUNK_BYTES,
    observers: 1,
  });
  const { socket, output } = fixture(t, budget);
  output.send(message("x".repeat(3 * CHUNK_BYTES)));
  assert.match(socket.error!.message, /observer output backlog limit/u);
  const written = socket.chunks.length;
  output.send(message("unreachable terminal response"));
  output.end();
  assert.equal(socket.chunks.length, written);
  assert.equal(socket.writableEnded, false);
  assert.equal(counts(budget).bytes, 0);
  assert.equal(counts(budget).files, 0);
});

test("completed blocked observers stay bounded after the ring empties or without a ring", (t) => {
  const budget = new QueueOutputBudget({
    observerBytes: 4 * CHUNK_BYTES,
    totalBytes: 4 * CHUNK_BYTES,
    observers: 2,
  });
  const first = fixture(t, budget);
  first.socket.deferEnd = true;
  first.output.send(message("a".repeat(CHUNK_BYTES + 100)));
  first.output.end();
  first.socket.drain();
  assert.equal(counts(budget).files, 0, "the last copied chunk has left the ring");
  assert.equal(counts(budget).observers, 1, "its socket still owns queued output");
  const second = fixture(t, budget);
  second.socket.deferEnd = true;
  second.socket.acceptWrites = true;
  second.output.send(message("small blocked reply"));
  second.output.end();
  assert.equal(counts(budget).files, 0);
  assert.equal(counts(budget).observers, 2);
  const rejected = fixture(t, budget);
  rejected.output.send(message("third blocked reply"));
  assert.match(rejected.socket.error!.message, /blocked observer limit/u);
  assert.equal(rejected.socket.chunks.length, 0, "capacity is checked before socket admission");
  first.socket.finishEnd!();
  second.socket.finishEnd!();
  assert.equal(counts(budget).observers, 0);
  const successor = fixture(t, budget);
  successor.output.send(message("next blocked reply"));
  assert.equal(successor.socket.error, undefined);
});

test("same-turn fanout cannot queue bytes beyond the observer budget", (t) => {
  const budget = new QueueOutputBudget();
  const held = Array.from({ length: 64 }, () => fixture(t, budget));
  for (const { socket, output } of held) {
    socket.acceptWrites = true;
    output.send(message("small pending reply"));
  }
  for (let index = 0; index < 256; index += 1) {
    const denied = fixture(t, budget);
    denied.output.send(message("denied before queuing"));
    assert.equal(denied.socket.chunks.length, 0);
    assert.equal(denied.socket.callbacks.length, 0);
  }
  assert.equal(counts(budget).observers, 64);
  for (const { socket } of held) {
    socket.drain();
  }
  assert.equal(counts(budget).observers, 0);
});

test("late write callbacks after actual close neither retain nor over-release slots", (t) => {
  const { socket, output, budget } = fixture(t);
  socket.acceptWrites = true;
  output.send(message("one"));
  output.send(message("two"));
  assert.equal(counts(budget).observers, 1);
  socket.destroy();
  assert.equal(counts(budget).observers, 0);
  socket.drain();
  assert.equal(counts(budget).observers, 0);
  assert.equal((output as unknown as { pendingWrites: number }).pendingWrites, 0);
});

test("destroy requests keep slots until the socket emits close", (t) => {
  const { socket, output, budget } = fixture(t);
  t.mock.method(socket, "destroy", () => {
    socket.destroyed = true;
    return socket;
  });
  output.send(message("x".repeat(3 * CHUNK_BYTES)));
  socket.callbacks.shift()!(new Error("fixture transport error"));
  assert.equal(socket.destroyed, true);
  assert.equal(counts(budget).observers, 1);
  socket.emit("drain");
  assert.equal(counts(budget).observers, 1, "late drain cannot release a failed writer early");
  socket.emit("close");
  assert.equal(counts(budget).observers, 0);
});

for (const failure of ["open", "unlink", "write", "read", "zero-write", "zero-read"] as const) {
  test(`${failure} failure closes only the observer and its spool`, (t) => {
    const { socket, output, budget } = fixture(t);
    const handles = spoolHandles(t);
    const fail = () => {
      throw Object.assign(new Error(`fixture ${failure}`), { code: "ENOSPC" });
    };
    let emptyPath: fs.PathLike | undefined;
    const unlink = fs.unlinkSync;
    if (failure === "open") {
      t.mock.method(fs, "openSync", fail);
    } else if (failure === "unlink") {
      t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
        emptyPath = file;
        fail();
      });
      t.after(() => {
        if (emptyPath) {
          unlink(emptyPath);
        }
      });
    } else if (failure === "write" || failure === "zero-write") {
      t.mock.method(fs, "writeSync", failure === "write" ? fail : () => 0);
    } else {
      t.mock.method(fs, "readSync", failure === "read" ? fail : () => 0);
    }
    output.send(message("x".repeat(3 * CHUNK_BYTES)));
    output.end();
    socket.emit("drain");
    assert.equal(socket.destroyed, true);
    assert.ok(socket.error);
    assert.equal(socket.writableEnded, false);
    assert.equal(counts(budget).bytes, 0);
    assert.equal(counts(budget).files, 0);
    for (const fd of handles) {
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    }
    if (emptyPath) {
      assert.equal(fs.statSync(emptyPath).size, 0, "unlink failure cannot leave output payload");
    }
  });
}

test("disconnect closes the spool once and removes its drain listener", (t) => {
  const { socket, output, budget } = fixture(t);
  const handles = spoolHandles(t);
  output.send(message("x".repeat(3 * CHUNK_BYTES)));
  assert.equal(handles.length, 1);
  socket.destroy();
  socket.destroy();
  socket.emit("drain");
  output.send(message("ignored"));
  assert.equal(socket.listenerCount("drain"), 0);
  assert.equal(counts(budget).files, 0);
  assert.throws(() => fs.fstatSync(handles[0]), { code: "EBADF" });
});

test("an ambiguous close failure keeps its reservation without retrying a numeric descriptor", (t) => {
  const budget = new QueueOutputBudget({
    observerBytes: 4 * CHUNK_BYTES,
    totalBytes: 4 * CHUNK_BYTES,
    observers: 1,
  });
  const { socket, output } = fixture(t, budget);
  const handles = spoolHandles(t);
  output.send(message("x".repeat(3 * CHUNK_BYTES)));
  const close = fs.closeSync;
  let attempts = 0;
  t.mock.method(fs, "closeSync", () => {
    attempts += 1;
    throw new Error("fixture close failure");
  });
  try {
    socket.destroy();
    socket.emit("close");
    assert.equal(attempts, 1);
    assert.equal(counts(budget).files, 1);
    assert.ok(counts(budget).bytes > 0);
    assert.equal(counts(budget).observers, 0);
    const next = fixture(t, budget);
    next.output.send(message("x".repeat(3 * CHUNK_BYTES)));
    assert.match(next.socket.error!.message, /descriptor limit/u);
  } finally {
    close(handles[0]);
  }
});

test("failed unlink and ambiguous constructor cleanup retain the descriptor reservation", (t) => {
  const { socket, output, budget } = fixture(t);
  const handles = spoolHandles(t);
  const close = fs.closeSync;
  const unlink = fs.unlinkSync;
  let emptyPath: fs.PathLike | undefined;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    emptyPath = file;
    throw new Error("fixture unlink failure");
  });
  t.mock.method(fs, "closeSync", () => {
    throw new Error("fixture close failure");
  });
  try {
    output.send(message("x".repeat(3 * CHUNK_BYTES)));
    assert.equal(socket.destroyed, true);
    assert.equal(counts(budget).files, 1);
    assert.equal(counts(budget).bytes, 0);
    assert.equal(fs.fstatSync(handles[0]).size, 0);
  } finally {
    close(handles[0]);
    assert.ok(emptyPath);
    unlink(emptyPath);
  }
});
