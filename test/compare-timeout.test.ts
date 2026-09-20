import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { AcpClient } from "../src/acp/client.js";
import { registerCompareCommand, type CompareRow } from "../src/cli/compare-command.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";

const config: ResolvedAcpxConfig = {
  defaultAgent: "fast",
  defaultPermissions: "deny-all",
  nonInteractivePermissions: "deny",
  authPolicy: "skip",
  ttlMs: 0,
  queueMaxDepth: 16,
  format: "json",
  agents: { fast: { command: "fast" }, slow: { command: "slow" } },
  auth: {},
  disableExec: false,
  mcpServers: [],
  globalPath: "unused-global-config",
  projectPath: "unused-project-config",
  hasGlobalConfig: false,
  hasProjectConfig: false,
};

for (const phase of ["start", "create", "prompt"] as const) {
  test(
    `compare preserves its ${phase} timeout and closes its clients`,
    { timeout: 5000 },
    async (t) => {
      const agents = phase === "prompt" ? ["fast", "slow"] : ["slow"];
      const clients = new Map<AcpClient, string>();
      const trace: string[] = [];
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previousExitCode = process.exitCode;
      t.after(() => {
        release();
        process.exitCode = previousExitCode;
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(AcpClient.prototype, "start", async function (this: AcpClient) {
        const agent = agents[clients.size];
        assert.ok(agent);
        clients.set(this, agent);
        trace.push(`${agent}:start`);
        if (phase === "start") {
          enter();
          await held;
        }
      });
      t.mock.method(AcpClient.prototype, "createSession", async function (this: AcpClient) {
        const agent = clients.get(this);
        trace.push(`${agent}:create`);
        if (phase === "create") {
          enter();
          await held;
        }
        return { sessionId: `${agent}-session` };
      });
      t.mock.method(AcpClient.prototype, "prompt", async function (this: AcpClient) {
        const agent = clients.get(this);
        trace.push(`${agent}:prompt`);
        if (agent === "slow") {
          enter();
          await held;
        }
        return { stopReason: "end_turn" };
      });
      t.mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
        trace.push(`${clients.get(this)}:close`);
      });
      let stdout = "";
      t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
        stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      });
      const program = new Command();
      registerCompareCommand(program, config);
      const running = program.parseAsync(
        ["compare", ...agents, "--timeout", "0.5", "--json", "summarize"],
        { from: "user" },
      );
      await entered;
      const expectedBeforeTimeout =
        phase === "start"
          ? ["slow:start"]
          : phase === "create"
            ? ["slow:start", "slow:create"]
            : [
                "fast:start",
                "fast:create",
                "fast:prompt",
                "fast:close",
                "slow:start",
                "slow:create",
                "slow:prompt",
              ];
      assert.deepEqual(trace, expectedBeforeTimeout);
      assert.equal(stdout, "");
      t.mock.timers.tick(500);
      await running;
      const rows = JSON.parse(stdout) as CompareRow[];
      assert.deepEqual(
        rows.map((row) => [row.agent, row.status]),
        phase === "prompt"
          ? [
              ["fast", "ok"],
              ["slow", "cancelled"],
            ]
          : [["slow", "cancelled"]],
      );
      if (phase === "prompt") {
        assert.equal(rows[0]?.stop_reason, "end_turn");
        assert.equal(rows[0]?.error, null);
      }
      assert.equal(rows.at(-1)?.stop_reason, null);
      assert.equal(rows.at(-1)?.error, "Timed out after 500ms");
      assert.equal(process.exitCode, 3);
      assert.deepEqual(trace, [...expectedBeforeTimeout, "slow:close"]);
    },
  );
}
