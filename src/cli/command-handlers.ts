import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { isCodexInvocation } from "../acp/codex-compat.js";
import {
  mergePromptSourceWithText,
  parsePromptSource,
  PromptInputValidationError,
  textPrompt,
} from "../prompt-content.js";
import {
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
} from "../session/persistence.js";
import { EXIT_CODES } from "../types.js";
import type {
  OutputFormat,
  OutputPolicy,
  SessionAgentContent,
  SessionRecord,
  SessionUserContent,
} from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  parseHistoryLimit,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  resolveSessionNameFromFlags,
  type ExecFlags,
  type PromptFlags,
  type SessionsHistoryFlags,
  type SessionsNewFlags,
  type StatusFlags,
} from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";

class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
  }
}

type SessionModule = typeof import("../session/session.js");
type OutputModule = typeof import("./output/output.js");
type OutputRenderModule = typeof import("./output/render.js");

let sessionModulePromise: Promise<SessionModule> | undefined;
let outputModulePromise: Promise<OutputModule> | undefined;
let outputRenderModulePromise: Promise<OutputRenderModule> | undefined;

function loadSessionModule(): Promise<SessionModule> {
  sessionModulePromise ??= import("../session/session.js");
  return sessionModulePromise;
}

function loadOutputModule(): Promise<OutputModule> {
  outputModulePromise ??= import("./output/output.js");
  return outputModulePromise;
}

function loadOutputRenderModule(): Promise<OutputRenderModule> {
  outputRenderModulePromise ??= import("./output/render.js");
  return outputRenderModulePromise;
}

async function readPromptInputFromStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function readPrompt(
  promptParts: string[],
  filePath: string | undefined,
  cwd: string,
): Promise<import("../types.js").PromptInput> {
  try {
    if (filePath) {
      const source =
        filePath === "-"
          ? await readPromptInputFromStdin()
          : await fs.readFile(path.resolve(cwd, filePath), "utf8");
      const prompt = mergePromptSourceWithText(source, promptParts.join(" "));
      if (prompt.length === 0) {
        throw new InvalidArgumentError("Prompt from --file is empty");
      }
      return prompt;
    }

    const joined = promptParts.join(" ").trim();
    if (joined.length > 0) {
      return textPrompt(joined);
    }

    if (process.stdin.isTTY) {
      throw new InvalidArgumentError(
        "Prompt is required (pass as argument, --file, or pipe via stdin)",
      );
    }

    const prompt = parsePromptSource(await readPromptInputFromStdin());
    if (prompt.length === 0) {
      throw new InvalidArgumentError("Prompt from stdin is empty");
    }

    return prompt;
  } catch (error) {
    if (error instanceof PromptInputValidationError) {
      throw new InvalidArgumentError(error.message);
    }
    throw error;
  }
}

function applyPermissionExitCode(result: {
  permissionStats: {
    requested: number;
    approved: number;
    denied: number;
    cancelled: number;
  };
}): void {
  const stats = result.permissionStats;
  const deniedOrCancelled = stats.denied + stats.cancelled;

  if (stats.requested > 0 && stats.approved === 0 && deniedOrCancelled > 0) {
    process.exitCode = EXIT_CODES.PERMISSION_DENIED;
  }
}

function resolveCompatibleConfigId(
  agent: { agentName: string; agentCommand: string },
  configId: string,
): string {
  if (isCodexInvocation(agent.agentName, agent.agentCommand) && configId === "thought_level") {
    return "reasoning_effort";
  }
  return configId;
}

function resolveRequestedOutputPolicy(globalFlags: {
  format: OutputFormat;
  jsonStrict?: boolean;
  suppressReads?: boolean;
}): OutputPolicy {
  return {
    ...resolveOutputPolicy(globalFlags.format, globalFlags.jsonStrict === true),
    suppressReads: globalFlags.suppressReads === true,
  };
}

async function findRoutedSessionOrThrow(
  agentCommand: string,
  agentName: string,
  cwd: string,
  sessionName: string | undefined,
): Promise<SessionRecord> {
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = gitRoot ?? cwd;

  const record = await findSessionByDirectoryWalk({
    agentCommand,
    cwd,
    name: sessionName,
    boundary: walkBoundary,
  });

  if (record) {
    return record;
  }

  const createCmd = sessionName
    ? `acpx ${agentName} sessions new --name ${sessionName}`
    : `acpx ${agentName} sessions new`;
  throw new NoSessionError(
    `⚠ No acpx session found (searched up to ${walkBoundary}).\nCreate one: ${createCmd}`,
  );
}

