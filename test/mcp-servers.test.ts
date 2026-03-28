import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServers, parseOptionalMcpServers } from "../src/mcp-servers.js";

test("parseOptionalMcpServers returns undefined for missing values", () => {
  assert.equal(parseOptionalMcpServers(undefined, "config.json"), undefined);
});

test("parseMcpServers parses http, sse, and stdio servers", () => {
  const servers = parseMcpServers(
    [
      {
        name: "http-server",
        type: "http",
        url: " https://example.com/mcp ",
        headers: [{ name: "Authorization", value: "Bearer token" }],
        _meta: { scope: "test" },
      },
      {
        name: "sse-server",
        type: "sse",
        url: "https://example.com/sse",
      },
      {
        name: "stdio-server",
        command: "node",
        args: ["server.js"],
        env: [{ name: "NODE_ENV", value: "test" }],
        _meta: null,
      },
    ],
    "config.json",
  );

  assert.deepEqual(servers, [
    {
      name: "http-server",
      type: "http",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
      _meta: { scope: "test" },
    },
    {
      name: "sse-server",
      type: "sse",
      url: "https://example.com/sse",
      headers: [],
      _meta: undefined,
    },
    {
      name: "stdio-server",
      command: "node",
      args: ["server.js"],
      env: [{ name: "NODE_ENV", value: "test" }],
      _meta: null,
    },
  ]);
});

test("parseMcpServers rejects invalid top-level and entry fields", () => {
  assert.throws(() => parseMcpServers({}, "config.json"), {
    message: "Invalid mcpServers in config.json: expected array",
  });

  assert.throws(
    () =>
      parseMcpServers(
        [
          {
            name: "broken",
            type: "http",
            url: "",
          },
        ],
        "config.json",
      ),
    {
      message: "Invalid mcpServers[0] in config.json.url: expected non-empty string",
    },
  );

  assert.throws(
    () =>
      parseMcpServers(
        [
          {
            name: "broken",
            type: "udp",
            url: "https://example.com",
          },
        ],
        "config.json",
      ),
    {
      message: "Invalid mcpServers[0] in config.json.type: expected http, sse, or stdio",
    },
  );
});

test("parseMcpServers rejects invalid nested header, args, env, and meta values", () => {
  assert.throws(
    () =>
      parseMcpServers(
        [
          {
            name: "broken",
            type: "http",
            url: "https://example.com",
            headers: [{ name: "X-Test", value: 123 }],
          },
        ],
        "config.json",
      ),
    {
      message: "Invalid mcpServers[0] in config.json.headers[0].value: expected non-empty string",
    },
  );

  assert.throws(
    () =>
      parseMcpServers(
        [
          {
            name: "broken",
            command: "node",
            args: ["ok", 123],
          },
        ],
        "config.json",
      ),
    {
      message: "Invalid mcpServers[0] in config.json.args[1]: expected string",
    },
  );

  assert.throws(
    () =>
      parseMcpServers(
        [
          {
            name: "broken",
            command: "node",
            env: [{ name: "X", value: "" }],
          },
        ],
        "config.json",
      ),
    {
      message: "Invalid mcpServers[0] in config.json.env[0].value: expected non-empty string",
    },
  );

  assert.throws(
    () =>
      parseMcpServers(
        [
          {
            name: "broken",
            command: "node",
            _meta: "bad",
          },
        ],
        "config.json",
      ),
    {
      message: "Invalid mcpServers[0] in config.json._meta: expected object or null",
    },
  );
});
