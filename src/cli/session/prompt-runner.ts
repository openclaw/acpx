import type { AcpClient } from "../../acp/client.js";
import { withTimeout } from "../../async-control.js";
import {
  withConnectedSession,
  type FullConnectedSessionController,
  type WithConnectedSessionOptions,
  type WithConnectedSessionResult,
} from "../../runtime/engine/connected-session.js";
import { sessionOptionsFromRecord } from "../../runtime/engine/session-options.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import {
  applyRequestedModelIfAdvertised,
  currentModelIdFromSetModelResponse,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import { resolveSessionRecord, writeSessionRecord } from "../../session/persistence.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import type { QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";

export type ActiveSessionController = QueueOwnerActiveSessionController;

export type RunSessionSetModeDirectOptions = {
  sessionRecordId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetConfigOptionDirectOptions = {
  sessionRecordId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetModelDirectOptions = {
  sessionRecordId: string;
  modelId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

type DirectConnectedSessionOptions = {
  sessionRecordId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

function buildDirectConnectedSessionOptions<T>(
  options: DirectConnectedSessionOptions,
  run: WithConnectedSessionOptions<T>["run"],
): WithConnectedSessionOptions<T> {
  return {
    sessionRecordId: options.sessionRecordId,
    loadRecord: resolveSessionRecord,
    saveRecord: writeSessionRecord,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: (controller: FullConnectedSessionController) => {
      options.onClientAvailable?.(controller);
    },
    onClientClosed: options.onClientClosed,
    run,
  };
}

function toSessionMutationResult(
  result: Pick<WithConnectedSessionResult<unknown>, "record" | "resumed" | "loadError">,
): Pick<SessionSetModeResult, "record" | "resumed" | "loadError"> {
  return {
    record: result.record,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

/**
 * Re-apply the session-pinned model after reconnect, matching the prompt path.
 *
 * Some agents (e.g. opencode) restore to their default model on session load and
 * advertise model-dependent config options for that default. Without replaying
 * `session_options.model` first, `set` fails because the option set belongs to
 * the wrong model, and the record is overwritten with default-model options.
 */
async function reapplyPinnedModelAfterConnect(params: {
  client: AcpClient;
  sessionId: string;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<void> {
  const pinnedModel = sessionOptionsFromRecord(params.record)?.model;
  if (!pinnedModel) {
    return;
  }

  const models = advertisedModelState(params.record.acpx);
  if (models?.currentModelId === pinnedModel) {
    // Keep the pin sticky when the agent already reports it after load.
    setDesiredModelId(params.record, pinnedModel, models.configId);
    setCurrentModelId(params.record, pinnedModel);
    return;
  }

  const result = await applyRequestedModelIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedModel: pinnedModel,
    models,
    agentCommand: params.record.agentCommand,
    timeoutMs: params.timeoutMs,
  });
  if (result.response) {
    applyConfigOptionsToRecord(params.record, result.response);
  }
  if (result.applied) {
    setDesiredModelId(params.record, pinnedModel, models?.configId);
    setCurrentModelId(
      params.record,
      currentModelIdFromSetModelResponse(result.response, pinnedModel),
    );
  }
}

export async function runSessionSetModeDirect(
  options: RunSessionSetModeDirectOptions,
): Promise<SessionSetModeResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      await reapplyPinnedModelAfterConnect({
        client,
        sessionId,
        record,
        timeoutMs: options.timeoutMs,
      });
      await withTimeout(client.setSessionMode(sessionId, options.modeId), options.timeoutMs);
      setDesiredModeId(record, options.modeId);
    }),
  );

  return toSessionMutationResult(result);
}

export async function runSessionSetModelDirect(
  options: RunSessionSetModelDirectOptions,
): Promise<SessionSetModelResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      // Explicit model switch replaces the saved pin. Do not re-apply the old
      // pin first: an unadvertised saved model would reject and block the switch.
      const models = advertisedModelState(record.acpx);
      const response = await withTimeout(
        client.setSessionModel(sessionId, options.modelId, models),
        options.timeoutMs,
      );
      applyConfigOptionsToRecord(record, response);
      setDesiredModelId(record, options.modelId, models?.configId);
      setCurrentModelId(record, currentModelIdFromSetModelResponse(response, options.modelId));
      return response;
    }),
  );

  return { ...toSessionMutationResult(result), response: result.value };
}

export async function runSessionSetConfigOptionDirect(
  options: RunSessionSetConfigOptionDirectOptions,
): Promise<SessionSetConfigOptionResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      const modelConfigId = advertisedModelState(record.acpx)?.configId;
      // Model-valued config updates replace the pin; skip pin replay so an
      // obsolete saved model cannot block the replacement. Other config keys
      // still re-apply the pin so model-dependent options see the right set.
      if (options.configId !== modelConfigId) {
        await reapplyPinnedModelAfterConnect({
          client,
          sessionId,
          record,
          timeoutMs: options.timeoutMs,
        });
      }
      const response = await withTimeout(
        client.setSessionConfigOption(sessionId, options.configId, options.value),
        options.timeoutMs,
      );
      applyConfigOptionsToRecord(record, response);
      if (options.configId === modelConfigId) {
        setDesiredModelId(record, options.value, options.configId);
        setCurrentModelId(record, currentModelIdFromSetModelResponse(response, options.value));
      } else if (options.configId === "mode") {
        setDesiredModeId(record, options.value);
      } else {
        setDesiredConfigOption(record, options.configId, options.value);
      }
      return response;
    }),
  );

  return {
    record: result.record,
    response: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}
