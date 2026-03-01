import assert from "node:assert/strict";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function parseJsonRpcOutputLines(
  stdout: string,
): Array<Record<string, unknown>> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert(lines.length > 0, "expected at least one JSON-RPC line");
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.jsonrpc, "2.0");
    return parsed;
  });
}

export function extractAgentMessageChunkText(
  message: Record<string, unknown>,
): string | undefined {
  if (message.method !== "session/update") {
    return undefined;
  }

  const params = asRecord(message.params);
  const update = asRecord(params?.update);
  const content = asRecord(update?.content);
  if (
    update?.sessionUpdate !== "agent_message_chunk" ||
    content?.type !== "text" ||
    typeof content.text !== "string"
  ) {
    return undefined;
  }

  return content.text;
}

export function extractJsonRpcId(
  message: Record<string, unknown>,
): string | number | undefined {
  if (typeof message.id === "string" || typeof message.id === "number") {
    return message.id;
  }
  return undefined;
}
