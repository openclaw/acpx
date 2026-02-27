import { AcpClient } from "../client.js";
import { withInterrupt, withTimeout } from "../session-runtime-helpers.js";
import {
  absolutePath,
  isoNow,
  resolveSessionRecord,
  writeSessionRecord,
} from "../session-persistence.js";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  PermissionMode,
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModeResult,
} from "../types.js";
import type { QueueOwnerActiveSessionController } from "../queue-owner-turn-controller.js";
import { connectAndLoadSession } from "./connect-load.js";
import { applyLifecycleSnapshotToRecord } from "./lifecycle.js";

export type ActiveSessionController = QueueOwnerActiveSessionController;

type WithConnectedSessionOptions<T> = {
  sessionRecordId: string;
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  run: (client: AcpClient, sessionId: string, record: SessionRecord) => Promise<T>;
};

type WithConnectedSessionResult<T> = {
  value: T;
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

async function withConnectedSession<T>(
  options: WithConnectedSessionOptions<T>,
): Promise<WithConnectedSessionResult<T>> {
  const record = await resolveSessionRecord(options.sessionRecordId);
  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: absolutePath(record.cwd),
    permissionMode: options.permissionMode ?? "approve-reads",
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
  });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(
        activeSessionIdForControl,
        configId,
        value,
      );
    },
  };

  try {
    return await withInterrupt(
      async () => {
        const {
          sessionId: activeSessionId,
          resumed,
          loadError,
        } = await connectAndLoadSession({
          client,
          record,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          activeController,
          onClientAvailable: (controller) => {
            options.onClientAvailable?.(controller);
            notifiedClientAvailable = true;
          },
          onSessionIdResolved: (sessionId) => {
            activeSessionIdForControl = sessionId;
          },
        });

        const value = await options.run(client, activeSessionId, record);

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await writeSessionRecord(record);

        return {
          value,
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.cancelActivePrompt(2_500);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        await writeSessionRecord(record).catch(() => {
          // best effort while process is being interrupted
        });
        await client.close();
      },
    );
  } finally {
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record).catch(() => {
      // best effort on close
    });
  }
}

export type RunSessionSetModeDirectOptions = {
  sessionRecordId: string;
  modeId: string;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetConfigOptionDirectOptions = {
  sessionRecordId: string;
  configId: string;
  value: string;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export async function runSessionSetModeDirect(
  options: RunSessionSetModeDirectOptions,
): Promise<SessionSetModeResult> {
  const result = await withConnectedSession({
    sessionRecordId: options.sessionRecordId,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    run: async (client, sessionId) => {
      await withTimeout(
        client.setSessionMode(sessionId, options.modeId),
        options.timeoutMs,
      );
    },
  });

  return {
    record: result.record,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

export async function runSessionSetConfigOptionDirect(
  options: RunSessionSetConfigOptionDirectOptions,
): Promise<SessionSetConfigOptionResult> {
  const result = await withConnectedSession({
    sessionRecordId: options.sessionRecordId,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    run: async (client, sessionId) => {
      return await withTimeout(
        client.setSessionConfigOption(sessionId, options.configId, options.value),
        options.timeoutMs,
      );
    },
  });

  return {
    record: result.record,
    response: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}
