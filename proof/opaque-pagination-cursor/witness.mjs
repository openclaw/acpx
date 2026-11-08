import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const load = (relative) => import(pathToFileURL(path.join(manifest.sourceRoot, relative)).href);
const { Command } = await load("node_modules/commander/index.js");
const { registerSessionsCommand } = await load("src/cli/command-registration.ts");
const { addGlobalFlags, resolveSessionsListFlags } = await load("src/cli/flags.ts");
const { AcpClient } = await load("src/acp/client.ts");
const { zListSessionsRequest, zListSessionsResponse } = await load(
  "node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js",
);
const rows = [];
let active;
const originalStart = AcpClient.prototype.start;
const originalClose = AcpClient.prototype.close;
AcpClient.prototype.start = async function () {
  active.startCalls++;
  this.initResult = { agentCapabilities: { sessionCapabilities: { list: {} } } };
  this.connection = {
    agent: {
      request: async (method, params) => {
        assert.equal(method, "session/list");
        active.requests.push({
          method,
          params: structuredClone(params),
          schemaValid: zListSessionsRequest.safeParse(params).success,
        });
        return zListSessionsResponse.parse({ sessions: [] });
      },
    },
  };
};
AcpClient.prototype.close = async function () {
  active.closeCalls++;
};
const config = {
  defaultAgent: "synthetic",
  defaultPermissions: "deny-all",
  nonInteractivePermissions: "deny",
  authPolicy: "skip",
  ttlMs: 300000,
  queueMaxDepth: 16,
  format: "json",
  agents: { synthetic: { argv: ["fictional-adapter-never-launched"] } },
  auth: {},
  disableExec: false,
  mcpServers: [],
  globalPath: path.join(manifest.root, "absent-global.json"),
  projectPath: path.join(manifest.root, "absent-project.json"),
  hasGlobalConfig: false,
  hasProjectConfig: false,
};
const originalWrite = process.stdout.write;
try {
  for (const [label, token] of [
    ["ordinary", "page-2"],
    ["padded", " page-2 "],
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace", " \t "],
  ]) {
    const produced = token === undefined ? { sessions: [] } : { sessions: [], nextCursor: token };
    const producer = zListSessionsResponse.safeParse(produced);
    assert.equal(producer.success, true);
    active = {
      label,
      returnedToken: token ?? null,
      producerSchemaValid: producer.success,
      parsedToken: null,
      requests: [],
      startCalls: 0,
      closeCalls: 0,
      output: "",
      error: null,
    };
    const program = addGlobalFlags(new Command("acpx")).exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerSessionsCommand(program, "synthetic", config);
    const sessionCommand = program.commands.find((c) => c.name() === "sessions");
    const list = sessionCommand.commands.find((c) => c.name() === "list");
    list.hook("preAction", (command) => {
      active.childParsedToken = command.opts().cursor ?? null;
      active.parentParsedToken = command.parent.opts().cursor ?? null;
      active.parsedToken = resolveSessionsListFlags(command.opts(), command).cursor ?? null;
    });
    process.stdout.write = (chunk, ...args) => {
      active.output += String(chunk);
      const callback = args.find((v) => typeof v === "function");
      callback?.();
      return true;
    };
    const args = ["--cwd", manifest.root, "sessions", "list"];
    if (token !== undefined) args.push("--cursor", producer.data.nextCursor);
    try {
      await program.parseAsync(args, { from: "user" });
    } catch (error) {
      active.error = { name: error.name, code: error.code, message: error.message };
    }
    process.stdout.write = originalWrite;
    rows.push(active);
  }
} finally {
  process.stdout.write = originalWrite;
  AcpClient.prototype.start = originalStart;
  AcpClient.prototype.close = originalClose;
}
fs.writeFileSync(
  path.join(manifest.root, "OBSERVED.json"),
  JSON.stringify({ rows }, null, 2) + "\n",
);
assert.deepEqual(rows[0].requests[0].params, { cursor: "page-2" });
assert.equal(rows[1].returnedToken, " page-2 ");
assert.equal(rows[1].parsedToken, rows[1].requests[0].params.cursor);
const identityPreserved = rows[1].requests[0].params.cursor === rows[1].returnedToken;
assert.deepEqual(rows[2].requests[0].params, {});
for (const row of rows.slice(3)) {
  assert.equal(row.requests.length, 0);
  assert.equal(row.startCalls, 0);
  assert.equal(row.error.code, "commander.invalidArgument");
}
assert.ok(
  rows.slice(0, 3).every((row) => row.requests.length === 1 && row.requests[0].schemaValid),
);
fs.writeFileSync(
  path.join(manifest.root, "RESULT.json"),
  JSON.stringify(
    {
      status: identityPreserved ? "CONTRACT_PASS" : "CONTRACT_FAIL",
      rows,
      seams: [
        "Only AcpClient.start/close replaced; real registration, Commander parser, handler, session list request construction and AcpClient.listSessions/runConnectionRequest retained.",
        "Connection agent.request is an injected schema-valid capture sink. No SDK transport, adapter or provider process exists.",
      ],
      limits: [
        "Synthetic producer tokens, no live adapter compatibility claim",
        "Empty/whitespace-only schema values are CLI-rejected; disposition separate from demonstrated padded nonempty change",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    status: identityPreserved ? "CONTRACT_PASS" : "CONTRACT_FAIL",
    cases: rows.length,
    actualRequests: rows.reduce((n, r) => n + r.requests.length, 0),
  }),
);

process.exitCode = identityPreserved ? 0 : 1;
