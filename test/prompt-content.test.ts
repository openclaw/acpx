import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("parsePromptSource rejects image blocks with non-image mime types", () => {
  assert.throws(
    () =>
      parsePromptSource(
        JSON.stringify([{ type: "image", mimeType: "application/json", data: "aW1hZ2U=" }]),
      ),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      /image block mimeType must start with image\//.test(error.message),
  );
});

test("parsePromptSource rejects image blocks with invalid base64 payloads", () => {
  assert.throws(
    () =>
      parsePromptSource(JSON.stringify([{ type: "image", mimeType: "image/png", data: "%%%" }])),
    (error: unknown) =>
      error instanceof PromptInputValidationError &&
      /image block data must be valid base64/.test(error.message),
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
      /text block must include a string text field/.test(error.message),
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
      /resource_link block must include a non-empty uri/.test(error.message),
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
      /resource block resource must include a non-empty uri and optional text/.test(error.message),
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
  ]);

  assert.equal(display, "hello\n\nSpec\n\nContext\n\n[image] image/png");
});
