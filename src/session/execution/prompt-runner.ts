import { withTimeout } from "../../async-control.js";
import {
  withConnectedSession,
  type FullConnectedSessionController,
  type WithConnectedSessionOptions,
  type WithConnectedSessionResult,
} from "../../runtime/engine/connected-session.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import { applyConfigOptionSelection, applyModelSelection } from "../config-options.js";
import { setDesiredModeId } from "../mode-preference.js";
import { advertisedModelState } from "../model-state.js";
import { resolveSessionRecord, writeSessionRecord } from "../persistence.js";
import type { QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";

export type ActiveSessionController = QueueOwnerActiveSessionController;

type SessionControlConnectionOptions = {
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

export type RunSessionSetModeDirectOptions = SessionControlConnectionOptions & {
  modeId: string;
};

export type RunSessionSetConfigOptionDirectOptions = SessionControlConnectionOptions & {
  configId: string;
  value: string;
};

export type RunSessionSetModelDirectOptions = SessionControlConnectionOptions & {
  modelId: string;
};

type DirectConnectedSessionOptions = SessionControlConnectionOptions & {
  replacingConfigOption?: WithConnectedSessionOptions<unknown>["replacingConfigOption"];
};

function buildDirectConnectedSessionOptions<T>(
  options: DirectConnectedSessionOptions,
  run: WithConnectedSessionOptions<T>["run"],
): WithConnectedSessionOptions<T> {
  return {
    sessionRecordId: options.sessionRecordId,
    replacingConfigOption: options.replacingConfigOption,
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

export async function runSessionSetModeDirect(
  options: RunSessionSetModeDirectOptions,
): Promise<SessionSetModeResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
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
    buildDirectConnectedSessionOptions(
      { ...options, replacingConfigOption: { key: "model" } },
      async ({ client, sessionId, record }) => {
        const models = advertisedModelState(record.acpx);
        const response = await withTimeout(
          client.setSessionModel(sessionId, options.modelId, models),
          options.timeoutMs,
        );
        record.acpx = applyModelSelection(record.acpx, options.modelId, response);
        return response;
      },
    ),
  );

  return { ...toSessionMutationResult(result), response: result.value };
}

export async function runSessionSetConfigOptionDirect(
  options: RunSessionSetConfigOptionDirectOptions,
): Promise<SessionSetConfigOptionResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(
      { ...options, replacingConfigOption: { key: options.configId } },
      async ({ client, sessionId, record }) => {
        const response = await withTimeout(
          client.setSessionConfigOption(sessionId, options.configId, options.value),
          options.timeoutMs,
        );
        record.acpx = applyConfigOptionSelection(
          record.acpx,
          options.configId,
          options.value,
          response,
        );
        return response;
      },
    ),
  );

  return {
    record: result.record,
    response: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}
