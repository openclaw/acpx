import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { DEFAULT_AGENT_NAME } from "./agent-registry.js";
import type { AcpControlAuthority } from "./async-control.js";
import { AcpRuntimeManager } from "./runtime/engine/manager.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  AcpSessionStore,
  AcpSessionRecord,
} from "./runtime/public/contract.js";
import { AcpRuntimeError } from "./runtime/public/errors.js";
import { createFileSessionStore } from "./runtime/public/file-session-store.js";
import { decodeAcpxRuntimeHandleState, writeHandleState } from "./runtime/public/handle-state.js";
import { normalizeRuntimeDetails } from "./runtime/public/probe.js";
import { deriveAgentFromSessionKey, type AcpxHandleState } from "./runtime/public/shared.js";

export { DEFAULT_AGENT_NAME, createFileSessionStore };
export { createAgentRegistry } from "./agent-registry.js";
export { inspectAgentModels } from "./runtime/public/probe.js";
export type { InspectAgentModelsOptions } from "./runtime/public/probe.js";
export type {
  AcpAgentInspection,
  AcpAgentInspectionOptions,
  AcpInspectableAgentRegistry,
} from "./agent-registry.js";
export { AcpRuntimeError, isAcpRuntimeError } from "./runtime/public/errors.js";
export type { AcpRuntimeErrorCode } from "./runtime/public/errors.js";
export {
  REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE,
  REQUESTED_MODEL_UNSUPPORTED_REASONS,
  isRequestedModelUnsupportedError,
  RequestedModelUnsupportedError,
} from "./acp/model-support.js";
export type {
  RequestedModelUnsupportedErrorCode,
  RequestedModelUnsupportedReason,
} from "./acp/model-support.js";
export {
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
} from "./runtime/public/handle-state.js";
export type {
  AcpAgentRegistry,
  AcpElicitationContext,
  AcpElicitationHandler,
  AcpElicitationMode,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpFileSessionStoreOptions,
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPermissionRequest,
  AcpProcessExit,
  AcpProcessLaunch,
  AcpProcessLaunchScope,
  AcpProcessLifecycle,
  AcpProcessSpawnFailure,
  AcpProcessStarted,
  AcpRuntime,
  AcpRuntimeAvailableCommand,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpTextDeltaOriginMeta,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimePlanEntry,
  AcpRuntimePromptMode,
  AcpRuntimeSessionMode,
  AcpRuntimeSessionContext,
  AcpRuntimeSessionPermissions,
  AcpRuntimeSessionModels,
  AcpRuntimeSessionUsage,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpRuntimeUsageBreakdown,
  AcpRuntimeUsageCost,
  AcpSessionRecord,
  AcpSessionStore,
  AcpSessionUpdateTag,
  PermissionPolicy,
  SessionAgentOptions,
  SystemPromptOption,
} from "./runtime/public/contract.js";

export const ACPX_BACKEND_ID = "acpx";

export { createSharedAcpRuntime, SharedAcpRuntime } from "./runtime/shared.js";
export type { SharedAcpRuntimeOptions } from "./runtime/shared.js";
export type { SessionWatchEvent, SessionWatchResult } from "./session/journal.js";

const ACPX_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: [
    "session/set_mode",
    "session/set_model",
    "session/set_config_option",
    "session/status",
  ],
};

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor(): Promise<AcpRuntimeDoctorReport>;
};

