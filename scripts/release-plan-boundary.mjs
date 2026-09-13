/**
 * Release-boundary test: the published acpx tarball must deliver structured
 * plan entries end to end. Packs this repo (npm pack runs prepack, like the
 * release workflow), installs the tarball into an empty directory with
 * production npm (like a consumer), then drives a real
 * createAcpRuntime/startTurn against a fixture ACP agent that emits a plan
 * notification with entries.
 *
 * Unit tests exercise src/ directly; this is the only check that proves the
 * shipped dist/ carries the plan projection.
 *
 * Usage: node ./scripts/release-plan-boundary.mjs [--keep-stage]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KEEP = process.argv.includes("--keep-stage");

function sh(cmd, args, options) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", timeout: 600_000, ...options });
}

const stage = mkdtempSync(join(tmpdir(), "acpx-release-plan-"));
const cleanup = () => {
  if (!KEEP) {
    rmSync(stage, { recursive: true, force: true });
  }
};
process.on("exit", cleanup);

const tarball = sh("npm", ["pack", "--pack-destination", stage], { cwd: REPO })
  .trim()
  .split("\n")
  .pop()
  .trim();
const tarballPath = join(stage, tarball);
console.log(`packed: ${tarballPath}`);

const installDir = join(stage, "install");
mkdirSync(installDir, { recursive: true });
sh("npm", ["init", "-y"], { cwd: installDir });
sh("npm", ["install", tarballPath, "--omit=dev", "--no-audit", "--no-fund"], { cwd: installDir });
console.log("tarball installed (production tree)");

writeFileSync(
  join(installDir, "plan-agent.mjs"),
  `import { createInterface } from "node:readline";
const write = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (sessionId, update) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const timer = setTimeout(() => process.exit(0), 120_000);
rl.on("line", (line) => {
  timer.refresh();
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.method !== "string") return;
  const { id, method, params } = msg;
  if (method === "initialize") {
    respond(id, { protocolVersion: 1, authMethods: [], agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { new: {}, load: {}, close: {}, cancel: {} } } });
  } else if (method === "session/new") {
    respond(id, { sessionId: "boundary-sid" });
  } else if (method === "session/prompt") {
    const sid = params?.sessionId ?? "boundary-sid";
    notify(sid, { sessionUpdate: "plan", entries: [
      { content: "write the file", status: "in_progress", priority: "high" },
      { content: "verify", status: "pending", priority: "low" },
    ] });
    notify(sid, { sessionUpdate: "plan", entries: [] });
    notify(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    respond(id, { stopReason: "end_turn" });
  } else if (id !== undefined) {
    respond(id, {});
  }
});
`,
);

writeFileSync(
  join(installDir, "plan-driver.mjs"),
  `const acpx = await import("acpx/runtime");
const dir = process.cwd();
const runtime = acpx.createAcpRuntime({
  cwd: dir,
  sessionStore: acpx.createRuntimeStore({ stateDir: dir + "/state" }),
  agentRegistry: acpx.createAgentRegistry({ overrides: { proof: ["node", dir + "/plan-agent.mjs"] } }),
  permissionMode: "approve-all",
});
const handle = await runtime.ensureSession({ sessionKey: "boundary", agent: "proof", mode: "persistent", cwd: dir });
const turn = runtime.startTurn({ handle, text: "hello" });
await turn.promptStarted;
for await (const event of turn.events) {
  if (event.type === "status" && event.tag === "plan") console.log(JSON.stringify(event));
}
await turn.result;
`,
);

const out = sh("node", ["plan-driver.mjs"], { cwd: installDir });
const plans = out
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const populated = plans.filter((e) => Array.isArray(e.entries) && e.entries.length === 2);
const cleared = plans.filter((e) => Array.isArray(e.entries) && e.entries.length === 0);
if (populated.length === 0) {
  console.error("FAIL: no populated plan snapshot in release-tree turn events.");
  console.error(out);
  process.exit(1);
}
if (cleared.length === 0) {
  console.error("FAIL: no explicit-empty plan replacement in release-tree turn events.");
  console.error(out);
  process.exit(1);
}
const first = populated[0].entries[0];
if (
  first.content !== "write the file" ||
  first.status !== "in_progress" ||
  first.priority !== "high"
) {
  console.error("FAIL: plan entries malformed in release-tree turn events.");
  console.error(out);
  process.exit(1);
}
console.log(
  "PASS: release tarball delivers structured plan snapshots (populated + explicit empty).",
);
