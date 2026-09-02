import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NDJSON_INCOMPLETE_LINE_BYTES,
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

test("createNdJsonMessageStream rejects an incomplete line past the byte cap", async () => {
  const oversized = new Uint8Array(MAX_NDJSON_INCOMPLETE_LINE_BYTES + 1).fill(0x61);
  const { readable } = createNdJsonMessageStream("codex", sinkWritable(), bytesFrom([oversized]));
  await assert.rejects(
    () => readAll(readable),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /incomplete NDJSON line/i);
      assert.match(err.message, new RegExp(String(MAX_NDJSON_INCOMPLETE_LINE_BYTES)));
      return true;
    },
  );
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
