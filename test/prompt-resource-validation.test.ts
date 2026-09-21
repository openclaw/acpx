import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InvalidArgumentError } from "commander";
import { readPromptInput } from "../src/cli/prompt-input.js";
import {
  getUnsupportedPromptContentMessage,
  isPromptInput,
  parsePromptSource,
  PromptInputValidationError,
} from "../src/prompt-content.js";
import { parseQueueRequest } from "../src/session/queue/messages.js";

type Schema = {
  parse(value: unknown): Record<string, unknown>;
  safeParse(value: unknown): { success: boolean };
};
const sdk = (await import(
  new URL("./schema/zod.gen.js", import.meta.resolve("@agentclientprotocol/sdk")).href
)) as {
  zResourceLink: Schema;
  zTextResourceContents: Schema;
  zBlobResourceContents: Schema;
  zEmbeddedResourceResource: Schema;
};

const uri = "urn:acpx:synthetic:resource-validation";
const resource = (payload: Record<string, unknown>) => ({ type: "resource", resource: payload });
const link = (fields: Record<string, unknown>) => ({ type: "resource_link", uri, ...fields });
const validPrefix = link({ name: "fixture", title: null });
const nameError = "resource_link block must include a string name";
const payloadError =
  "resource block resource must include a non-empty uri and a string text or blob field";

function queueRequest(prompt: unknown) {
  return {
    type: "submit_prompt",
    requestId: "resource-validation-request",
    message: "must not replace an invalid provided prompt",
    prompt,
    permissionMode: "deny-all",
    waitForCompletion: true,
  };
}

function assertAccepted(block: Record<string, unknown>) {
  const prompt = [block];
  assert.equal(isPromptInput(prompt), true);
  assert.deepEqual(parsePromptSource(JSON.stringify(prompt)), prompt);
  const queued = parseQueueRequest(queueRequest(prompt));
  assert.ok(queued?.type === "submit_prompt");
  assert.deepEqual(queued.prompt, prompt);
  // Force the diagnostic scan; it must skip this valid block.
  assert.throws(() => parsePromptSource(JSON.stringify([...prompt, { type: "text", text: 42 }])), {
    name: "PromptInputValidationError",
    message: "prompt[1] text block must include a string text field",
  });
}

function assertRejected(block: Record<string, unknown>, detail: string) {
  const prompt = [validPrefix, block];
  assert.equal(isPromptInput(prompt), false);
  assert.throws(
    () => parsePromptSource(JSON.stringify(prompt)),
    (error: unknown) =>
      error instanceof PromptInputValidationError && error.message === `prompt[1] ${detail}`,
  );
  assert.equal(parseQueueRequest(queueRequest(prompt)), null);
}

for (const name of ["", " \tresource name\n "]) {
  test(`resource-link preserves required string name ${JSON.stringify(name)}`, () => {
    const block = link({ name, title: null, mimeType: null, _meta: null });
    // Direct required-field validation; no tolerant prompt wrapper or normalized input.
    const parsed = sdk.zResourceLink.parse(block);
    assert.equal(parsed.name, name);
    assert.equal(parsed.title, null);
    assert.equal(parsed.mimeType, null);
    assert.equal(parsed._meta, null);
    assertAccepted(block);
  });
}

for (const [label, fields] of [
  ["missing", {}],
  ["null", { name: null }],
  ["number", { name: 42 }],
] as const) {
  test(`resource-link rejects a ${label} required name`, () => {
    const block = link(fields);
    assert.equal(sdk.zResourceLink.safeParse(block).success, false);
    assertRejected(block, nameError);
  });
}

