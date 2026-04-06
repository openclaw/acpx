import { DEFAULT_AGENT_NAME, listBuiltInAgents, resolveAgentCommand } from "./agent-registry.js";
import { AcpRuntimeManager } from "./runtime/engine/manager.js";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeStatus,
  AcpSessionStore,
} from "./runtime/public/contract.js";
import { AcpRuntimeError } from "./runtime/public/errors.js";
import { createFileSessionStore } from "./runtime/public/file-session-store.js";
import { decodeAcpxRuntimeHandleState, writeHandleState } from "./runtime/public/handle-state.js";
import { probeRuntime } from "./runtime/public/probe.js";
import { deriveAgentFromSessionKey, type AcpxHandleState } from "./runtime/public/shared.js";

export { DEFAULT_AGENT_NAME, createFileSessionStore };
export { AcpRuntimeError, isAcpRuntimeError } from "./runtime/public/errors.js";
export type { AcpRuntimeErrorCode } from "./runtime/public/errors.js";
export {
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
} from "./runtime/public/handle-state.js";
export type {
  AcpAgentRegistry,
  AcpFileSessionStoreOptions,
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimePromptMode,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpSessionRecord,
  AcpSessionStore,
  AcpSessionUpdateTag,
} from "./runtime/public/contract.js";

export const ACPX_BACKEND_ID = "acpx";

const ACPX_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_mode", "session/set_config_option", "session/status"],
};

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor(): Promise<AcpRuntimeDoctorReport>;
};

export function createAgentRegistry(params?: {
  overrides?: Record<string, string>;
}): AcpAgentRegistry {
  return {
    resolve(agentName: string) {
      return resolveAgentCommand(agentName, params?.overrides);
    },
    list() {
      return listBuiltInAgents(params?.overrides);
    },
  };
}

export class AcpxRuntime implements AcpxRuntimeLike {
  private healthy = false;
  private manager: AcpRuntimeManager | null = null;
  private managerPromise: Promise<AcpRuntimeManager> | null = null;

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly testOptions?: {
      managerFactory?: (options: AcpRuntimeOptions) => AcpRuntimeManager;
      probeRunner?: (options: AcpRuntimeOptions) => Promise<{
        ok: boolean;
        message: string;
        details?: string[];
      }>;
    },
  ) {}

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
      details: report.details,
    };
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const sessionName = input.sessionKey.trim();
    if (!sessionName) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = input.agent.trim();
    if (!agent) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
    }

    const manager = await this.getManager();
    const record = await manager.ensureSession({
      sessionKey: sessionName,
      agent,
      mode: input.mode,
      cwd: input.cwd ?? this.options.cwd,
      resumeSessionId: input.resumeSessionId,
    });

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
      name: sessionName,
      agent,
      cwd: record.cwd,
      mode: input.mode,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    });
    return handle;
  }

  async *runTurn(
    input: import("./runtime/public/contract.js").AcpRuntimeTurnInput,
  ): AsyncIterable<import("./runtime/public/contract.js").AcpRuntimeEvent> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    yield* manager.runTurn({
      handle: {
        ...input.handle,
        acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
      },
      text: input.text,
      attachments: input.attachments,
      mode: input.mode,
      sessionMode: state.mode,
      requestId: input.requestId,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return ACPX_CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    return await manager.getStatus({
      ...input.handle,
      acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
    });
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.setMode(
      {
        ...input.handle,
        acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
      },
      input.mode,
      state.mode,
    );
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.setConfigOption(
      {
        ...input.handle,
        acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
      },
      input.key,
      input.value,
      state.mode,
    );
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.cancel({
      ...input.handle,
      acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
    });
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.close({
      ...input.handle,
      acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
    });
  }

  private async getManager(): Promise<AcpRuntimeManager> {
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
    return await (this.testOptions?.probeRunner?.(this.options) ?? probeRuntime(this.options));
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
