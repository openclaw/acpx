import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initGlobalConfigFile, loadResolvedConfig } from "../src/cli/config.js";

test("loadResolvedConfig merges global and project config with project priority", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "codex",
          defaultPermissions: "deny-all",
          nonInteractivePermissions: "fail",
          authPolicy: "fail",
          ttl: 15,
          timeout: 30,
          queueMaxDepth: 9,
          format: "json",
          agents: {
            custom: { command: "global-custom" },
          },
          auth: {
            global_method: "global-token",
          },
          mcpServers: [
            {
              name: "global-http",
              type: "http",
              url: "https://global.example/mcp",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await fs.writeFile(
      path.join(cwd, ".acpxrc.json"),
      `${JSON.stringify(
        {
          defaultPermissions: "approve-all",
          nonInteractivePermissions: "deny",
          authPolicy: "skip",
          ttl: 42,
          timeout: null,
          queueMaxDepth: 5,
          format: "quiet",
          agents: {
            custom: { command: "project-custom" },
            extra: { command: "./bin/extra" },
          },
          auth: {
            global_method: "project-override",
            project_method: "project-token",
          },
          mcpServers: [
            {
              name: "project-stdio",
              type: "stdio",
              command: "./bin/project-mcp",
              args: ["--serve"],
              env: [{ name: "TOKEN", value: "secret" }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.defaultAgent, "codex");
    assert.equal(config.defaultPermissions, "approve-all");
    assert.equal(config.nonInteractivePermissions, "deny");
    assert.equal(config.authPolicy, "skip");
    assert.equal(config.ttlMs, 42_000);
    assert.equal(config.timeoutMs, undefined);
    assert.equal(config.queueMaxDepth, 5);
    assert.equal(config.format, "quiet");
    assert.deepEqual(config.agents, {
      custom: "project-custom",
      extra: "./bin/extra",
    });
    assert.deepEqual(config.auth, {
      global_method: "project-override",
      project_method: "project-token",
    });
    assert.deepEqual(config.mcpServers, [
      {
        name: "project-stdio",
        command: "./bin/project-mcp",
        args: ["--serve"],
        env: [{ name: "TOKEN", value: "secret" }],
        _meta: undefined,
      },
    ]);
    assert.equal(config.hasGlobalConfig, true);
    assert.equal(config.hasProjectConfig, true);
  });
});

test("loadResolvedConfig rejects invalid mcpServers config", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          mcpServers: [{ name: "bad-http", type: "http", url: 123 }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await assert.rejects(async () => await loadResolvedConfig(cwd), {
      message: /Invalid mcpServers\[0\] in .*\.url: expected non-empty string/,
    });
  });
});

test("initGlobalConfigFile creates the config once and then reports existing file", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const first = await initGlobalConfigFile();
    assert.equal(first.created, true);
    assert.equal(first.path, path.join(homeDir, ".acpx", "config.json"));

    const second = await initGlobalConfigFile();
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);

    const payload = JSON.parse(await fs.readFile(first.path, "utf8")) as {
      defaultAgent: string;
      defaultPermissions: string;
      nonInteractivePermissions: string;
      authPolicy: string;
      queueMaxDepth: number;
    };
    assert.equal(payload.defaultAgent, "codex");
    assert.equal(payload.defaultPermissions, "approve-all");
    assert.equal(payload.nonInteractivePermissions, "deny");
    assert.equal(payload.authPolicy, "skip");
    assert.equal(payload.queueMaxDepth, 16);
  });
});

test("loadResolvedConfig defaults disableExec to false", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.disableExec, false);
  });
});

test("loadResolvedConfig parses disableExec from global config", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ disableExec: true }, null, 2)}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.disableExec, true);
  });
});

test("loadResolvedConfig parses disableExec from project config with priority", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ disableExec: true }, null, 2)}\n`,
      "utf8",
    );

    await fs.writeFile(
      path.join(cwd, ".acpxrc.json"),
      `${JSON.stringify({ disableExec: false }, null, 2)}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.disableExec, false);
  });
});

test("loadResolvedConfig rejects invalid disableExec value", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ disableExec: "yes" }, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(async () => {
      await loadResolvedConfig(cwd);
    }, /Invalid config disableExec.*expected boolean/);
  });
});

async function withTempEnv(run: (ctx: { homeDir: string }) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-config-home-"));
  process.env.HOME = homeDir;

  try {
    await run({ homeDir });
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
