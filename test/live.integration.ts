import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AdapterLifetime } from "../conformance/runner/adapter-lifetime.js";
import { listBuiltInAgents } from "../src/agent-registry.js";
import { withInterrupt, withTimeout } from "../src/async-control.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0z8AAAAASUVORK5CYII=";
const builtIns = listBuiltInAgents();
const selected = process.env.ACPX_LIVE_AGENTS;
const agents =
  selected === undefined ? builtIns : [...new Set(selected.split(",").map((s) => s.trim()))];
assert.ok(
  agents.length > 0 && agents.every((id) => builtIns.includes(id)),
  "ACPX_LIVE_AGENTS must be a comma-separated list of built-in agent IDs",
);

for (const agent of agents) {
  test(`live CLI: ${agent} returns a fresh nonce`, async () => {
    const nonce = `acpx_live_${randomUUID().replaceAll("-", "")}`;
    const stdout = await runLivePrompt(agent, [
      { type: "text", text: `Reply with exactly ${nonce}. Do not use tools.` },
    ]);
    assert.ok(stdout.includes(nonce), "agent response must contain the requested nonce");
  });
}

if (agents.includes("cursor")) {
  test("live CLI: Cursor accepts a structured image prompt", async () => {
    const stdout = await runLivePrompt("cursor", [
      {
        type: "text",
        text: "Reply briefly once this prompt and image are received. Do not use tools.",
      },
      { type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 },
    ]);
    assert.ok(stdout.trim().length > 0, "expected an agent response to the image prompt");
  });
}

async function runLivePrompt(agent: string, prompt: unknown[]): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acpx-live-")));
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const env = {
    ...process.env,
    HOME: home,
    ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
  };
  let lifetime: AdapterLifetime | undefined;
  try {
    await fs.mkdir(home);
    await fs.mkdir(cwd);
    await promisify(execFile)("git", ["init", "--quiet", "--initial-branch=main", cwd], {
      env,
      timeout: 10_000,
    });
    await promisify(execFile)(
      "git",
      [
        "-c",
        "user.name=acpx live fixture",
        "-c",
        "user.email=acpx@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Live provider fixture",
      ],
      { cwd, env, timeout: 10_000 },
    );
    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        "--deny-all",
        "--no-fs",
        "--no-terminal",
        "--cwd",
        cwd,
        "--timeout",
        "120",
        "--format",
        "quiet",
        agent,
        "exec",
      ],
      {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const owner = new AdapterLifetime(child);
    lifetime = owner;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const result = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
      child.stdin.once("error", reject);
    });
    child.stdin.end(JSON.stringify(prompt));
    const code = await withInterrupt(
      () => withTimeout(result, 150_000),
      () => owner.shutdown(Promise.resolve()),
    );
    assert.equal(code, 0, `${agent} CLI failed: ${stderr}`);
    return stdout;
  } finally {
    // Join the CLI and witnessed descendants before deleting their workspace.
    // A failed retirement deliberately retains the directory for diagnosis.
    await lifetime?.shutdown(Promise.resolve());
    await fs.rm(root, { recursive: true, force: true });
  }
}
