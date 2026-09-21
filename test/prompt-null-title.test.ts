import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InvalidArgumentError } from "commander";
import { readPromptInput } from "../src/cli/prompt-input.js";
import {
  isPromptInput,
  parsePromptSource,
  PromptInputValidationError,
} from "../src/prompt-content.js";
import { parseQueueRequest } from "../src/session/queue/messages.js";

// Inspect the installed SDK's actual generated validator without adding a dependency.
const sdk = (await import(
  new URL("./schema/zod.gen.js", import.meta.resolve("@agentclientprotocol/sdk")).href
)) as { zPromptRequest: { parse(value: unknown): { prompt: unknown[] } } };

function resourceLink(title: unknown) {
  return {
    type: "resource_link",
    name: "fixture-resource",
    uri: "urn:acpx:synthetic:resource-link",
    ...(title === undefined ? {} : { title }),
  };
}

function queueRequest(prompt: unknown) {
  return {
    type: "submit_prompt",
    requestId: "resource-title-request",
    message: "fallback must not replace the resource link",
    prompt,
    permissionMode: "deny-all",
    waitForCompletion: true,
  };
}

const validTitles = [
  { label: "omitted", title: undefined },
  { label: "null", title: null },
  { label: "string", title: "Display title" },
  { label: "empty string", title: "" },
  { label: "literal whitespace", title: " \tDisplay title\n " },
];

for (const { label, title } of validTitles) {
  test(`structured prompt preserves a resource-link title that is ${label}`, () => {
    const expected = [resourceLink(title)];
    const validated = sdk.zPromptRequest.parse({ sessionId: "fixture-session", prompt: expected });
    assert.deepEqual(JSON.parse(JSON.stringify(validated.prompt)), expected);
    assert.equal(isPromptInput(expected), true);
    const parsed = parsePromptSource(JSON.stringify(expected));
    assert.deepEqual(parsed, expected);
    assert.equal(Object.hasOwn(parsed[0], "title"), title !== undefined);
  });

  test(`prompt file preserves a resource-link title that is ${label} before appended text`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resource-title-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const expected = [resourceLink(title)];
    await fs.writeFile(path.join(directory, "prompt.json"), JSON.stringify(expected), "utf8");
    const parsed = await readPromptInput("prompt.json", "Follow up", directory);
    assert.deepEqual(parsed, [...expected, { type: "text", text: "Follow up" }]);
    assert.equal(Object.hasOwn(parsed[0], "title"), title !== undefined);
  });

  test(`queue admission preserves a resource-link title that is ${label}`, () => {
    const expected = [resourceLink(title)];
    const wire: unknown = JSON.parse(JSON.stringify(queueRequest(expected)));
    const parsed = parseQueueRequest(wire);
    assert.ok(parsed?.type === "submit_prompt");
    assert.deepEqual(parsed.prompt, expected);
    assert.ok(parsed.prompt);
    assert.equal(Object.hasOwn(parsed.prompt[0], "title"), title !== undefined);
  });
}

for (const { label, title } of [
  { label: "number", title: 42 },
  { label: "boolean", title: false },
  { label: "object", title: { text: "invalid" } },
  { label: "array", title: ["invalid"] },
]) {
  // These raw malformed inputs must not pass through SDK tolerant normalization first.
  test(`structured prompt rejects a ${label} resource-link title`, () => {
    const prompt = [resourceLink(title)];
    assert.equal(isPromptInput(prompt), false);
    assert.throws(
      () => parsePromptSource(JSON.stringify(prompt)),
      (error: unknown) =>
        error instanceof PromptInputValidationError &&
        error.message.includes("resource_link block title"),
    );
  });

  test(`prompt file rejects a ${label} resource-link title`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resource-title-invalid-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(directory, "prompt.json"),
      JSON.stringify([resourceLink(title)]),
      "utf8",
    );
    await assert.rejects(
      readPromptInput("prompt.json", "", directory),
      (error: unknown) =>
        error instanceof InvalidArgumentError &&
        error.message.includes("resource_link block title"),
    );
  });

  test(`queue admission rejects a ${label} resource-link title`, () => {
    const wire: unknown = JSON.parse(JSON.stringify(queueRequest([resourceLink(title)])));
    assert.equal(parseQueueRequest(wire), null);
  });
}

test("structured prompt reports the actual invalid block after a valid null title", () => {
  const source = JSON.stringify([resourceLink(null), { type: "text", text: 42 }]);
  assert.throws(() => parsePromptSource(source), {
    name: "PromptInputValidationError",
    message: "prompt[1] text block must include a string text field",
  });
});
