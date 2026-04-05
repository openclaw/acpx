import { Command } from "commander";
import { DEFAULT_HISTORY_LIMIT } from "../session/persistence.js";
import {
  handleCancel,
  handleExec,
  handlePrompt,
  handleSessionsClose,
  handleSessionsEnsure,
  handleSessionsHistory,
  handleSessionsList,
  handleSessionsNew,
  handleSessionsShow,
  handleSetConfigOption,
  handleSetMode,
  parseHistoryLimit,
} from "./command-handlers.js";
import { registerConfigCommand } from "./config-command.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  addPromptInputOption,
  addSessionNameOption,
  addSessionOption,
  parseNonEmptyValue,
  parseSessionName,
  type PromptFlags,
  type SessionsHistoryFlags,
  type SessionsNewFlags,
  type StatusFlags,
} from "./flags.js";
import { registerStatusCommand } from "./status-command.js";

type FlowRunFlags = {
  inputJson?: string;
  inputFile?: string;
  defaultAgent?: string;
};

type SharedSubcommandDescriptions = {
  prompt: string;
  exec: string;
  cancel: string;
  setMode: string;
  setConfig: string;
  status: string;
};

export function registerSessionsCommand(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
): void {
  const sessionsCommand = parent
    .command("sessions")
    .description("List, ensure, create, or close sessions for this agent");

  sessionsCommand.action(async function (this: Command) {
    await handleSessionsList(explicitAgentName, this, config);
  });

  sessionsCommand
    .command("list")
    .description("List sessions")
    .action(async function (this: Command) {
      await handleSessionsList(explicitAgentName, this, config);
    });

  sessionsCommand
    .command("new")
    .description("Create a fresh session for current cwd")
    .option("--name <name>", "Session name", parseSessionName)
    .option("--resume-session <id>", "Resume existing ACP session id", (value: string) =>
      parseNonEmptyValue("Resume session id", value),
    )
    .action(async function (this: Command, flags: SessionsNewFlags) {
      await handleSessionsNew(explicitAgentName, flags, this, config);
    });

  sessionsCommand
    .command("ensure")
    .description("Ensure a session exists for current cwd or ancestor")
    .option("--name <name>", "Session name", parseSessionName)
    .option("--resume-session <id>", "Resume existing ACP session id", (value: string) =>
      parseNonEmptyValue("Resume session id", value),
    )
    .action(async function (this: Command, flags: SessionsNewFlags) {
      await handleSessionsEnsure(explicitAgentName, flags, this, config);
    });

  sessionsCommand
    .command("close")
    .description("Close session for current cwd")
    .argument("[name]", "Session name", parseSessionName)
    .action(async function (this: Command, name?: string) {
      await handleSessionsClose(explicitAgentName, name, this, config);
    });

  sessionsCommand
    .command("show")
    .description("Show session metadata for current cwd")
    .argument("[name]", "Session name", parseSessionName)
    .action(async function (this: Command, name?: string) {
      await handleSessionsShow(explicitAgentName, name, this, config);
    });

  sessionsCommand
    .command("history")
    .description("Show recent session history entries")
    .argument("[name]", "Session name", parseSessionName)
    .option(
      "--limit <count>",
      `Maximum number of entries to show (default: ${DEFAULT_HISTORY_LIMIT})`,
      parseHistoryLimit,
      DEFAULT_HISTORY_LIMIT,
    )
    .action(async function (this: Command, name: string | undefined, flags: SessionsHistoryFlags) {
      await handleSessionsHistory(explicitAgentName, name, flags, this, config);
    });

  sessionsCommand
    .command("read")
    .description("Read full session history")
    .argument("[name]", "Session name", parseSessionName)
    .option(
      "--tail <count>",
      "Show only the last N entries instead of all history",
      parseHistoryLimit,
    )
    .action(async function (this: Command, name: string | undefined, flags: { tail?: number }) {
      await handleSessionsHistory(
        explicitAgentName,
        name,
        { limit: flags.tail ?? 0 },
        this,
        config,
      );
    });
}

