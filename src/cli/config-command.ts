import { Command } from "commander";
import { initGlobalConfigFile, toConfigDisplay, type ResolvedAcpxConfig } from "./config.js";
import { resolveGlobalFlags } from "./flags.js";

async function handleConfigShow(command: Command, config: ResolvedAcpxConfig): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const payload = {
    ...toConfigDisplay(config),
    paths: {
      global: config.globalPath,
      project: config.projectPath,
    },
    loaded: {
      global: config.hasGlobalConfig,
      project: config.hasProjectConfig,
    },
  };

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function handleConfigInit(command: Command, config: ResolvedAcpxConfig): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const result = await initGlobalConfigFile();
  if (globalFlags.format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        path: result.path,
        created: result.created,
      })}\n`,
    );
    return;
  }
  if (globalFlags.format === "quiet") {
    process.stdout.write(`${result.path}\n`);
    return;
  }

  if (result.created) {
    process.stdout.write(`Created ${result.path}\n`);
    return;
  }
  process.stdout.write(`Config already exists: ${result.path}\n`);
}

export function registerConfigCommand(program: Command, config: ResolvedAcpxConfig): void {
  const configCommand = program
    .command("config")
    .description("Inspect and initialize acpx configuration");

  configCommand
    .command("show")
    .description("Show resolved config")
    .action(async function (this: Command) {
      await handleConfigShow(this, config);
    });

  configCommand
    .command("init")
    .description("Create global config template")
    .action(async function (this: Command) {
      await handleConfigInit(this, config);
    });

  configCommand.action(async function (this: Command) {
    await handleConfigShow(this, config);
  });
}
