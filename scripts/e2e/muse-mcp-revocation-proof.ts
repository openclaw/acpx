import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeHandle,
} from "../../src/runtime.js";

const require = createRequire(import.meta.url);
const ProbeEventSchema = z.object({ event: z.enum(["start", "call", "exit"]), pid: z.number() });
const WireEventSchema = z.object({
  method: z.literal("session/resume"),
  sessionId: z.string(),
  explicit: z.boolean(),
  serverCount: z.number().nullable(),
  serverNames: z.array(z.string()),
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}

async function readWhenReady(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${path.basename(filePath)}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function statusPid(summary: string): number | undefined {
  const match = summary.match(/(?:^| )pid=(\d+)(?: |$)/);
  return match ? Number(match[1]) : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function writeProbeServer(serverPath: string): Promise<void> {
  const mcpPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdioPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(mcpPath)};
import { StdioServerTransport } from ${JSON.stringify(stdioPath)};

const valueFile = process.env.PROBE_VALUE_FILE;
const eventFile = process.env.PROBE_EVENT_FILE;
if (!valueFile || !eventFile) throw new Error("probe verifier paths are required");
const value = "muse-revocation-" + randomUUID();
writeFileSync(valueFile, value, { encoding: "utf8", mode: 0o600 });
chmodSync(valueFile, 0o600);
const record = (event) => appendFileSync(
  eventFile,
  JSON.stringify({ event, pid: process.pid }) + "\\n",
  "utf8",
);
record("start");
process.once("exit", () => record("exit"));
process.stdin.once("end", () => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));
const server = new McpServer({ name: "muse-revocation-proof", version: "1.0.0" });
server.tool("revocation_probe", "Return a verifier-only random value.", async () => {
  record("call");
  return { content: [{ type: "text", text: value }] };
});
await server.connect(new StdioServerTransport());
`,
    { encoding: "utf8", mode: 0o700 },
  );
}

async function writeAdapterProxy(proxyPath: string, adapterEntry: string): Promise<void> {
  await fs.writeFile(
    proxyPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const wireFile = process.env.MUSE_PROXY_WIRE_FILE;
const stderrFile = process.env.MUSE_PROXY_STDERR_FILE;
const pidFile = process.env.MUSE_PROXY_PID_FILE;
if (!wireFile || !stderrFile || !pidFile) throw new Error("proxy verifier paths are required");
writeFileSync(pidFile, String(process.pid), { encoding: "utf8", mode: 0o600 });
const child = spawn(process.execPath, [${JSON.stringify(adapterEntry)}], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\n");
    if (end < 0) break;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    try {
      const message = JSON.parse(line);
      if (message?.method !== "session/resume") continue;
      const servers = message.params?.mcpServers;
      appendFileSync(wireFile, JSON.stringify({
        method: message.method,
        sessionId: message.params?.sessionId,
        explicit: Object.hasOwn(message.params ?? {}, "mcpServers"),
        serverCount: Array.isArray(servers) ? servers.length : null,
        serverNames: Array.isArray(servers) ? servers.map((server) => server?.name) : [],
      }) + "\\n", "utf8");
    } catch {}
  }
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.on("data", (chunk) => appendFileSync(stderrFile, chunk));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.once("error", (error) => {
  appendFileSync(stderrFile, (error.stack ?? error.message) + "\\n", "utf8");
  process.exit(1);
});
`,
    { encoding: "utf8", mode: 0o700 },
  );
}

async function runTurn(
  runtime: ReturnType<typeof createAcpRuntime>,
  handle: AcpRuntimeHandle,
  requestId: string,
  text: string,
  mcpServers: Parameters<typeof runtime.startTurn>[0]["mcpServers"],
): Promise<{ text: string; status: string }> {
  const turn = runtime.startTurn({ handle, requestId, text, mcpServers, mode: "prompt" });
  let output = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta" && event.stream === "output") {
      output += event.text;
    }
  }
  return { text: output.trim(), status: (await turn.result).status };
}

