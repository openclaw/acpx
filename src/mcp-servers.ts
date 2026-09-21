import type { McpServer } from "@agentclientprotocol/sdk";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function parseNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${path}: expected non-empty string`);
  }
  return value.trim();
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${path}: expected string`);
  }
  return value;
}

function parseNameValuePairs(value: unknown, path: string): Array<{ name: string; value: string }> {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected array`);
  }

  const entries: Array<{ name: string; value: string }> = [];
  for (const [index, rawEntry] of value.entries()) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`Invalid ${path}[${index}]: expected object`);
    }
    entries.push({
      name: parseNonEmptyString(entry.name, `${path}[${index}].name`),
      value: parseString(entry.value, `${path}[${index}].value`),
    });
  }
  return entries;
}

function parseArgs(value: unknown, path: string): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected array`);
  }

  const args: string[] = [];
  for (const [index, rawArg] of value.entries()) {
    args.push(parseString(rawArg, `${path}[${index}]`));
  }
  return args;
}

function parseMeta(value: unknown, path: string): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!asRecord(value)) {
    throw new Error(`Invalid ${path}: expected object or null`);
  }
  return value as Record<string, unknown>;
}

function parseServerType(rawType: unknown, path: string): "http" | "sse" | "stdio" {
  if (rawType === undefined) {
    // Allow normalized stdio entries where type is omitted by ACP shape.
    return "stdio";
  }

  const parsedType = parseNonEmptyString(rawType, `${path}.type`);
  if (parsedType !== "http" && parsedType !== "sse" && parsedType !== "stdio") {
    throw new Error(`Invalid ${path}.type: expected http, sse, or stdio`);
  }
  return parsedType;
}

function parseHttpServer(
  serverRecord: UnknownRecord,
  path: string,
  type: "http" | "sse",
  name: string,
  _meta: Record<string, unknown> | null | undefined,
): McpServer {
  return {
    type,
    name,
    url: parseNonEmptyString(serverRecord.url, `${path}.url`),
    headers: parseNameValuePairs(serverRecord.headers, `${path}.headers`),
    _meta,
  } satisfies McpServer;
}

function parseStdioServer(
  serverRecord: UnknownRecord,
  path: string,
  name: string,
  _meta: Record<string, unknown> | null | undefined,
): McpServer {
  return {
    name,
    command: parseNonEmptyString(serverRecord.command, `${path}.command`),
    args: parseArgs(serverRecord.args, `${path}.args`),
    env: parseNameValuePairs(serverRecord.env, `${path}.env`),
    _meta,
  } satisfies McpServer;
}

function parseServer(rawServer: unknown, path: string): McpServer {
  const serverRecord = asRecord(rawServer);
  if (!serverRecord) {
    throw new Error(`Invalid ${path}: expected object`);
  }

  const name = parseNonEmptyString(serverRecord.name, `${path}.name`);
  const _meta = parseMeta(serverRecord._meta, `${path}._meta`);
  const typeValue = parseServerType(serverRecord.type, path);

  if (typeValue === "http" || typeValue === "sse") {
    return parseHttpServer(serverRecord, path, typeValue, name, _meta);
  }

  return parseStdioServer(serverRecord, path, name, _meta);
}

export function parseMcpServers(
  value: unknown,
  sourcePath: string,
  fieldName = "mcpServers",
): McpServer[] {
  const fieldPath = `${fieldName} in ${sourcePath}`;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldPath}: expected array`);
  }

  const parsed: McpServer[] = [];
  for (const [index, rawServer] of value.entries()) {
    parsed.push(parseServer(rawServer, `${fieldName}[${index}] in ${sourcePath}`));
  }
  return parsed;
}

export function parseOptionalMcpServers(
  value: unknown,
  sourcePath: string,
  fieldName = "mcpServers",
): McpServer[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseMcpServers(value, sourcePath, fieldName);
}
