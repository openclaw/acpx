import assert from "node:assert/strict";
import test from "node:test";
import {
  getUnsupportedPromptContentMessage,
  isPromptInput,
  mergePromptSourceWithText,
  parsePromptSource,
  promptToDisplayText,
  PromptInputValidationError,
  textPrompt,
} from "../src/prompt-content.js";

test("parsePromptSource accepts valid image blocks", () => {
  const prompt = parsePromptSource(
    JSON.stringify([{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]),
  );

  assert.deepEqual(prompt, [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
});

test("parsePromptSource accepts valid audio blocks", () => {
  const prompt = parsePromptSource(
    JSON.stringify([{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }]),
  );

  assert.deepEqual(prompt, [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }]);
  assert.equal(isPromptInput(prompt), true);
});

test("parsePromptSource rejects image blocks with non-image mime types", () => {
  assert.throws(
    () =>
      parsePromptSource(
        JSON.stringify([{ type: "image", mimeType: "application/json", data: "aW1hZ2U=" }]),
      ),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("image block mimeType must start with image/"),
  );
});

test("parsePromptSource rejects audio blocks with non-audio mime types", () => {
  assert.throws(
    () =>
      parsePromptSource(
        JSON.stringify([{ type: "audio", mimeType: "application/octet-stream", data: "UklGRg==" }]),
      ),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("audio block mimeType must start with audio/"),
  );
});

test("parsePromptSource rejects audio blocks with invalid base64 payloads", () => {
  assert.throws(
    () =>
      parsePromptSource(JSON.stringify([{ type: "audio", mimeType: "audio/wav", data: "%%%" }])),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("audio block data must be valid base64"),
  );
});

test("parsePromptSource rejects image blocks with invalid base64 payloads", () => {
  assert.throws(
    () =>
      parsePromptSource(JSON.stringify([{ type: "image", mimeType: "image/png", data: "%%%" }])),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("image block data must be valid base64"),
  );
});

test("parsePromptSource keeps large image and audio payloads as media blocks", () => {
  // Large enough to overflow the regexp stack of a backtracking base64 pattern.
  const size = 8 * 1024 * 1024;
  const audio = "A".repeat(size);
  const image = `${"B".repeat(size - 4)}AA==`;
  const prompt = parsePromptSource(
    JSON.stringify([
      { type: "text", text: "Transcribe this." },
      { type: "audio", mimeType: "audio/ogg", data: audio },
      { type: "image", mimeType: "image/png", data: image },
    ]),
  );

  assert.deepEqual(
    prompt.map((block) => block.type),
    ["text", "audio", "image"],
  );
  assert.equal(prompt[1]?.type === "audio" ? prompt[1].data.length : 0, size);
  assert.equal(prompt[2]?.type === "image" ? prompt[2].data.length : 0, size);
  assert.equal(isPromptInput(prompt), true);
});

test("parsePromptSource rejects a large audio payload with invalid base64", () => {
  const data = `${"A".repeat(8 * 1024 * 1024 - 4)}A%A=`;
  assert.throws(
    () => parsePromptSource(JSON.stringify([{ type: "audio", mimeType: "audio/ogg", data }])),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("audio block data must be valid base64"),
  );
});

test("parsePromptSource checks base64 padding", () => {
  const block = (data: string) => [{ type: "image", mimeType: "image/png", data }];
  assert.equal(isPromptInput(block("aW1hZ2U=")), true);
  assert.equal(isPromptInput(block("aW1hZw==")), true);
  for (const data of ["aW1hZ2U", "aW1h=2U=", "aW1hZ===", "====", "aW1h\nZ2U="]) {
    assert.equal(isPromptInput(block(data)), false, data);
  }
});

test("parsePromptSource keeps non-JSON bracket text as plain text", () => {
  assert.deepEqual(
    parsePromptSource("[todo] validate image input"),
    textPrompt("[todo] validate image input"),
  );
});

test("parsePromptSource accepts resource and resource_link blocks", () => {
  const prompt = parsePromptSource(
    JSON.stringify([
      {
        type: "resource_link",
        uri: "file:///tmp/spec.md",
        name: "spec",
        title: "Spec",
      },
      {
        type: "resource",
        resource: {
          uri: "file:///tmp/context.txt",
          text: "Context",
        },
      },
    ]),
  );

  assert.deepEqual(prompt, [
    {
      type: "resource_link",
      uri: "file:///tmp/spec.md",
      name: "spec",
      title: "Spec",
    },
    {
      type: "resource",
      resource: {
        uri: "file:///tmp/context.txt",
        text: "Context",
      },
    },
  ]);
  assert.equal(isPromptInput(prompt), true);
});

test("parsePromptSource rejects invalid text and resource block shapes", () => {
  assert.throws(
    () => parsePromptSource(JSON.stringify([{ type: "text", text: 123 }])),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("text block must include a string text field"),
  );

  assert.throws(
    () =>
      parsePromptSource(
        JSON.stringify([
          {
            type: "resource_link",
            uri: "",
          },
        ]),
      ),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes("resource_link block must include a non-empty uri"),
  );

  assert.throws(
    () =>
      parsePromptSource(
        JSON.stringify([
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/context.txt",
              text: 123,
            },
          },
        ]),
      ),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes(
        "resource block resource must include a non-empty uri and a string text or blob field",
      ),
  );
});