export class AcpxRuntime implements AcpxRuntimeLike {
  private healthy = false;
  private shutdownTask?: Promise<void>;
  private readonly probeTasks = new Set<Promise<unknown>>();
  private manager: AcpRuntimeManager | null = null;
  private managerPromise: Promise<AcpRuntimeManager> | null = null;

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly testOptions?: {
      managerFactory?: (options: AcpRuntimeOptions) => AcpRuntimeManager;
      probeRunner?: (options: AcpRuntimeOptions) => Promise<{
        ok: boolean;
        message: string;
        details?: unknown[];
      }>;
    },
  ) {
    if (options.agentProcessEnv) {
      this.options = { ...options, agentProcessEnv: { ...options.agentProcessEnv } };
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeAvailability(): Promise<void> {
    const report = await this.runProbe();
    this.healthy = report.ok;
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    const report = await this.runProbe();
    this.healthy = report.ok;
    return {
      ok: report.ok,
      code: report.ok ? undefined : "ACP_BACKEND_UNAVAILABLE",
      message: report.message,
      details: normalizeRuntimeDetails(report.details),
    };
  }

  private resolveSessionIdentity(input: { sessionKey: string; agent: string }) {
    const sessionName = input.sessionKey.trim();
    if (!sessionName) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = input.agent.trim();
    if (!agent) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
    }

    return { sessionName, agent };
  }

  async findSession(input: {
    sessionKey: string;
    agent: string;
  }): Promise<AcpRuntimeHandle | undefined> {
    const { sessionName, agent } = this.resolveSessionIdentity(input);
    const record = await (await this.getManager()).findSession(sessionName);
    return record
      ? this.createSessionHandle(
          { sessionKey: input.sessionKey, agent, mode: "persistent" },
          record,
        )
      : undefined;
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const { sessionName, agent } = this.resolveSessionIdentity(input);
    const manager = await this.getManager();
    const record = await manager.ensureSession({
      sessionKey: sessionName,
      agent,
      mode: input.mode,
      cwd: input.cwd ?? this.options.cwd,
      resumeSessionId: input.resumeSessionId,
      sessionOptions: input.sessionOptions,
    });

    return this.createSessionHandle({ ...input, agent }, record);
  }

  private createSessionHandle(
    input: Pick<AcpRuntimeEnsureInput, "sessionKey" | "agent" | "mode">,
    record: AcpSessionRecord,
  ): AcpRuntimeHandle {
    const handle: AcpRuntimeHandle = {
      sessionKey: input.sessionKey,
      backend: ACPX_BACKEND_ID,
      runtimeSessionName: "",
      cwd: record.cwd,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    };
    writeHandleState(handle, {
      name: input.sessionKey.trim(),
      agent: input.agent,
      cwd: record.cwd,
      mode: input.mode,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    });
    return handle;
  }

  startTurn(input: AcpRuntimeTurnInput) {
    const { handle, state } = this.resolveManagerHandle(input.handle);
    const managerPromise = this.getManager();
    const turnPromise = managerPromise.then((manager) =>
      manager.startTurn({
        handle,
        text: input.text,
        attachments: input.attachments,
        mode: input.mode,
        sessionMode: state.mode,
        requestId: input.requestId,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        assertActive: input.assertActive,
        onElicitation: input.onElicitation,
        onPermissionRequest: input.onPermissionRequest,
      }),
    );
    return {
      requestId: input.requestId,
      get promptStarted() {
        return turnPromise.then((turn) => turn.promptStarted);
      },
      events: {
        async *[Symbol.asyncIterator]() {
          const turn = await turnPromise;
          yield* turn.events;
        },
      },
      get result() {
        return turnPromise.then((turn) => turn.result);
      },
      cancel(inputArgs?: { reason?: string }) {
        return turnPromise.then((turn) => turn.cancel(inputArgs));
      },
      closeStream(inputArgs?: { reason?: string }) {
        return turnPromise.then((turn) => turn.closeStream(inputArgs));
      },
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const { handle, state } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    yield* manager.runTurn({
      handle,
      text: input.text,
      attachments: input.attachments,
      mode: input.mode,
      sessionMode: state.mode,
      requestId: input.requestId,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      assertActive: input.assertActive,
      onElicitation: input.onElicitation,
      onPermissionRequest: input.onPermissionRequest,
    });
  }

  async getCapabilities(input?: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities> {
    if (!input?.handle) {
      return ACPX_CAPABILITIES;
    }

    const { handle } = this.resolveManagerHandle(input.handle);
    const record = await this.options.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
    if (!record?.acpx?.config_options) {
      return ACPX_CAPABILITIES;
    }

    const configOptionKeys = Array.from(
      new Set(
        record.acpx.config_options
          .map((option) => option.id)
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
      ),
    );

    return {
      ...ACPX_CAPABILITIES,
      ...(configOptionKeys.length > 0 ? { configOptionKeys } : {}),
    };
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const { handle } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    return await manager.getStatus(handle);
  }

  async setMode(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle; mode: string },
  ): Promise<void> {
    const { handle, state } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    await manager.setMode(handle, input.mode, state.mode, input);
  }

  async setModel(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle; model: string },
  ): Promise<void> {
    const { handle, state } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    await manager.setModel(handle, input.model, state.mode, input);
  }

  async setConfigOption(
    input: AcpControlAuthority & {
      handle: AcpRuntimeHandle;
      key: string;
      value: string;
    },
  ): Promise<SetSessionConfigOptionResponse> {
    const { handle, state } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    return await manager.setConfigOption(handle, input.key, input.value, state.mode, input);
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const { handle } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    await manager.cancel(handle);
  }

  async prepareFreshSession(input: { handle: AcpRuntimeHandle }): Promise<void> {
    const { handle } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    await manager.prepareFreshSession(handle);
  }

  async close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void> {
    const { handle } = this.resolveManagerHandle(input.handle);
    const manager = await this.getManager();
    await manager.close(handle, {
      discardPersistentState: input.discardPersistentState,
    });
  }

  shutdown(): Promise<void> {
    if (!this.shutdownTask) {
      this.healthy = false;
      const managerShutdown = this.managerPromise?.then((manager) => manager.shutdown());
      this.shutdownTask = Promise.allSettled([managerShutdown, ...this.probeTasks]).then(
        ([manager]) => {
          if (manager.status === "rejected") {
            throw manager.reason;
          }
        },
      );
    }
    return this.shutdownTask;
  }

  private async getManager(): Promise<AcpRuntimeManager> {
    if (this.shutdownTask) {
      throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
    }
    if (this.manager) {
      return this.manager;
    }
    if (!this.managerPromise) {
      this.managerPromise = Promise.resolve(
        this.testOptions?.managerFactory?.(this.options) ?? new AcpRuntimeManager(this.options),
      ).then((manager) => {
        this.manager = manager;
        return manager;
      });
    }
    return await this.managerPromise;
  }

  private async runProbe() {
    if (this.shutdownTask) {
      throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
    }
    const probe =
      this.testOptions?.probeRunner?.(this.options) ??
      this.getManager().then((manager) => manager.probe());
    this.probeTasks.add(probe);
    try {
      const report = await probe;
      if (this.shutdownTask) {
        throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
      }
      return report;
    } finally {
      this.probeTasks.delete(probe);
    }
  }

  private resolveManagerHandle(handle: AcpRuntimeHandle): {
    handle: AcpRuntimeHandle;
    state: AcpxHandleState;
  } {
    const state = this.resolveHandleState(handle);
    return {
      handle: {
        ...handle,
        acpxRecordId: state.acpxRecordId ?? handle.acpxRecordId ?? handle.sessionKey,
      },
      state,
    };
  }

  private resolveHandleState(handle: AcpRuntimeHandle): AcpxHandleState {
    const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    if (decoded) {
      return {
        ...decoded,
        acpxRecordId: decoded.acpxRecordId ?? handle.acpxRecordId,
        backendSessionId: decoded.backendSessionId ?? handle.backendSessionId,
        agentSessionId: decoded.agentSessionId ?? handle.agentSessionId,
      };
    }

    const runtimeSessionName = handle.runtimeSessionName.trim();
    if (!runtimeSessionName) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Invalid embedded ACP runtime handle: runtimeSessionName is missing.",
      );
    }

    return {
      name: runtimeSessionName,
      agent: deriveAgentFromSessionKey(handle.sessionKey, DEFAULT_AGENT_NAME),
      cwd: handle.cwd ?? this.options.cwd,
      mode: "persistent",
      acpxRecordId: handle.acpxRecordId,
      backendSessionId: handle.backendSessionId,
      agentSessionId: handle.agentSessionId,
    };
  }
}

export function createAcpRuntime(options: AcpRuntimeOptions): AcpxRuntime {
  return new AcpxRuntime(options);
}

export function createRuntimeStore(options: { stateDir: string }): AcpSessionStore {
  return createFileSessionStore(options);
}
