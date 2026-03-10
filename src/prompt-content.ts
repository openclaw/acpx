import type { ContentBlock } from "@agentclientprotocol/sdk";

export type PromptInput = ContentBlock[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isTextBlock(value: unknown): value is Extract<ContentBlock, { type: "text" }> {
  const record = asRecord(value);
  return record?.type === "text" && typeof record.text === "string";
}

function isImageBlock(value: unknown): value is Extract<ContentBlock, { type: "image" }> {
  const record = asRecord(value);
  return (
    record?.type === "image" &&
    typeof record.mimeType === "string" &&
    typeof record.data === "string"
  );
}

function isResourceLinkBlock(
  value: unknown,
): value is Extract<ContentBlock, { type: "resource_link" }> {
  const record = asRecord(value);
  return (
    record?.type === "resource_link" &&
    typeof record.uri === "string" &&
    (record.title === undefined || typeof record.title === "string") &&
    (record.name === undefined || typeof record.name === "string")
  );
}

function isResourcePayload(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || typeof record.uri !== "string") {
    return false;
  }
  return record.text === undefined || typeof record.text === "string";
}

function isResourceBlock(value: unknown): value is Extract<ContentBlock, { type: "resource" }> {
  const record = asRecord(value);
  return record?.type === "resource" && isResourcePayload(record.resource);
}

function isContentBlock(value: unknown): value is ContentBlock {
  return (
    isTextBlock(value) ||
    isImageBlock(value) ||
    isResourceLinkBlock(value) ||
    isResourceBlock(value)
  );
}

export function isPromptInput(value: unknown): value is PromptInput {
  return Array.isArray(value) && value.every((entry) => isContentBlock(entry));
}

export function textPrompt(text: string): PromptInput {
  return [
    {
      type: "text",
      text,
    },
  ];
}

function parseStructuredPrompt(source: string): PromptInput | undefined {
  if (!source.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    return isPromptInput(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parsePromptSource(source: string): PromptInput {
  const trimmed = source.trim();
  const structured = parseStructuredPrompt(trimmed);
  if (structured) {
    return structured;
  }
  if (!trimmed) {
    return [];
  }
  return textPrompt(trimmed);
}

export function mergePromptSourceWithText(source: string, suffixText: string): PromptInput {
  const prompt = parsePromptSource(source);
  const appended = suffixText.trim();
  if (!appended) {
    return prompt;
  }
  if (prompt.length === 0) {
    return textPrompt(appended);
  }
  return [...prompt, ...textPrompt(appended)];
}

export function promptToDisplayText(prompt: PromptInput): string {
  return prompt
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource_link":
          return block.title ?? block.name ?? block.uri;
        case "resource":
          return "text" in block.resource && typeof block.resource.text === "string"
            ? block.resource.text
            : block.resource.uri;
        case "image":
          return `[image] ${block.mimeType}`;
        default:
          return "";
      }
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .trim();
}
