import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const agent = `node ${JSON.stringify(fileURLToPath(new URL("./mock-agent.js", import.meta.url)))} --supports-load-session`;

type Result = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

async function fixture(
  run: (
    home: string,
    execute: (args: string[], input?: string, metrics?: string) => Promise<Result>,
  ) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-input-integrity-"));
  const observer = path.join(home, "observe-stdin.mjs");
  await fs.mkdir(path.join(home, ".acpx"));
  await fs.writeFile(
    path.join(home, ".acpx/config.json"),
    JSON.stringify({ agents: { codex: { command: agent }, claude: { command: agent } } }),
  );
  // Observe native pipe reads without changing their bytes or chunk boundaries.
  await fs.writeFile(
    observer,
    `
    process.umask(0o002);
    const read = process.stdin.read;
    process.stdin.read = function (...args) {
      const chunk = Reflect.apply(read, this, args);
      if (chunk !== null) process.stderr.write("INPUT_CHUNK\\n");
      return chunk;
    };
  `,
  );
  const execute = async (args: string[], input?: string, metrics?: string): Promise<Result> => {
    const child = spawn(
      process.execPath,
      ["--import", observer, cli, "--cwd", home, "--deny-all", "--ttl", "0", ...args],
      {
        env: { ...process.env, HOME: home, ACPX_PERF_METRICS_FILE: metrics ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      sentTail = false;
    const bytes = input === undefined ? undefined : Buffer.from(input);
    const split = bytes ? bytes.indexOf(Buffer.from("🦞")) + 1 : 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (bytes && !sentTail && stderr.includes("INPUT_CHUNK")) {
        sentTail = true;
        child.stdin.end(bytes.subarray(split));
      }
    });
    child.stdin.on("error", () => {});
    if (bytes) {
      child.stdin.write(bytes.subarray(0, split));
    } else {
      child.stdin.end();
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      return await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    await run(home, execute);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

for (const mode of ["exec", "prompt", "compare", "structured", "file-stdin"] as const) {
  test(`${mode} preserves UTF-8 split across stdin pipe reads`, async () => {
    await fixture(async (_home, execute) => {
      if (mode === "prompt") {
        const created = await execute(["sessions", "new"]);
        assert.equal(created.code, 0, created.stderr);
      }
      try {
        const args =
          mode === "compare"
            ? ["--format", "json", "compare", "codex", "claude", "--file", "-"]
            : [
                "--format",
                "quiet",
                mode === "prompt" ? "prompt" : "exec",
                ...(mode === "file-stdin" ? ["--file", "-", "suffix"] : []),
              ];
        const input =
          mode === "structured"
            ? JSON.stringify([{ type: "text", text: "echo 🦞 café" }])
            : "echo 🦞 café";
        const result = await execute(args, input);
        assert.equal(result.code, 0, result.stderr);
        if (mode === "compare") {
          const rows = JSON.parse(result.stdout) as { final_message: string }[];
          assert.deepEqual(
            rows.map((row) => row.final_message),
            ["🦞 café", "🦞 café"],
          );
        } else {
          assert.equal(result.stdout.trim(), mode === "file-stdin" ? "🦞 cafésuffix" : "🦞 café");
        }
      } finally {
        if (mode === "prompt") {
          const closed = await execute(["sessions", "close"]);
          assert.equal(closed.code, 0, closed.stderr);
        }
      }
    });
  });
}

test("diagnostic captures keep prompt-bearing files private on creation and append", async () => {
  await fixture(async (home, execute) => {
    const directory = path.join(home, "shared-diagnostics");
    await fs.mkdir(directory);
    if (process.platform !== "win32") {
      await fs.chmod(directory, 0o775);
    }
    const output = path.join(directory, "metrics.ndjson");
    for (const existing of [false, true]) {
      if (existing && process.platform !== "win32") {
        await fs.chmod(output, 0o664);
      }
      const result = await execute(
        ["--format", "quiet", "exec", "echo SYNTHETIC_PRIVATE_PROMPT"],
        undefined,
        output,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(await fs.readFile(output, "utf8"), /SYNTHETIC_PRIVATE_PROMPT/);
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o775);
      }
    }
  });
});

test(
  "a diagnostic FIFO cannot hold a completed CLI open",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(async (home, execute) => {
      const fifo = path.join(home, "metrics.pipe");
      const created = spawn("mkfifo", [fifo]);
      assert.equal(
        await new Promise((resolve, reject) => {
          created.once("error", reject);
          created.once("close", resolve);
        }),
        0,
      );
      const result = await execute(["--format", "quiet", "exec", "echo complete"], undefined, fifo);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout.trim(), "complete");
      assert.equal((await fs.lstat(fifo)).isFIFO(), true);
    });
  },
);

for (const linkType of ["symlink", "hardlink"] as const) {
  test(
    `diagnostic capture skips ${linkType} targets without modifying their contents`,
    { skip: process.platform === "win32" },
    async () => {
      await fixture(async (home, execute) => {
        const target = path.join(home, "linked.txt");
        const alias = path.join(home, "metrics-link");
        await fs.writeFile(target, "SYNTHETIC_EXISTING_CONTENT");
        if (linkType === "symlink") {
          await fs.symlink(target, alias);
        } else {
          await fs.link(target, alias);
        }
        const result = await execute(
          ["--format", "quiet", "exec", "echo complete"],
          undefined,
          alias,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout.trim(), "complete");
        assert.equal(await fs.readFile(target, "utf8"), "SYNTHETIC_EXISTING_CONTENT");
      });
    },
  );
}