export async function handlePrompt(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: PromptFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [
    { createOutputFormatter },
    { printPromptSessionBanner, printQueuedPromptByFormat },
    { sendSession },
  ] = await Promise.all([loadOutputModule(), loadOutputRenderModule(), loadSessionModule()]);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    flags.session,
  );
  const outputFormatter = createOutputFormatter(outputPolicy.format, {
    jsonContext: {
      sessionId: record.acpxRecordId,
    },
    suppressReads: outputPolicy.suppressReads,
  });

  await printPromptSessionBanner(record, agent.cwd, outputPolicy.format, outputPolicy.jsonStrict);
  const result = await sendSession({
    sessionId: record.acpxRecordId,
    prompt,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    outputFormatter,
    errorEmissionPolicy: {
      queueErrorAlreadyEmitted: outputPolicy.queueErrorAlreadyEmitted,
    },
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: globalFlags.timeout,
    ttlMs: globalFlags.ttl,
    maxQueueDepth: config.queueMaxDepth,
    promptRetries: globalFlags.promptRetries,
    verbose: globalFlags.verbose,
    waitForCompletion: flags.wait !== false,
  });

  if ("queued" in result) {
    printQueuedPromptByFormat(result, outputPolicy.format);
    return;
  }

  applyPermissionExitCode(result);

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(`[acpx] loadSession failed, started fresh session: ${result.loadError}\n`);
  }
}

export async function handleExec(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: ExecFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  if (config.disableExec) {
    const globalFlags = resolveGlobalFlags(command, config);
    const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
    if (outputPolicy.format === "json") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "exec subcommand is disabled by configuration (disableExec: true)",
            data: { acpxCode: "EXEC_DISABLED" },
          },
        })}\n`,
      );
    } else {
      process.stderr.write(
        "Error: exec subcommand is disabled by configuration (disableExec: true)\n",
      );
    }
    process.exitCode = 1;
    return;
  }

  const globalFlags = resolveGlobalFlags(command, config);
  const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);
  const [{ createOutputFormatter }, { runOnce }] = await Promise.all([
    loadOutputModule(),
    loadSessionModule(),
  ]);
  const outputFormatter = createOutputFormatter(outputPolicy.format, {
    suppressReads: outputPolicy.suppressReads,
  });
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);

  const result = await runOnce({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    prompt,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    outputFormatter,
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    promptRetries: globalFlags.promptRetries,
    sessionOptions: {
      model: globalFlags.model,
      allowedTools: globalFlags.allowedTools,
      maxTurns: globalFlags.maxTurns,
    },
  });

  applyPermissionExitCode(result);
}

function printCancelResultByFormat(
  result: { sessionId: string; cancelled: boolean },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "cancel_result",
      acpxRecordId: result.sessionId || "unknown",
      cancelled: result.cancelled,
    })
  ) {
    return;
  }

  process.stdout.write(result.cancelled ? "cancel requested\n" : "nothing to cancel\n");
}

function printSetModeResultByFormat(
  modeId: string,
  result: { record: SessionRecord; resumed: boolean; loadError?: string },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "mode_set",
      modeId,
      resumed: result.resumed,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${modeId}\n` : `mode set: ${modeId}\n`);
}