const validPayloads: Array<{
  label: string;
  payload: Record<string, unknown>;
  textBranch: boolean;
  blobBranch: boolean;
}> = [
  { label: "empty text", payload: { uri, text: "" }, textBranch: true, blobBranch: false },
  {
    label: "literal text and null metadata",
    payload: { uri, text: " \tContext 🦞\n ", mimeType: null, _meta: null },
    textBranch: true,
    blobBranch: false,
  },
  { label: "empty blob", payload: { uri, blob: "" }, textBranch: false, blobBranch: true },
  {
    label: "binary blob and null metadata",
    payload: { uri, blob: "AAEC/w==", mimeType: null, _meta: null },
    textBranch: false,
    blobBranch: true,
  },
  {
    label: "both payload branches",
    payload: { uri, text: "Context", blob: "AQID" },
    textBranch: true,
    blobBranch: true,
  },
  {
    label: "blob branch beside non-string text",
    payload: { uri, text: 42, blob: "AQID" },
    textBranch: false,
    blobBranch: true,
  },
  {
    label: "text branch beside non-string blob",
    payload: { uri, text: "Context", blob: 42 },
    textBranch: true,
    blobBranch: false,
  },
];

for (const { label, payload, textBranch, blobBranch } of validPayloads) {
  test(`embedded resource preserves ${label}`, () => {
    assert.equal(sdk.zTextResourceContents.safeParse(payload).success, textBranch);
    assert.equal(sdk.zBlobResourceContents.safeParse(payload).success, blobBranch);
    assert.equal(sdk.zEmbeddedResourceResource.safeParse(payload).success, true);
    for (const [key, schema, supported] of [
      ["text", sdk.zTextResourceContents, textBranch],
      ["blob", sdk.zBlobResourceContents, blobBranch],
    ] as const) {
      if (supported) {
        const parsed = schema.parse(payload);
        assert.equal(parsed[key], payload[key]);
        assert.equal(parsed.uri, uri);
        assert.equal(parsed.mimeType, payload.mimeType);
        assert.equal(parsed._meta, payload._meta);
      }
    }
    // SDK branch parsers can strip losing-branch fields. Never feed their output to acpx.
    assertAccepted(resource(payload));
  });
}

const invalidPayloads: Array<{ label: string; payload: Record<string, unknown> }> = [
  { label: "missing payload", payload: { uri } },
  { label: "numeric text only", payload: { uri, text: 42 } },
  { label: "numeric blob only", payload: { uri, blob: 42 } },
  { label: "null alternatives", payload: { uri, text: null, blob: null } },
];

for (const { label, payload } of invalidPayloads) {
  test(`embedded resource rejects ${label}`, () => {
    assert.equal(sdk.zTextResourceContents.safeParse(payload).success, false);
    assert.equal(sdk.zBlobResourceContents.safeParse(payload).success, false);
    assert.equal(sdk.zEmbeddedResourceResource.safeParse(payload).success, false);
    assertRejected(resource(payload), payloadError);
  });
}

test("prompt file preserves accepted resources and reports local resource validation errors", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resource-validation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "prompt.json");
  const prompt = [validPrefix, ...validPayloads.map(({ payload }) => resource(payload))];
  await fs.writeFile(file, JSON.stringify(prompt), "utf8");
  assert.deepEqual(await readPromptInput("prompt.json", "Follow up", directory), [
    ...prompt,
    { type: "text", text: "Follow up" },
  ]);
  for (const [block, detail] of [
    [link({}), nameError],
    [resource({ uri }), payloadError],
  ] as const) {
    await fs.writeFile(file, JSON.stringify([validPrefix, block]), "utf8");
    await assert.rejects(
      readPromptInput("prompt.json", "", directory),
      (error: unknown) =>
        error instanceof InvalidArgumentError && error.message === `prompt[1] ${detail}`,
    );
  }
});

test("resource validation preserves baseline links and embedded-context capability behavior", () => {
  const links = parsePromptSource(JSON.stringify([validPrefix]));
  for (const capabilities of [
    undefined,
    { promptCapabilities: { embeddedContext: false } },
    { promptCapabilities: { embeddedContext: true } },
  ]) {
    assert.equal(getUnsupportedPromptContentMessage(links, capabilities), undefined);
    for (const payload of [
      { uri, text: "Context" },
      { uri, blob: "AQID" },
    ]) {
      const prompt = parsePromptSource(JSON.stringify([resource(payload)]));
      assert.equal(
        getUnsupportedPromptContentMessage(prompt, capabilities),
        capabilities?.promptCapabilities.embeddedContext === true
          ? undefined
          : "prompt[0] resource content requires agentCapabilities.promptCapabilities.embeddedContext",
      );
    }
  }
});
