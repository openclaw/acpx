import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@agentclientprotocol/sdk";
import { parseMcpServers } from "../src/mcp-servers.js";
import { parseQueueOwnerPayload } from "../src/session/queue/owner-input.js";

type Pair = { name: string; value: string };
type Boundary = {
  name: string;
  source: string;
  parse: (servers: unknown) => McpServer[];
};
type Transport = {
  name: string;
  field: "env" | "headers";
  pairName: string;
  input: (pairs: unknown) => Record<string, unknown>;
  expected: (pairs: Pair[]) => McpServer;
};

const BOUNDARIES: Boundary[] = [
  {
    name: "config parser",
    source: "synthetic-mcp.json",
    parse: (servers) => parseMcpServers(servers, "synthetic-mcp.json"),
  },
  {
    name: "queue owner parser",
    source: "queue owner payload",
    parse: (servers) => {
      const result = parseQueueOwnerPayload(
        JSON.stringify({
          sessionId: "synthetic-mcp-values",
          permissionMode: "deny-all",
          mcpServers: servers,
        }),
      );
      assert.equal(result.sessionId, "synthetic-mcp-values");
      assert.equal(result.permissionMode, "deny-all");
      assert.ok(result.mcpServers);
      return result.mcpServers;
    },
  },
];

const TRANSPORTS: Transport[] = [
  {
    name: "stdio env",
    field: "env",
    pairName: "ACPX_SYNTHETIC_VALUE",
    input: (env) => ({
      type: "stdio",
      name: "synthetic-stdio",
      command: "/synthetic/unused-mcp-server",
      args: ["--synthetic"],
      env,
    }),
    expected: (env) => ({
      name: "synthetic-stdio",
      command: "/synthetic/unused-mcp-server",
      args: ["--synthetic"],
      env,
      _meta: undefined,
    }),
  },
  ...(["http", "sse"] as const).map((type): Transport => ({
    name: `${type} headers`,
    field: "headers",
    pairName: "X-Acpx-Synthetic-Value",
    input: (headers) => ({
      type,
      name: `synthetic-${type}`,
      url: `https://example.invalid/synthetic/${type}`,
      headers,
    }),
    expected: (headers) => ({
      type,
      name: `synthetic-${type}`,
      url: `https://example.invalid/synthetic/${type}`,
      headers,
      _meta: undefined,
    }),
  })),
];

const VALUES = [
  { label: "empty", value: "" },
  { label: "space-only", value: "  " },
  { label: "padded", value: "  prefix  " },
  { label: "plain control", value: "literal" },
];

for (const boundary of BOUNDARIES) {
  for (const transport of TRANSPORTS) {
    for (const { label, value } of VALUES) {
      test(`${boundary.name} preserves ${label} ${transport.name} values exactly`, () => {
        const pairs = [{ name: transport.pairName, value }];
        const raw = transport.input(pairs);
        const before = structuredClone(raw);
        assert.deepEqual(boundary.parse([raw]), [transport.expected(pairs)]);
        assert.deepEqual(raw, before, "parsing must not rewrite the supplied value");
      });
    }

    test(`${boundary.name} still normalizes ${transport.name} names independently of values`, () => {
      const raw = transport.input([{ name: `  ${transport.pairName}  `, value: "  prefix  " }]);
      assert.deepEqual(boundary.parse([raw]), [
        transport.expected([{ name: transport.pairName, value: "  prefix  " }]),
      ]);
    });

    test(`${boundary.name} rejects missing and non-string ${transport.name} values`, () => {
      const malformed: Array<{ label: string; entry: Record<string, unknown> }> = [
        { label: "missing", entry: { name: transport.pairName } },
        ...[null, 0, false, {}, []].map((value) => ({
          label: JSON.stringify(value) ?? "undefined",
          entry: { name: transport.pairName, value },
        })),
      ];
      for (const { label, entry } of malformed) {
        assert.throws(
          () => boundary.parse([transport.input([entry])]),
          {
            message: `Invalid mcpServers[0] in ${boundary.source}.${transport.field}[0].value: expected string`,
          },
          label,
        );
      }
    });

    test(`${boundary.name} still rejects malformed ${transport.name} names`, () => {
      const malformed: Array<{ label: string; entry: Record<string, unknown> }> = [
        { label: "missing", entry: { value: "literal" } },
        ...["", "  ", null, 0, false, {}, []].map((name) => ({
          label: JSON.stringify(name) ?? "undefined",
          entry: { name, value: "literal" },
        })),
      ];
      for (const { label, entry } of malformed) {
        assert.throws(
          () => boundary.parse([transport.input([entry])]),
          {
            message: `Invalid mcpServers[0] in ${boundary.source}.${transport.field}[0].name: expected non-empty string`,
          },
          label,
        );
      }
    });

    test(`${boundary.name} still rejects malformed ${transport.name} containers and entries`, () => {
      for (const value of ["literal", 1, {}]) {
        assert.throws(() => boundary.parse([transport.input(value)]), {
          message: `Invalid mcpServers[0] in ${boundary.source}.${transport.field}: expected array`,
        });
      }
      for (const entry of [null, false, "literal", []]) {
        assert.throws(() => boundary.parse([transport.input([entry])]), {
          message: `Invalid mcpServers[0] in ${boundary.source}.${transport.field}[0]: expected object`,
        });
      }
    });
  }
}

test("config-normalized MCP values survive the actual queue-owner JSON bootstrap parser", () => {
  const raw = TRANSPORTS.map((transport) =>
    transport.input(
      VALUES.map(({ value }, index) => ({ name: `${transport.pairName}${index}`, value })),
    ),
  );
  const configured = parseMcpServers(raw, "synthetic-mcp.json");
  const queued = parseQueueOwnerPayload(
    JSON.stringify({
      sessionId: "synthetic-mcp-values",
      permissionMode: "deny-all",
      mcpServers: configured,
    }),
  );
  assert.deepEqual(
    queued.mcpServers,
    TRANSPORTS.map((transport) =>
      transport.expected(
        VALUES.map(({ value }, index) => ({ name: `${transport.pairName}${index}`, value })),
      ),
    ),
  );
});

test("normalized stdio MCP shape without a type retains literal values", () => {
  const server: McpServer = {
    name: "synthetic-normalized-stdio",
    command: "/synthetic/unused-mcp-server",
    args: [],
    env: [{ name: "ACPX_SYNTHETIC_VALUE", value: "  prefix  " }],
  };
  for (const boundary of BOUNDARIES) {
    assert.deepEqual(boundary.parse([server]), [{ ...server, _meta: undefined }]);
  }
});
