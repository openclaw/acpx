import type { EnvVariable, HttpHeader, McpServer } from "@agentclientprotocol/sdk";

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

function parseHeaders(value: unknown, path: string): HttpHeader[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected array`);
  }

  const headers: HttpHeader[] = [];
  for (const [index, rawHeader] of value.entries()) {
    const headerRecord = asRecord(rawHeader);
    if (!headerRecord) {
      throw new Error(`Invalid ${path}[${index}]: expected object`);
    }
    const name = parseNonEmptyString(headerRecord.name, `${path}[${index}].name`);
    const headerValue = parseNonEmptyString(headerRecord.value, `${path}[${index}].value`);
    headers.push({
      name,
      value: headerValue,
    });
  }
  return headers;
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
    if (typeof rawArg !== "string") {
      throw new Error(`Invalid ${path}[${index}]: expected string`);
    }
    args.push(rawArg);
  }
  return args;
}

function parseEnv(value: unknown, path: string): EnvVariable[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected array`);
  }

  const env: EnvVariable[] = [];
  for (const [index, rawEntry] of value.entries()) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`Invalid ${path}[${index}]: expected object`);
    }

    const name = parseNonEmptyString(entry.name, `${path}[${index}].name`);
    const envValue = parseNonEmptyString(entry.value, `${path}[${index}].value`);
    env.push({
      name,
      value: envValue,
    });
  }

  return env;
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

function parseServer(rawServer: unknown, path: string): McpServer {
  const serverRecord = asRecord(rawServer);
  if (!serverRecord) {
    throw new Error(`Invalid ${path}: expected object`);
  }

  const name = parseNonEmptyString(serverRecord.name, `${path}.name`);
  const _meta = parseMeta(serverRecord._meta, `${path}._meta`);
  const rawType = serverRecord.type;

  let typeValue: "http" | "sse" | "stdio";
  if (rawType === undefined) {
    // Allow normalized stdio entries where type is omitted by ACP shape.
    typeValue = "stdio";
  } else {
    const parsedType = parseNonEmptyString(rawType, `${path}.type`);
    if (parsedType !== "http" && parsedType !== "sse" && parsedType !== "stdio") {
      throw new Error(`Invalid ${path}.type: expected http, sse, or stdio`);
    }
    typeValue = parsedType;
  }

  if (typeValue === "http" || typeValue === "sse") {
    const url = parseNonEmptyString(serverRecord.url, `${path}.url`);
    const headers = parseHeaders(serverRecord.headers, `${path}.headers`);
    const server = {
      type: typeValue,
      name,
      url,
      headers,
      _meta,
    } satisfies McpServer;
    return server;
  }

  if (typeValue === "stdio") {
    const command = parseNonEmptyString(serverRecord.command, `${path}.command`);
    const args = parseArgs(serverRecord.args, `${path}.args`);
    const env = parseEnv(serverRecord.env, `${path}.env`);
    const server = {
      name,
      command,
      args,
      env,
      _meta,
    } satisfies McpServer;
    return server;
  }

  throw new Error(`Invalid ${path}.type: expected http, sse, or stdio`);
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
