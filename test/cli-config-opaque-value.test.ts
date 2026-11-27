import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerSharedAgentSubcommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";

// Public ACPX #1005: real production command registration / Commander argument
// parsing with ONLY the action callback replaced. No ACP connection, agent
// process, real home, session, provider or credentials are created.
async function parseSyntheticSet(parts: string[]): Promise<{ key: string; value: string }> {
  const app = new Command("acpx");
  app.exitOverride();
  app.configureOutput({ writeOut: () => {}, writeErr: () => {} });

  const agent = app.command("synthetic");
  registerSharedAgentSubcommands(agent, "synthetic", {} as ResolvedAcpxConfig, {
    prompt: "synthetic prompt",
    exec: "synthetic exec",
    cancel: "synthetic cancel",
    setMode: "synthetic mode",
    setConfig: "synthetic config",
    status: "synthetic status",
  });
  const setCommand = agent.commands.find((command) => command.name() === "set");
  assert.ok(setCommand, "real ACPX set command must be registered");
  let captured: { key: string; value: string } | undefined;
  // Replace the real handler to isolate the public CLI argument boundary.
  setCommand.action((key: string, value: string) => {
    assert.equal(captured, undefined, "must invoke exactly one synthetic receiver");
    captured = { key, value };
  });

  await app.parseAsync(["node", "acpx", "synthetic", "set", ...parts], {
    from: "node",
  });
  assert.ok(captured, "production argument parser must reach its receiver");
  return captured;
}

test("acpx #1005: non-model option must preserve exact padded value", async () => {
  const actual = await parseSyntheticSet(["verbosity", " compact "]);
  assert.deepEqual(actual, { key: "verbosity", value: " compact " });
});

test("acpx #1005 control: ordinary non-model option passes unchanged", async () => {
  const actual = await parseSyntheticSet(["verbosity", "compact"]);
  assert.deepEqual(actual, { key: "verbosity", value: "compact" });
});

test("acpx #1005 control: existing key normalization remains separate", async () => {
  const actual = await parseSyntheticSet([" verbosity ", "compact"]);
  assert.deepEqual(actual, { key: "verbosity", value: "compact" });
});
