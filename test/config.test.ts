import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAgentCommandParts, splitCommandLine } from "../src/acp/client-process.js";
import { initGlobalConfigFile, loadResolvedConfig, toConfigDisplay } from "../src/cli/config.js";

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
      custom: { command: "project-custom" },
      extra: { command: "./bin/extra" },
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

test("loadResolvedConfig normalizes timer values through the CLI timer boundary", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    const configPath = path.join(homeDir, ".acpx", "config.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    await fs.writeFile(configPath, `${JSON.stringify({ ttl: 0.0001, timeout: 0.0001 })}\n`);
    const config = await loadResolvedConfig(cwd);
    assert.equal(config.ttlMs, 1);
    assert.equal(config.timeoutMs, 1);
    assert.equal(toConfigDisplay(config).ttl, 0.001);
    assert.equal(toConfigDisplay(config).timeout, 0.001);

    await fs.writeFile(configPath, `${JSON.stringify({ ttl: 2_147_483.648 })}\n`);
    await assert.rejects(loadResolvedConfig(cwd), /ttl.*maximum supported timer delay/u);

    await fs.writeFile(configPath, `${JSON.stringify({ timeout: 2_147_483.648 })}\n`);
    await assert.rejects(loadResolvedConfig(cwd), /timeout.*maximum supported timer delay/u);
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

test("loadResolvedConfig uses an explicit MCP config path without project config", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    const mcpConfigPath = path.join(homeDir, "job", "mcp.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.dirname(mcpConfigPath), { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          mcpServers: [{ name: "global", type: "http", url: "https://global.example/mcp" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: [{ name: "job", type: "stdio", command: "./bin/job-mcp" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd, {
      mcpConfigPath: path.relative(cwd, mcpConfigPath),
    });
    assert.deepEqual(config.mcpServers, [
      {
        name: "job",
        command: "./bin/job-mcp",
        args: [],
        env: [],
        _meta: undefined,
      },
    ]);
    assert.equal(config.mcpConfigPath, mcpConfigPath);
    assert.match(config.mcpConfigFingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.equal((config.mcpConfigFingerprint ?? "").includes("job-mcp"), false);
  });
});

test("loadResolvedConfig rejects a missing explicit MCP config path", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await assert.rejects(
      () =>
        loadResolvedConfig(cwd, {
          mcpConfigPath: "missing-mcp.json",
        }),
      /MCP config file not found: .*missing-mcp\.json/,
    );
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

test("initGlobalConfigFile is atomic under concurrent initialization", async () => {
  await withTempEnv(async () => {
    const results = await Promise.all([initGlobalConfigFile(), initGlobalConfigFile()]);
    assert.deepEqual(
      results
        .map((result) => result.created)
        .toSorted((left, right) => Number(left) - Number(right)),
      [false, true],
    );
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

test("loadResolvedConfig merges agent args into the command safely", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            custom: {
              command: "node",
              args: [
                "/usr/local/bin/my agent",
                "--profile",
                "with spaces",
                'quote"me',
                "C:\\Program Files\\Agent",
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.agents, {
      custom: {
        command:
          'node "/usr/local/bin/my agent" "--profile" "with spaces" "quote\\"me" "C:\\\\Program Files\\\\Agent"',
        argv: [
          "node",
          "/usr/local/bin/my agent",
          "--profile",
          "with spaces",
          'quote"me',
          "C:\\Program Files\\Agent",
        ],
      },
    });
  });
});

test("splitCommandLine preserves empty quoted arguments", () => {
  assert.deepEqual(splitCommandLine('node cli.js "" \'\' "--flag="'), {
    command: "node",
    args: ["cli.js", "", "", "--flag="],
  });
});

test("loadResolvedConfig migrates JSON-doubled legacy args to literal argv", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      '{"agents":{"custom":{"command":"C:\\\\tools\\\\bin\\\\agent.sh","args":["\\\\\\\\.\\\\pipe\\\\acpx-agent"]}}}\n',
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.agents.custom?.argv, [
      "C:\\tools\\bin\\agent.sh",
      "\\\\.\\pipe\\acpx-agent",
    ]);
  });
});

test("structured argv rejects the Windows .sh ENOENT repro with explicit guidance", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({
        agents: {
          custom: {
            argv: ["C:\\tools\\bin\\agent.sh", "--pipe", "\\\\.\\pipe\\acpx-agent"],
          },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    const custom = config.agents.custom;
    assert.ok(custom);
    assert.throws(
      () => resolveAgentCommandParts(custom.command, custom.argv, "win32"),
      /Windows cannot launch shell script executable "C:\\tools\\bin\\agent\.sh" directly.*explicit interpreter argv.*acpx does not infer interpreters/su,
    );
    assert.deepEqual(
      resolveAgentCommandParts(
        'bash "C:\\\\tools\\\\bin\\\\agent.sh"',
        ["bash", "C:\\tools\\bin\\agent.sh", "--pipe", "\\\\.\\pipe\\acpx-agent"],
        "win32",
      ),
      {
        command: "bash",
        args: ["C:\\tools\\bin\\agent.sh", "--pipe", "\\\\.\\pipe\\acpx-agent"],
      },
    );
  });
});

test("raw Windows command strings fail with argv migration guidance", () => {
  assert.throws(
    () => resolveAgentCommandParts("C:\\tools\\bin\\agent.sh --profile ci", undefined, "win32"),
    /Raw agent command strings are not supported on Windows.*argv array.*agents\.<name>\.args/su,
  );
});

test("splitCommandLine rejects empty quoted commands", () => {
  assert.throws(() => splitCommandLine('""'), {
    message: "Invalid --agent command: empty command",
  });
});

test("loadResolvedConfig rejects invalid agent args", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            custom: {
              command: "/usr/local/bin/my-agent",
              args: ["acp", 123],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await assert.rejects(
      () => loadResolvedConfig(cwd),
      /Invalid config agents\.custom\.args\[1\].*expected string/u,
    );
  });
});

test("loadResolvedConfig rejects ambiguous or quoted legacy command plus args", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    for (const command of ["node ./server.js", '"C:\\Program Files\\agent.exe"', '"node"']) {
      await fs.writeFile(
        path.join(homeDir, ".acpx", "config.json"),
        `${JSON.stringify({ agents: { custom: { command, args: ["acp"] } } })}\n`,
        "utf8",
      );

      await assert.rejects(
        () => loadResolvedConfig(cwd),
        /command must be an unquoted executable with no whitespace when args is present; migrate the complete launch to argv/u,
      );
    }
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
