import fs from "node:fs/promises";
import path from "node:path";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import { currentModelIdFromSetModelResponse } from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import { resolveSessionRecord, writeSessionRecord, isoNow } from "../../session/persistence.js";
import type {
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
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
import type {
  SessionCancelOptions,
  SessionCancelResult,
  SessionSetConfigOptionOptions,
  SessionSetModelOptions,
  SessionSetModeOptions,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "./prompt-runner.js";

export async function cancelSessionPrompt(
  options: SessionCancelOptions,
): Promise<SessionCancelResult> {
  const cancelled = await tryCancelOnRunningOwner(options);
  return {
    sessionId: options.sessionId,
    cancelled: cancelled === true,
  };
}

export async function setSessionMode(
  options: SessionSetModeOptions,
): Promise<SessionSetModeResult> {
  const submittedToOwner = await trySetModeOnRunningOwner(
    options.sessionId,
    options.modeId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    const record = await resolveSessionRecord(options.sessionId);
    setDesiredModeId(record, options.modeId);
    await writeSessionRecord(record);
    return {
      record,
      resumed: false,
    };
  }

  return await runSessionSetModeDirect({
    sessionRecordId: options.sessionId,
    modeId: options.modeId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionModel(
  options: SessionSetModelOptions,
): Promise<SessionSetModelResult> {
  const submittedToOwner = await trySetModelOnRunningOwner(
    options.sessionId,
    options.modelId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    const record = await resolveSessionRecord(options.sessionId);
    applyConfigOptionsToRecord(record, submittedToOwner.response);
    setDesiredModelId(record, options.modelId, advertisedModelState(record.acpx)?.configId);
    setCurrentModelId(
      record,
      currentModelIdFromSetModelResponse(submittedToOwner.response, options.modelId),
    );
    await writeSessionRecord(record);
    return {
      record,
      response: submittedToOwner.response,
      resumed: false,
    };
  }

  return await runSessionSetModelDirect({
    sessionRecordId: options.sessionId,
    modelId: options.modelId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  const ownerResponse = await trySetConfigOptionOnRunningOwner(
    options.sessionId,
    options.configId,
    options.value,
    options.timeoutMs,
    options.verbose,
  );
  if (ownerResponse) {
    const record = await resolveSessionRecord(options.sessionId);
    const modelConfigId = advertisedModelState(record.acpx)?.configId;
    applyConfigOptionsToRecord(record, ownerResponse);
    if (options.configId === modelConfigId) {
      setDesiredModelId(record, options.value, options.configId);
      setCurrentModelId(record, currentModelIdFromSetModelResponse(ownerResponse, options.value));
    } else if (options.configId === "mode") {
      setDesiredModeId(record, options.value);
    } else {
      setDesiredConfigOption(record, options.configId, options.value);
    }
    await writeSessionRecord(record);
    return {
      record,
      response: ownerResponse,
      resumed: false,
    };
  }

  return await runSessionSetConfigOptionDirect({
    sessionRecordId: options.sessionId,
    configId: options.configId,
    value: options.value,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

function firstAgentCommandToken(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const token = trimmed.split(/\s+/, 1)[0];
  return token.length > 0 ? token : undefined;
}

async function isLikelyMatchingProcess(pid: number, agentCommand: string): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(agentCommand);
  if (!expectedToken) {
    return false;
  }

  const procCmdline = `/proc/${pid}/cmdline`;
  try {
    const payload = await fs.readFile(procCmdline, "utf8");
    const argv = payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (argv.length === 0) {
      return false;
    }

    const executableBase = path.basename(argv[0]);
    const expectedBase = path.basename(expectedToken);
    return (
      executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase)
    );
  } catch {
    return true;
  }
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  await tryCloseSessionOnRunningOwner({ sessionId: record.acpxRecordId }).catch(() => {
    // Preserve local close semantics even if best-effort ACP session shutdown fails.
  });
  await terminateQueueOwnerForSession(record.acpxRecordId);

  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record.agentCommand))
  ) {
    await terminateProcess(record.pid);
  }

  record.pid = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  await writeSessionRecord(record);

  return record;
}
