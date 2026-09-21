import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseReport, runRunner } from "./conformance-test-helpers.js";

type Scenario = {
  name: string;
  reply: Record<string, unknown>;
  accepted: boolean;
  diagnostic?: RegExp;
};

type WireEntry = {
  kind: "boot" | "received" | "attempted" | "completed";
  pid: number;
  line?: string;
};

type Message = {
  jsonrpc: string;
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
};

const invalidCapabilities: Array<[string, unknown]> = [
  ["string", "synthetic-invalid-capabilities"],
  ["array", []],
  ["null", null],
  ["number", 42],
  ["boolean", false],
];

const scenarios: Scenario[] = [
  {
    name: "omitted capabilities",
    reply: { result: { protocolVersion: 1 } },
    accepted: true,
  },
  {
    name: "empty capabilities object",
    reply: { result: { protocolVersion: 1, agentCapabilities: {} } },
    accepted: true,
  },
  {
    name: "capabilities object with ordinary and extension members",
    reply: {
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, _meta: { syntheticExtension: "preserved" } },
      },
    },
    accepted: true,
  },
  ...invalidCapabilities.map(([name, agentCapabilities]) => ({
    name: `${name} capabilities`,
    reply: { result: { protocolVersion: 1, agentCapabilities } },
    accepted: false,
    diagnostic: /initialize.*agentCapabilities.*object/i,
  })),
  {
    name: "ordinary initialize RPC error",
    reply: { error: { code: -32077, message: "synthetic initialize rejection" } },
    accepted: false,
    diagnostic: /synthetic initialize rejection/,
  },
];

const PEER_SOURCE = String.raw`
import fs from "node:fs";
import readline from "node:readline";
const [specPath, wirePath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
function record(kind, line) {
  fs.appendFileSync(wirePath, JSON.stringify({ kind, pid: process.pid, ...(line === undefined ? {} : { line }) }) + "\n");
}
record("boot");
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  record("received", line);
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const response = request.method === "initialize"
    ? { jsonrpc: "2.0", id: request.id, ...spec.reply }
    : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unexpected fixture method" } };
  const raw = JSON.stringify(response);
  record("attempted", raw);
  await new Promise((resolve, reject) => process.stdout.write(raw + "\n", error => {
    if (error) { reject(error); return; }
    record("completed", raw);
    resolve();
  }));
}
`;

for (const scenario of scenarios) {
  test(`conformance initialize checks ${scenario.name}`, { timeout: 30_000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-capabilities-"));
    t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
    const peerPath = path.join(directory, "peer.mjs");
    const specPath = path.join(directory, "spec.json");
    const wirePath = path.join(directory, "wire.ndjson");
    const reportPath = path.join(directory, "report.json");
    await fs.writeFile(peerPath, PEER_SOURCE, "utf8");
    await fs.writeFile(specPath, JSON.stringify({ reply: scenario.reply }), "utf8");
    const command = [process.execPath, peerPath, specPath, wirePath]
      .map((argument) => JSON.stringify(argument))
      .join(" ");
    const result = await runRunner(
      [
        "--case",
        "acp.v1.initialize.handshake",
        "--cwd",
        directory,
        "--agent-command",
        command,
        "--format",
        "json",
        "--report",
        reportPath,
      ],
      { timeoutMs: 20_000, home: directory },
    );

    // Establish the actual response stimulus before judging the runner's result.
    const entries = (await fs.readFile(wirePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WireEntry);
    const requests = entries
      .filter((entry) => entry.kind === "received")
      .map((entry) => JSON.parse(entry.line!) as Message);
    const responses = entries
      .filter((entry) => entry.kind === "attempted")
      .map((entry) => JSON.parse(entry.line!) as Message);
    assert.equal(requests.length, 1, "handshake must not run unrelated ACP operations");
    assert.equal(requests[0].method, "initialize");
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0], {
      jsonrpc: "2.0",
      id: requests[0].id,
      ...scenario.reply,
    });

    const report = parseReport(result.stdout);
    const savedReport = parseReport(await fs.readFile(reportPath, "utf8"));
    assert.deepEqual(savedReport, report, "stdout and saved case reports must agree");
    assert.equal(result.code, scenario.accepted ? 0 : 1, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: scenario.accepted ? 1 : 0,
      failed: scenario.accepted ? 0 : 1,
    });
    assert.equal(report.results[0]?.id, "acp.v1.initialize.handshake");
    assert.equal(report.results[0]?.passed, scenario.accepted);
    if (scenario.diagnostic) {
      assert.match(report.results[0]?.error ?? "", scenario.diagnostic);
    } else {
      assert.equal(report.results[0]?.error, undefined);
    }
  });
}
