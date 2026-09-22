import fs from "node:fs/promises";
import path from "node:path";
import { runTimedExecFile, splitCommandLine } from "../../acp/client-process.js";
import type {
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import { applyConfigOptionSelection, applyModelSelection } from "../config-options.js";
import { setDesiredModeId } from "../mode-preference.js";
import { resolveSessionRecord, writeSessionRecord, isoNow } from "../persistence.js";
import {
  isProcessAlive,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryCancelOnRunningOwner,
  tryCloseSessionOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModelOnRunningOwner,
  trySetModeOnRunningOwner,
} from "../queue/ipc.js";
import type { QueueOwnerRecord } from "../queue/lease-store.js";
import { acquireSessionTurn } from "../turn-ownership.js";
import type {
  SessionCancelOptions,
  SessionCancelResult,
  SessionControlOwnerOptions,
  SessionSetConfigOptionOptions,
  SessionSetModelOptions,
  SessionSetModeOptions,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "./prompt-runner.js";
import { splitWindowsProcessCommandLine } from "./windows-process-command.js";

export async function cancelSessionPrompt(
  options: SessionCancelOptions,
): Promise<SessionCancelResult> {
  const cancelled = await tryCancelOnRunningOwner(options);
  return {
    sessionId: options.sessionId,
    cancelled: cancelled === true,
  };
}

/**
 * Dispatches the mode change to a running queue owner. Returns `undefined`
 * when no owner holds the session, leaving the direct-connection decision to
 * the caller.
 *
 * An owner advertising `persistsControlState` saves the accepted state itself.
 * Only the older caller-save path still reloads and rewrites the record here,
 * which is not serialized against another process doing the same.
 */
export async function setSessionModeOnOwner(
  options: SessionControlOwnerOptions & { modeId: string },
): Promise<SessionSetModeResult | undefined> {
  const submittedToOwner = await trySetModeOnRunningOwner(
    options.sessionId,
    options.modeId,
    options.timeoutMs,
    options.verbose,
    options.assertDispatch,
  );
  if (!submittedToOwner?.value) {
    return undefined;
  }
  const record = await resolveSessionRecord(options.sessionId);
  if (!submittedToOwner.persistsControlState) {
    // v0.17.1 owners rely on the caller to persist acknowledged controls.
    setDesiredModeId(record, options.modeId);
    await writeSessionRecord(record);
  }
  return {
    record,
    resumed: false,
  };
}

export async function setSessionMode(
  options: SessionSetModeOptions,
): Promise<SessionSetModeResult> {
  const onOwner = await setSessionModeOnOwner(options);
  if (onOwner) {
    return onOwner;
  }

  return await runSessionSetModeDirect({
    sessionRecordId: options.sessionId,
    modeId: options.modeId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

/** Owner-only counterpart of {@link setSessionMode} for the model control. */
export async function setSessionModelOnOwner(
  options: SessionControlOwnerOptions & { modelId: string },
): Promise<SessionSetModelResult | undefined> {
  const submittedToOwner = await trySetModelOnRunningOwner(
    options.sessionId,
    options.modelId,
    options.timeoutMs,
    options.verbose,
    options.assertDispatch,
  );
  if (!submittedToOwner) {
    return undefined;
  }
  const record = await resolveSessionRecord(options.sessionId);
  if (!submittedToOwner.persistsControlState) {
    record.acpx = applyModelSelection(
      record.acpx,
      options.modelId,
      submittedToOwner.value.response,
    );
    await writeSessionRecord(record);
  }
  return {
    record,
    response: submittedToOwner.value.response,
    resumed: false,
  };
}

export async function setSessionModel(
  options: SessionSetModelOptions,
): Promise<SessionSetModelResult> {
  const onOwner = await setSessionModelOnOwner(options);
  if (onOwner) {
    return onOwner;
  }

  return await runSessionSetModelDirect({
    sessionRecordId: options.sessionId,
    modelId: options.modelId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

/** Owner-only counterpart of {@link setSessionMode} for the config option control. */
export async function setSessionConfigOptionOnOwner(
  options: SessionControlOwnerOptions & { configId: string; value: string },
): Promise<SessionSetConfigOptionResult | undefined> {
  const ownerResponse = await trySetConfigOptionOnRunningOwner(
    options.sessionId,
    options.configId,
    options.value,
    options.timeoutMs,
    options.verbose,
    options.assertDispatch,
  );
  if (!ownerResponse) {
    return undefined;
  }
  const record = await resolveSessionRecord(options.sessionId);
  if (!ownerResponse.persistsControlState) {
    record.acpx = applyConfigOptionSelection(
      record.acpx,
      options.configId,
      options.value,
      ownerResponse.value,
    );
    await writeSessionRecord(record);
  }
  return {
    record,
    response: ownerResponse.value,
    resumed: false,
  };
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  const onOwner = await setSessionConfigOptionOnOwner(options);
  if (onOwner) {
    return onOwner;
  }

  return await runSessionSetConfigOptionDirect({
    sessionRecordId: options.sessionId,
    configId: options.configId,
    value: options.value,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

function firstAgentCommandToken(command: string, argv?: readonly string[]): string | undefined {
  if (argv) {
    return argv[0] || undefined;
  }
  try {
    const parsed = splitCommandLine(command);
    return parsed.command || undefined;
  } catch {
    return undefined;
  }
}

async function isLikelyMatchingProcess(pid: number, record: SessionRecord): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(record.agentCommand, record.agentArgv);
  if (!expectedToken) {
    return false;
  }

  const argv = await readProcessArgv(pid);
  if (argv.length === 0) {
    return false;
  }

  const executableBase = path.basename(argv[0]);
  const expectedBase = path.basename(expectedToken);
  return (
    executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase)
  );
}

async function readProcessArgv(pid: number): Promise<string[]> {
  const procArgv = await readProcCmdline(pid);
  if (procArgv) {
    return procArgv;
  }

  const commandLine =
    process.platform === "win32"
      ? await readWindowsCommandLine(pid)
      : await readPosixCommandLine(pid);
  return splitCommandLineLike(commandLine);
}

async function readProcCmdline(pid: number): Promise<string[] | undefined> {
  try {
    const payload = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return undefined;
  }
}

async function readPosixCommandLine(pid: number): Promise<string | undefined> {
  try {
    const stdout = await runTimedExecFile("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readWindowsCommandLine(pid: number): Promise<string | undefined> {
  try {
    const stdout = await runTimedExecFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { windowsHide: true },
    );
    // PowerShell adds a record newline. Other trailing whitespace can belong to argv.
    return stdout.replace(/\r?\n$/u, "") || undefined;
  } catch {
    return undefined;
  }
}

function splitCommandLineLike(
  commandLine: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!commandLine) {
    return [];
  }
  if (platform === "win32") {
    return splitWindowsProcessCommandLine(commandLine);
  }
  try {
    const parsed = splitCommandLine(commandLine);
    return [parsed.command, ...parsed.args];
  } catch {
    return commandLine
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}

export const sessionControlTestInternals = { firstAgentCommandToken, splitCommandLineLike };

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  let selectedOwner: QueueOwnerRecord | undefined;
  await tryCloseSessionOnRunningOwner({
    sessionId: record.acpxRecordId,
    onOwnerSelected: (owner) => {
      selectedOwner = owner;
    },
  }).catch(() => {
    // Preserve local close semantics even if best-effort ACP session shutdown fails.
  });
  if (selectedOwner) {
    await terminateQueueOwnerForSession(record.acpxRecordId, selectedOwner);
  }

  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record))
  ) {
    await terminateProcess(record.pid);
  }

  // The owner must finish its turn before close takes checkpoint ownership.
  const ownership = await acquireSessionTurn(record.acpxRecordId);
  try {
    const current = await resolveSessionRecord(record.acpxRecordId);
    current.pid = undefined;
    current.closed = true;
    current.closedAt = isoNow();
    await writeSessionRecord(current);
    return current;
  } finally {
    await ownership[Symbol.asyncDispose]();
  }
}
