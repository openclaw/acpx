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
        "resource block resource must include a non-empty uri and optional text",
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