function printSetModelResultByFormat(
  modelId: string,
  result: { record: SessionRecord; resumed: boolean },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "model_set",
      modelId,
      resumed: result.resumed,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${modelId}\n` : `model set: ${modelId}\n`);
}

function printSetConfigOptionResultByFormat(
  configId: string,
  value: string,
  result: {
    record: SessionRecord;
    resumed: boolean;
    response: { configOptions: unknown[] };
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "config_set",
      configId,
      value,
      resumed: result.resumed,
      configOptions: result.response.configOptions,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(
    format === "quiet"
      ? `${value}\n`
      : `config set: ${configId}=${value} (${result.response.configOptions.length} options)\n`,
  );
}

export async function handleCancel(
  explicitAgentName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const { cancelSessionPrompt } = await loadSessionModule();
  const gitRoot = findGitRepositoryRoot(agent.cwd);
  const walkBoundary = gitRoot ?? agent.cwd;
  const record = await findSessionByDirectoryWalk({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: resolveSessionNameFromFlags(flags, command),
    boundary: walkBoundary,
  });

  if (!record) {
    printCancelResultByFormat({ sessionId: "", cancelled: false }, globalFlags.format);
    return;
  }

  const result = await cancelSessionPrompt({
    sessionId: record.acpxRecordId,
    verbose: globalFlags.verbose,
  });
  printCancelResultByFormat(result, globalFlags.format);
}

export async function handleSetMode(
  explicitAgentName: string | undefined,
  modeId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const { setSessionMode } = await loadSessionModule();
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const result = await setSessionMode({
    sessionId: record.acpxRecordId,
    modeId,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(`[acpx] loadSession failed, started fresh session: ${result.loadError}\n`);
  }

  printSetModeResultByFormat(modeId, result, globalFlags.format);
}

export async function handleSetModel(
  explicitAgentName: string | undefined,
  modelId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const { setSessionModel } = await loadSessionModule();
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const result = await setSessionModel({
    sessionId: record.acpxRecordId,
    modelId,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(`[acpx] loadSession failed, started fresh session: ${result.loadError}\n`);
  }

  printSetModelResultByFormat(modelId, result, globalFlags.format);
}

export async function handleSetConfigOption(
  explicitAgentName: string | undefined,
  configId: string,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  if (configId === "model") {
    await handleSetModel(explicitAgentName, value, flags, command, config);
    return;
  }
  const resolvedConfigId = resolveCompatibleConfigId(agent, configId);
  const { setSessionConfigOption } = await loadSessionModule();
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const result = await setSessionConfigOption({
    sessionId: record.acpxRecordId,
    configId: resolvedConfigId,
    value,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(`[acpx] loadSession failed, started fresh session: ${result.loadError}\n`);
  }

  printSetConfigOptionResultByFormat(configId, value, result, globalFlags.format);
}

export async function handleSessionsList(
  explicitAgentName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ listSessionsForAgent }, { printSessionsByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);
  const sessions = await listSessionsForAgent(agent.agentCommand);
  printSessionsByFormat(sessions, globalFlags.format);
}

export async function handleSessionsClose(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ closeSession }, { printClosedSessionByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);

  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
  });

  if (!record) {
    throw new Error(
      sessionName
        ? `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`
        : `No cwd session for ${agent.cwd} and agent ${agent.agentName}`,
    );
  }

  const closed = await closeSession(record.acpxRecordId);
  printClosedSessionByFormat(closed, globalFlags.format);
}

export async function handleSessionsNew(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ createSession, closeSession }, { printCreatedSessionBanner, printNewSessionByFormat }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);

  const replaced = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
  });

  if (replaced) {
    await closeSession(replaced.acpxRecordId);
    if (globalFlags.verbose) {
      process.stderr.write(`[acpx] soft-closed prior session: ${replaced.acpxRecordId}\n`);
    }
  }

  const created = await createSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
    resumeSessionId: flags.resumeSession,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    sessionOptions: {
      model: globalFlags.model,
      allowedTools: globalFlags.allowedTools,
      maxTurns: globalFlags.maxTurns,
    },
  });

  printCreatedSessionBanner(created, agent.agentName, globalFlags.format, globalFlags.jsonStrict);

  if (globalFlags.verbose) {
    const scope = flags.name ? `named session "${flags.name}"` : "cwd session";
    process.stderr.write(`[acpx] created ${scope}: ${created.acpxRecordId}\n`);
  }

  printNewSessionByFormat(created, replaced, globalFlags.format);
}

export async function handleSessionsEnsure(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ ensureSession }, { printCreatedSessionBanner, printEnsuredSessionByFormat }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);
  const result = await ensureSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
    resumeSessionId: flags.resumeSession,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    sessionOptions: {
      model: globalFlags.model,
      allowedTools: globalFlags.allowedTools,
      maxTurns: globalFlags.maxTurns,
    },
  });

  if (result.created) {
    printCreatedSessionBanner(
      result.record,
      agent.agentName,
      globalFlags.format,
      globalFlags.jsonStrict,
    );
  }

  printEnsuredSessionByFormat(result.record, result.created, globalFlags.format);
}

function userContentToText(content: SessionUserContent): string {
  if ("Text" in content) {
    return content.Text;
  }
  if ("Mention" in content) {
    return content.Mention.content;
  }
  if ("Image" in content) {
    return content.Image.source || "[image]";
  }
  return "";
}

function agentContentToText(content: SessionAgentContent): string {
  if ("Text" in content) {
    return content.Text;
  }
  if ("Thinking" in content) {
    return content.Thinking.text;
  }
  if ("RedactedThinking" in content) {
    return "[redacted_thinking]";
  }
  if ("ToolUse" in content) {
    return `[tool:${content.ToolUse.name}]`;
  }
  return "";
}

function conversationHistoryEntries(record: SessionRecord): Array<{
  role: "user" | "assistant";
  timestamp: string;
  textPreview: string;
}> {
  const entries: Array<{ role: "user" | "assistant"; timestamp: string; textPreview: string }> = [];

  for (const message of record.messages) {
    if (message === "Resume") {
      continue;
    }

    if ("User" in message) {
      const text = message.User.content
        .map((entry) => userContentToText(entry))
        .join(" ")
        .trim();
      if (!text) {
        continue;
      }
      entries.push({ role: "user", timestamp: record.updated_at, textPreview: text });
      continue;
    }

    if ("Agent" in message) {
      const text = message.Agent.content
        .map((entry) => agentContentToText(entry))
        .join(" ")
        .trim();
      if (!text) {
        continue;
      }
      entries.push({ role: "assistant", timestamp: record.updated_at, textPreview: text });
    }
  }

  return entries;
}

function printSessionDetailsByFormat(record: SessionRecord, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }
  process.stdout.write(`id: ${record.acpxRecordId}\n`);
  process.stdout.write(`sessionId: ${record.acpSessionId}\n`);
  process.stdout.write(`agentSessionId: ${record.agentSessionId ?? "-"}\n`);
  process.stdout.write(`agent: ${record.agentCommand}\n`);
  process.stdout.write(`cwd: ${record.cwd}\n`);
  process.stdout.write(`name: ${record.name ?? "-"}\n`);
  process.stdout.write(`created: ${record.createdAt}\n`);
  process.stdout.write(`lastActivity: ${record.lastUsedAt}\n`);
  process.stdout.write(`lastPrompt: ${record.lastPromptAt ?? "-"}\n`);
  process.stdout.write(`closed: ${record.closed ? "yes" : "no"}\n`);
  process.stdout.write(`closedAt: ${record.closedAt ?? "-"}\n`);
  process.stdout.write(`pid: ${record.pid ?? "-"}\n`);
  process.stdout.write(`agentStartedAt: ${record.agentStartedAt ?? "-"}\n`);
  process.stdout.write(`lastExitCode: ${record.lastAgentExitCode ?? "-"}\n`);
  process.stdout.write(`lastExitSignal: ${record.lastAgentExitSignal ?? "-"}\n`);
  process.stdout.write(`lastExitAt: ${record.lastAgentExitAt ?? "-"}\n`);
  process.stdout.write(`disconnectReason: ${record.lastAgentDisconnectReason ?? "-"}\n`);
  process.stdout.write(`historyEntries: ${conversationHistoryEntries(record).length}\n`);
}

function printSessionHistoryByFormat(
  record: SessionRecord,
  limit: number,
  format: OutputFormat,
): void {
  const history = conversationHistoryEntries(record);
  const visible = limit === 0 ? history : history.slice(Math.max(0, history.length - limit));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        id: record.acpxRecordId,
        sessionId: record.acpSessionId,
        limit,
        count: visible.length,
        entries: visible,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    for (const entry of visible) {
      process.stdout.write(`${entry.textPreview}\n`);
    }
    return;
  }

  process.stdout.write(
    `session: ${record.acpxRecordId} (${visible.length}/${history.length} shown)\n`,
  );
  if (visible.length === 0) {
    process.stdout.write("No history\n");
    return;
  }

  for (const entry of visible) {
    process.stdout.write(`${entry.timestamp}\t${entry.role}\t${entry.textPreview}\n`);
  }
}

export async function handleSessionsShow(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (!record) {
    throw new Error(
      sessionName
        ? `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`
        : `No cwd session for ${agent.cwd} and agent ${agent.agentName}`,
    );
  }

  printSessionDetailsByFormat(record, globalFlags.format);
}

export async function handleSessionsHistory(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  flags: SessionsHistoryFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (!record) {
    throw new Error(
      sessionName
        ? `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`
        : `No cwd session for ${agent.cwd} and agent ${agent.agentName}`,
    );
  }

  printSessionHistoryByFormat(record, flags.limit, globalFlags.format);
}

export { parseHistoryLimit, NoSessionError, loadSessionModule };