export function registerSharedAgentSubcommands(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
  descriptions: SharedSubcommandDescriptions,
): void {
  const promptCommand = parent
    .command("prompt")
    .description(descriptions.prompt)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addSessionOption(promptCommand);
  addPromptInputOption(promptCommand);
  promptCommand.action(async function (this: Command, promptParts: string[], flags: PromptFlags) {
    await handlePrompt(explicitAgentName, promptParts, flags, this, config);
  });

  const execCommand = parent
    .command("exec")
    .description(descriptions.exec)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addPromptInputOption(execCommand);
  execCommand.action(async function (this: Command, promptParts: string[], flags) {
    await handleExec(explicitAgentName, promptParts, flags, this, config);
  });

  const cancelCommand = parent.command("cancel").description(descriptions.cancel);
  addSessionNameOption(cancelCommand);
  cancelCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleCancel(explicitAgentName, flags, this, config);
  });

  const setModeCommand = parent
    .command("set-mode")
    .description(descriptions.setMode)
    .argument("<mode>", "Mode id", (value: string) => parseNonEmptyValue("Mode", value));
  addSessionNameOption(setModeCommand);
  setModeCommand.action(async function (this: Command, modeId: string, flags: StatusFlags) {
    await handleSetMode(explicitAgentName, modeId, flags, this, config);
  });

  const setConfigCommand = parent
    .command("set")
    .description(descriptions.setConfig)
    .argument("<key>", "Config option id", (value: string) =>
      parseNonEmptyValue("Config option key", value),
    )
    .argument("<value>", "Config option value", (value: string) =>
      parseNonEmptyValue("Config option value", value),
    );
  addSessionNameOption(setConfigCommand);
  setConfigCommand.action(async function (
    this: Command,
    key: string,
    value: string,
    flags: StatusFlags,
  ) {
    await handleSetConfigOption(explicitAgentName, key, value, flags, this, config);
  });

  registerStatusCommand(parent, explicitAgentName, config, descriptions.status);
}

export function registerAgentCommand(
  program: Command,
  agentName: string,
  config: ResolvedAcpxConfig,
): void {
  const agentCommand = program
    .command(agentName)
    .description(`Use ${agentName} agent`)
    .argument("[prompt...]", "Prompt text")
    .enablePositionalOptions()
    .passThroughOptions()
    .showHelpAfterError();

  addSessionOption(agentCommand);
  addPromptInputOption(agentCommand);
  agentCommand.action(async function (this: Command, promptParts: string[], flags: PromptFlags) {
    await handlePrompt(agentName, promptParts, flags, this, config);
  });

  registerSharedAgentSubcommands(agentCommand, agentName, config, {
    prompt: "Prompt using persistent session",
    exec: "One-shot prompt without saved session",
    cancel: "Cooperatively cancel current in-flight prompt",
    setMode: "Set session mode",
    setConfig: "Set session config option",
    status: "Show local status of current session agent process",
  });

  registerSessionsCommand(agentCommand, agentName, config);
}

export function registerFlowCommand(program: Command, config: ResolvedAcpxConfig): void {
  const flowCommand = program
    .command("flow")
    .description("Run multi-step ACP workflows from flow files");

  flowCommand
    .command("run")
    .description("Run a flow file")
    .argument("<file>", "Flow module path")
    .option("--input-json <json>", "Flow input as JSON")
    .option("--input-file <path>", "Read flow input JSON from file")
    .option(
      "--default-agent <name>",
      "Default agent profile for ACP nodes without profile",
      (value: string) => parseNonEmptyValue("Default agent", value),
    )
    .action(async function (this: Command, file: string, flags: FlowRunFlags) {
      const { handleFlowRun } = await import("../flows/cli.js");
      await handleFlowRun(file, flags, this, config);
    });
}

export function registerDefaultCommands(program: Command, config: ResolvedAcpxConfig): void {
  registerSharedAgentSubcommands(program, undefined, config, {
    prompt: `Prompt using ${config.defaultAgent} by default`,
    exec: `One-shot prompt using ${config.defaultAgent} by default`,
    cancel: `Cancel active prompt for ${config.defaultAgent} by default`,
    setMode: `Set session mode for ${config.defaultAgent} by default`,
    setConfig: `Set session config option for ${config.defaultAgent} by default`,
    status: `Show local status for ${config.defaultAgent} by default`,
  });

  registerSessionsCommand(program, undefined, config);
  registerConfigCommand(program, config);
  registerFlowCommand(program, config);
}