async function main(): Promise<void> {
  if (!process.env.META_API_KEY) {
    throw new Error("META_API_KEY is required");
  }
  const adapterEntry = path.resolve(requiredEnv("MUSE_CODE_ACP_ENTRY"));
  const adapterCommit = requiredEnv("MUSE_CODE_ACP_COMMIT");
  const evidencePath = path.resolve(requiredEnv("MUSE_REVOCATION_EVIDENCE_PATH"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-live-muse-revocation-"));
  const workspace = path.join(root, "workspace");
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  const valueFile = path.join(root, "probe-value");
  const eventFile = path.join(root, "probe-events.ndjson");
  const wireFile = path.join(root, "wire.ndjson");
  const proxyStderrFile = path.join(root, "proxy.stderr");
  const proxyPidFile = path.join(root, "proxy.pid");
  const probePath = path.join(root, "probe.mjs");
  const proxyPath = path.join(root, "proxy.mjs");
  const firstPrompt =
    "Call the MCP tool revocation_probe exactly once now. Reply with only its returned text. Do not guess.";
  const secondPrompt =
    "Try to call the MCP tool revocation_probe exactly once now. If it is unavailable, reply exactly NO_TOOL. Do not reuse any earlier value.";
  await fs.mkdir(path.join(configHome, "muse"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(configHome, "muse", "settings.json"),
    `${JSON.stringify({ schema_version: 1, mcp_servers: {} })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeProbeServer(probePath);
  await writeAdapterProxy(proxyPath, adapterEntry);
  Object.assign(process.env, {
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    MUSE_CODE_ACP_ALLOW_YOLO: "1",
    MUSE_PROXY_WIRE_FILE: wireFile,
    MUSE_PROXY_STDERR_FILE: proxyStderrFile,
    MUSE_PROXY_PID_FILE: proxyPidFile,
  });

  const runtime = createAcpRuntime({
    cwd: workspace,
    sessionStore: createFileSessionStore({ stateDir: path.join(root, "state") }),
    agentRegistry: createAgentRegistry({ overrides: { muse: [process.execPath, proxyPath] } }),
    permissionMode: "approve-all",
    timeoutMs: 120_000,
  });
  let handle: AcpRuntimeHandle | undefined;
  try {
    handle = await runtime.ensureSession({
      sessionKey: `muse-live-revocation-${randomUUID()}`,
      agent: "muse",
      mode: "persistent",
      cwd: workspace,
    });
    await runtime.setMode({ handle, mode: "bypassApprovals" });
    const proxyPid = Number((await readWhenReady(proxyPidFile)).trim());
    const snapshot = [
      {
        name: "authority-proof",
        command: process.execPath,
        args: [probePath],
        env: [
          { name: "PROBE_VALUE_FILE", value: valueFile },
          { name: "PROBE_EVENT_FILE", value: eventFile },
        ],
      },
    ];
    const first = await runTurn(runtime, handle, "grant", firstPrompt, snapshot);
    const value = (await readWhenReady(valueFile)).trim();
    const firstStatus = await runtime.getStatus({ handle });
    const second = await runTurn(runtime, handle, "revoke", secondPrompt, []);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const secondStatus = await runtime.getStatus({ handle });
    const probeEvents = (await readWhenReady(eventFile))
      .trim()
      .split("\n")
      .map((line) => ProbeEventSchema.parse(JSON.parse(line)));
    const wireEvents = (await readWhenReady(wireFile))
      .trim()
      .split("\n")
      .map((line) => WireEventSchema.parse(JSON.parse(line)));
    const resumeSnapshots = wireEvents.slice(-2);
    const probeStarts = probeEvents.filter((event) => event.event === "start");
    const probeCalls = probeEvents.filter((event) => event.event === "call");
    const probePid = probeStarts[0]?.pid;
    const evidence = {
      acpxCommit: commandOutput("git", ["rev-parse", "HEAD"]),
      adapterCommit,
      museVersion: commandOutput("muse", ["--version"]),
      publicEntrypoint: "createAcpRuntime().startTurn",
      firstTurnCompleted: first.status === "completed",
      firstReplyMatchedVerifierValue: first.text === value,
      verifierValueSha256: sha256(value),
      verifierValueAbsentFromPrompts: !firstPrompt.includes(value) && !secondPrompt.includes(value),
      verifierValueAbsentFromSnapshot: !JSON.stringify(snapshot).includes(value),
      secondTurnCompleted: second.status === "completed",
      secondReply: second.text === "NO_TOOL" ? "NO_TOOL" : "tool unavailable (sanitized)",
      secondReplyDidNotReuseValue: !second.text.includes(value),
      sameBackendSession: firstStatus.backendSessionId === secondStatus.backendSessionId,
      sameAgentProcess:
        Number.isInteger(proxyPid) &&
        statusPid(firstStatus.summary) === proxyPid &&
        statusPid(secondStatus.summary) === proxyPid,
      resumeSnapshots: resumeSnapshots.map((entry) => ({
        explicit: entry.explicit,
        serverCount: entry.serverCount,
        serverNames: entry.serverNames,
      })),
      finalProbeStartCount: probeStarts.length,
      finalProbeCallCount: probeCalls.length,
      probeProcessAliveAfterRevocation:
        typeof probePid === "number" ? processIsAlive(probePid) : null,
    };
    const passed =
      evidence.firstTurnCompleted &&
      evidence.firstReplyMatchedVerifierValue &&
      evidence.verifierValueAbsentFromPrompts &&
      evidence.verifierValueAbsentFromSnapshot &&
      evidence.secondTurnCompleted &&
      evidence.secondReply === "NO_TOOL" &&
      evidence.secondReplyDidNotReuseValue &&
      evidence.sameBackendSession &&
      evidence.sameAgentProcess &&
      evidence.resumeSnapshots[0]?.explicit &&
      evidence.resumeSnapshots[0]?.serverCount === 1 &&
      evidence.resumeSnapshots[1]?.explicit &&
      evidence.resumeSnapshots[1]?.serverCount === 0 &&
      evidence.finalProbeStartCount === 1 &&
      evidence.finalProbeCallCount === 1 &&
      evidence.probeProcessAliveAfterRevocation === false;
    const report = { passed, ...evidence };
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!passed) {
      throw new Error("live Muse grant/revocation proof failed; inspect private artifacts");
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    if (handle) {
      await runtime.close({ handle, reason: "live proof complete" }).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "live proof failed"}\n`);
  process.exitCode = 1;
});