test("parsePromptSource rejects prototype-named structured block types", () => {
  assert.throws(
    () => parsePromptSource(JSON.stringify([{ type: "__proto__", text: "x" }])),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      error.message.includes('unsupported content block type "__proto__"'),
  );
});

test("parsePromptSource returns an empty prompt for blank input", () => {
  assert.deepEqual(parsePromptSource("   "), []);
});

test("mergePromptSourceWithText appends or creates prompt text", () => {
  assert.deepEqual(
    mergePromptSourceWithText(JSON.stringify([{ type: "text", text: "hello" }]), "world"),
    [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ],
  );

  assert.deepEqual(mergePromptSourceWithText("   ", "world"), [{ type: "text", text: "world" }]);
  assert.deepEqual(mergePromptSourceWithText("hello", "   "), [{ type: "text", text: "hello" }]);
});

test("promptToDisplayText renders text, resources, and images", () => {
  const display = promptToDisplayText([
    { type: "text", text: "hello" },
    { type: "resource_link", uri: "file:///tmp/spec.md", name: "spec", title: "Spec" },
    { type: "resource", resource: { uri: "file:///tmp/context.txt", text: "Context" } },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
  ]);

  assert.equal(display, "hello\n\nSpec\n\nContext\n\n[image] image/png\n\n[audio] audio/wav");
});

test("getUnsupportedPromptContentMessage enforces rich prompt capabilities", () => {
  const prompt = parsePromptSource(
    JSON.stringify([
      { type: "text", text: "hello" },
      { type: "resource_link", uri: "file:///tmp/spec.md", name: "spec" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
      { type: "resource", resource: { uri: "file:///tmp/context.txt", text: "Context" } },
    ]),
  );

  assert.equal(
    getUnsupportedPromptContentMessage(prompt, undefined),
    "prompt[2] image content requires agentCapabilities.promptCapabilities.image",
  );
  assert.equal(
    getUnsupportedPromptContentMessage(prompt, {
      promptCapabilities: {
        image: true,
      },
    }),
    "prompt[3] audio content requires agentCapabilities.promptCapabilities.audio",
  );
  assert.equal(
    getUnsupportedPromptContentMessage(prompt, {
      promptCapabilities: {
        image: true,
        audio: true,
      },
    }),
    "prompt[4] resource content requires agentCapabilities.promptCapabilities.embeddedContext",
  );
  assert.equal(
    getUnsupportedPromptContentMessage(prompt, {
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
    }),
    undefined,
  );
});
