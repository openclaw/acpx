import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_ACP_MESSAGE_BYTES,
  AcpMessageLimitError,
  readMaxAcpMessageBytes,
  createNdJsonMessageStream,
} from "../src/acp/ndjson-stream.js";

function sinkWritable(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write() {},
  });
}

function bytesFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function readAll(readable: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = readable.getReader();
  const values: unknown[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    values.push(value);
  }
  return values;
}

test("ACP message limits default to 64 MiB and preserve explicit overrides", () => {
  assert.equal(DEFAULT_MAX_ACP_MESSAGE_BYTES, 64 * 1024 * 1024);
  assert.equal(readMaxAcpMessageBytes(""), DEFAULT_MAX_ACP_MESSAGE_BYTES);
  assert.equal(readMaxAcpMessageBytes(" \t "), DEFAULT_MAX_ACP_MESSAGE_BYTES);
  assert.equal(readMaxAcpMessageBytes("0"), undefined);
  assert.equal(readMaxAcpMessageBytes(" 0 "), undefined);
  assert.equal(readMaxAcpMessageBytes("1024"), 1024);
  assert.equal(readMaxAcpMessageBytes("134217728"), 128 * 1024 * 1024);
  for (const raw of ["-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.throws(() => readMaxAcpMessageBytes(raw), /ACPX_MAX_ACP_MESSAGE_BYTES/);
  }
});

test("ACP message limit reads unset and configured environment values", () => {
  const previous = process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
  try {
    delete process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
    assert.equal(readMaxAcpMessageBytes(), DEFAULT_MAX_ACP_MESSAGE_BYTES);
    process.env.ACPX_MAX_ACP_MESSAGE_BYTES = "0";
    assert.equal(readMaxAcpMessageBytes(), undefined);
    process.env.ACPX_MAX_ACP_MESSAGE_BYTES = "4096";
    assert.equal(readMaxAcpMessageBytes(), 4096);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
    } else {
      process.env.ACPX_MAX_ACP_MESSAGE_BYTES = previous;
    }
  }
});

test("ACP message limit errors explain how to raise or disable the limit", () => {
  const error = new AcpMessageLimitError(DEFAULT_MAX_ACP_MESSAGE_BYTES);
  assert.match(error.message, /67108864 bytes/);
  assert.match(error.message, /Increase the limit or set it to 0/);
  assert.equal(error.detailCode, "ACP_MESSAGE_TOO_LARGE");
  assert.equal(error.retryable, false);
});

test("ACP limits reject complete and incomplete lines independently of chunk boundaries", async () => {
  const frame = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"value":"é"}}');
  for (const newline of [false, true]) {
    const bytes = newline ? new Uint8Array([...frame, 10]) : frame;
    for (const chunks of [[bytes], [bytes.subarray(0, 10), bytes.subarray(10)]]) {
      const stream = createNdJsonMessageStream(
        "fixture",
        sinkWritable(),
        bytesFrom(chunks),
        frame.length - 1,
      );
      await assert.rejects(() => readAll(stream.readable), /ACP message exceeded/);
    }
  }
  const stream = createNdJsonMessageStream(
    "fixture",
    sinkWritable(),
    bytesFrom([frame, new Uint8Array([10])]),
    frame.length,
  );
  assert.equal((await readAll(stream.readable)).length, 1);
});

test("ACP limits count undecoded UTF-8 bytes and reset for each line", async () => {
  const stream = createNdJsonMessageStream(
    "fixture",
    sinkWritable(),
    bytesFrom([new Uint8Array([0xf0, 0x9f, 0x98])]),
    2,
  );
  await assert.rejects(() => readAll(stream.readable), /ACP message exceeded/);
  const frame = new TextEncoder().encode('{"id":1}\n');
  const repeated = createNdJsonMessageStream(
    "fixture",
    sinkWritable(),
    bytesFrom([new Uint8Array([...frame, ...frame])]),
    frame.length - 1,
  );
  assert.equal((await readAll(repeated.readable)).length, 2);
});

test("ACP default accepts complete frames above the former proposed 8 MiB ceiling", async () => {
  const value = "x".repeat(8 * 1024 * 1024 + 1);
  const bytes = new TextEncoder().encode(JSON.stringify({ id: 1, result: value }) + "\n");
  const stream = createNdJsonMessageStream(
    "fixture",
    sinkWritable(),
    bytesFrom([bytes.subarray(0, 1024), bytes.subarray(1024)]),
    readMaxAcpMessageBytes(""),
  );
  assert.deepEqual(await readAll(stream.readable), [{ id: 1, result: value }]);
});

test("createNdJsonMessageStream parses small multi-line NDJSON", async () => {
  const encoder = new TextEncoder();
  const payload =
    '{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}\n' +
    '{"jsonrpc":"2.0","method":"session/update","params":{"n":2}}\n';
  const { readable } = createNdJsonMessageStream(
    "codex",
    sinkWritable(),
    bytesFrom([encoder.encode(payload)]),
  );
  const messages = await readAll(readable);
  assert.deepEqual(messages, [
    { jsonrpc: "2.0", method: "session/update", params: { n: 1 } },
    { jsonrpc: "2.0", method: "session/update", params: { n: 2 } },
  ]);
});
