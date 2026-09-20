import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { normalizeAgentCommandInput } from "../acp/client-process.js";
import { normalizeOutputError } from "../acp/error-normalization.js";
import { createAgentRegistry, type AcpAgentRegistry } from "../agent-registry.js";
import { assertControlAuthority, type AcpControlAuthority } from "../async-control.js";
import { textPrompt } from "../prompt-content.js";
import { DISCARD_OUTPUT_FORMATTER } from "../session/execution/discard-output.js";
import { sendSession } from "../session/execution/queue-owner-runtime.js";
import {
  closeSession,
  cancelSessionPrompt,
  setSessionConfigOptionOnOwner,
  setSessionModeOnOwner,
  setSessionModelOnOwner,
} from "../session/execution/session-control.js";
import { ensureSession } from "../session/execution/session-management.js";
import { findSession, readSessionRecord, resolveSessionRecord } from "../session/persistence.js";
import { tryCancelOnRunningOwner } from "../session/queue/ipc.js";
import { watchSession } from "../session/watch.js";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionPolicy,
  SessionRecord,
} from "../types.js";
import { capabilitiesFromRecord, resolveSupportedConfigOptionId } from "./engine/controls.js";
import { runtimeStatusFromRecord } from "./engine/status.js";
import {
  AsyncEventQueue,
  createDeferred,
  legacyTerminalEventFromTurnResult,
  toPromptInput,
} from "./engine/turn.js";
import type {
  AcpRuntimeCapabilities,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "./public/contract.js";
import { AcpRuntimeError } from "./public/errors.js";
import { parsePromptEventLine } from "./public/events.js";

export type SharedAcpRuntimeOptions = {
  cwd: string;
  agentRegistry?: AcpAgentRegistry;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  ttlMs?: number;
};

const SHARED_BACKEND = "acpx-shared";

function invalidOption(message: string): never {
  throw new AcpRuntimeError("ACP_INVALID_RUNTIME_OPTION", message);
}

function sharedHandle(record: SessionRecord): AcpRuntimeHandle {
  return {
    backend: SHARED_BACKEND,
    sessionKey: record.name ?? "",
    runtimeSessionName: record.acpxRecordId,
    acpxRecordId: record.acpxRecordId,
    backendSessionId: record.acpSessionId,
    agentSessionId: record.agentSessionId,
    cwd: record.cwd,
  };
}

function sharedRecordId(handle: AcpRuntimeHandle): string {
  if (handle.backend !== SHARED_BACKEND || !handle.acpxRecordId) {
    return invalidOption("A shared runtime requires a handle from a shared session.");
  }
  return handle.acpxRecordId;
}

/**
 * Shared controls are owner-only. Falling back to a direct connection would
 * start a second adapter connection for a session another process owns, and
 * that path may create a fresh provider session when the saved one no longer
 * loads. Shared turns already refuse that trade; controls refuse it too.
 */
function requireOwnerDispatch<T>(result: T | undefined, control: string): T {
  if (result === undefined) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNAVAILABLE",
      `No running owner holds this shared session, so ${control} was not sent. Submit a turn to start an owner, or apply the change with the equivalent acpx command, which connects directly instead of starting one.`,
    );
  }
  return result;
}

function turnFailure(error: unknown): AcpRuntimeTurnResult {
  const normalized = normalizeOutputError(error, { defaultCode: "RUNTIME", origin: "queue" });
  if (normalized.detailCode === "QUEUE_REQUEST_CANCELLED") {
    return { status: "cancelled", stopReason: "cancelled" };
  }
  return {
    status: "failed",
    error: {
      message: normalized.message,
      code: normalized.code,
      detailCode: normalized.detailCode,
      retryable: normalized.retryable,
    },
  };
}

/** A client of the CLI's local session owner. Shutdown detaches this client. */
export class SharedAcpRuntime {
  private readonly registry: AcpAgentRegistry;
  private readonly options: SharedAcpRuntimeOptions;
  private readonly disconnect = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controlChains = new Map<string, Promise<void>>();

  constructor(options: SharedAcpRuntimeOptions) {
    for (const name of [
      "sessionStore",
      "agentProcessEnv",
      "mcpServers",
      "sessionPermissions",
      "processLifecycle",
      "onPermissionRequest",
      "elicitationModes",
      "fs",
      "terminal",
    ]) {
      if (Object.hasOwn(options, name)) {
        invalidOption(
          `${name} belongs to the in-process runtime and is not supported by shared sessions.`,
        );
      }
    }
    this.options = {
      ...options,
      cwd: path.resolve(options.cwd),
      authCredentials: options.authCredentials ? { ...options.authCredentials } : undefined,
    };
    this.registry = options.agentRegistry ?? createAgentRegistry();
  }

  private assertOpen(): void {
    if (this.disconnect.signal.aborted) {
      throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "Shared ACP runtime is shut down.");
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  private sessionOptions(input: { sessionKey: string; agent: string; cwd?: string }) {
    if (!input.agent.trim()) {
      invalidOption("ACP agent id is required.");
    }
    return {
      ...normalizeAgentCommandInput(this.registry.resolve(input.agent)),
      cwd: path.resolve(input.cwd ?? this.options.cwd),
      name: input.sessionKey.trim() || undefined,
    };
  }

  async findSession(input: {
    sessionKey: string;
    agent: string;
    cwd?: string;
  }): Promise<AcpRuntimeHandle | undefined> {
    this.assertOpen();
    const record = await findSession(this.sessionOptions(input));
    return record ? sharedHandle(record) : undefined;
  }

  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    this.assertOpen();
    if (input.mode !== "persistent") {
      invalidOption(
        "Shared sessions require persistent mode; use the in-process runtime for oneshot sessions.",
      );
    }
    const session = this.sessionOptions(input);
    return this.track(
      ensureSession({
        ...this.options,
        ...session,
        walkBoundary: session.cwd,
        sessionOptions: input.sessionOptions,
        resumeSessionId: input.resumeSessionId,
        handleProcessInterrupts: false,
        signal: this.disconnect.signal,
      }).then(({ record }) => {
        this.assertOpen();
        return sharedHandle(record);
      }),
    );
  }

  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
    this.assertOpen();
    if (
      input.mode !== "prompt" ||
      input.assertActive ||
      input.onPermissionRequest ||
      input.onElicitation
    ) {
      invalidOption(
        "Shared turns support prompt mode and the client's static permission policy; in-process callbacks and steering are unsupported.",
      );
    }
    if (!input.requestId.trim()) {
      invalidOption("A shared turn requires a requestId.");
    }
    const sessionId = sharedRecordId(input.handle);
    const prompt = toPromptInput(input.text, input.attachments);
    const events = new AsyncEventQueue();
    const promptStarted = createDeferred<void>();
    void promptStarted.promise.catch(() => {});
    let accepted = false;
    let settled = false;
    let cancelRequested = input.signal?.aborted === true;
    let cancellation: Promise<void> | undefined;
    const cancel = async (): Promise<void> => {
      cancelRequested = true;
      if (!accepted || settled) {
        return;
      }
      cancellation ??= tryCancelOnRunningOwner({
        sessionId,
        targetRequestId: input.requestId,
      }).then(() => {});
      await cancellation;
    };
    const onAbort = () => {
      void cancel().catch(() => {});
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const run = async (): Promise<AcpRuntimeTurnResult> => {
      if (cancelRequested) {
        return { status: "cancelled", stopReason: "cancelled" };
      }
      const record = await resolveSessionRecord(sessionId);
      if (record.closed) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "Shared session is closed; ensure it again before submitting a turn.",
        );
      }
      if (cancelRequested) {
        return { status: "cancelled", stopReason: "cancelled" };
      }
      const result = await sendSession({
        ...this.options,
        sessionId,
        requestId: input.requestId,
        prompt: typeof prompt === "string" ? textPrompt(prompt) : prompt,
        resumePolicy: "same-session-only",
        requireSharedRuntime: true,
        signal: this.disconnect.signal,
        timeoutMs: input.timeoutMs ?? this.options.timeoutMs,
        queueOwnerArgs: [fileURLToPath(import.meta.resolve("acpx/dist/cli.js")), "__queue-owner"],
        onQueueAccepted: () => {
          accepted = true;
          if (cancelRequested) {
            void cancel().catch(() => {});
          }
        },
        onPromptStarted: () => promptStarted.resolve(),
        outputFormatter: {
          ...DISCARD_OUTPUT_FORMATTER,
          onAcpMessage: (message) => {
            const event = parsePromptEventLine(JSON.stringify(message));
            if (event) {
              events.push(event);
            }
          },
        },
        errorEmissionPolicy: { queueErrorAlreadyEmitted: false },
        waitForCompletion: true,
      });
      if ("queued" in result) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          "Shared turn ended without a completion result.",
        );
      }
      return {
        status: result.stopReason === "cancelled" ? "cancelled" : "completed",
        stopReason: result.stopReason,
        _meta: result._meta,
      };
    };
    const result = this.track(
      run()
        .catch(turnFailure)
        .finally(() => {
          settled = true;
          promptStarted.reject(
            new AcpRuntimeError("ACP_TURN_FAILED", "Turn settled before its prompt was written."),
          );
          input.signal?.removeEventListener("abort", onAbort);
          events.close();
        }),
    );
    return {
      requestId: input.requestId,
      promptStarted: promptStarted.promise,
      events: events.iterate(),
      result,
      cancel,
      closeStream: async () => {
        events.clear();
        events.close();
      },
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput) {
    const turn = this.startTurn(input);
    yield* turn.events;
    yield legacyTerminalEventFromTurnResult(await turn.result);
  }

  async getStatus(input: { handle: AcpRuntimeHandle }) {
    this.assertOpen();
    return runtimeStatusFromRecord(await resolveSessionRecord(sharedRecordId(input.handle)));
  }

  async getCapabilities(input?: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities> {
    this.assertOpen();
    if (!input?.handle) {
      return capabilitiesFromRecord(undefined);
    }
    return capabilitiesFromRecord(await readSessionRecord(sharedRecordId(input.handle)));
  }

  /**
   * Preserves this client's control order, including caller-side persistence
   * when talking to older owners. Updated owners checkpoint accepted controls
   * themselves; serialization here cannot coordinate other legacy callers.
   */
  private chainControl<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.controlChains.get(sessionId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const chained = result.then(
      () => undefined,
      () => undefined,
    );
    this.controlChains.set(sessionId, chained);
    void chained.then(() => {
      if (this.controlChains.get(sessionId) === chained) {
        this.controlChains.delete(sessionId);
      }
    });
    return result;
  }

  /**
   * Checks this client's authority locally, then hands the control to the
   * running owner. The check gates this client's dispatch only; it cannot gate
   * controls other clients of the same owner send, and it cannot recall a
   * control the owner already accepted.
   */
  private async dispatchControl<T>(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle },
    control: string,
    send: (sessionId: string, assertAuthority: () => void) => Promise<T | undefined>,
  ): Promise<T> {
    this.assertOpen();
    const sessionId = sharedRecordId(input.handle);
    // Owner lookup, the config-key read and the socket connect all happen after
    // the first check, so authority is asserted again at each point that would
    // otherwise let a withdrawn control still reach the owner. It is never
    // consulted after the write, so a dispatched control still settles.
    const assertAuthority = () => {
      this.assertOpen();
      assertControlAuthority(input);
    };
    return await this.track(
      this.chainControl(sessionId, async () => {
        assertAuthority();
        return requireOwnerDispatch(await send(sessionId, assertAuthority), control);
      }),
    );
  }

  async setMode(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle; mode: string },
  ): Promise<void> {
    await this.dispatchControl(input, "session/set_mode", async (sessionId, assertAuthority) =>
      setSessionModeOnOwner({
        sessionId,
        modeId: input.mode,
        timeoutMs: this.options.timeoutMs,
        assertDispatch: assertAuthority,
      }),
    );
  }

  async setModel(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle; model: string },
  ): Promise<void> {
    await this.dispatchControl(input, "session/set_model", async (sessionId, assertAuthority) =>
      setSessionModelOnOwner({
        sessionId,
        modelId: input.model,
        timeoutMs: this.options.timeoutMs,
        assertDispatch: assertAuthority,
      }),
    );
  }

  async setConfigOption(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle; key: string; value: string },
  ): Promise<SetSessionConfigOptionResponse> {
    const result = await this.dispatchControl(
      input,
      "session/set_config_option",
      async (sessionId, assertAuthority) => {
        const configId = resolveSupportedConfigOptionId(
          await resolveSessionRecord(sessionId),
          input.key,
        );
        assertAuthority();
        return await setSessionConfigOptionOnOwner({
          sessionId,
          configId,
          value: input.value,
          timeoutMs: this.options.timeoutMs,
          assertDispatch: assertAuthority,
        });
      },
    );
    return result.response;
  }

  watchSession(input: { handle: AcpRuntimeHandle; cursor?: string; signal?: AbortSignal }) {
    this.assertOpen();
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.disconnect.signal])
      : this.disconnect.signal;
    const recordId = sharedRecordId(input.handle);
    const record = readSessionRecord(recordId).then((value) => {
      if (!value || value.acpxRecordId !== recordId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "Shared session record is unavailable.",
        );
      }
      return value;
    });
    void record.catch(() => {});
    return watchSession({ record, cursor: input.cursor, signal });
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    this.assertOpen();
    await this.track(cancelSessionPrompt({ sessionId: sharedRecordId(input.handle) }));
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    this.assertOpen();
    await this.track(closeSession(sharedRecordId(input.handle)));
  }

  async shutdown(): Promise<void> {
    this.disconnect.abort(
      new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "Shared client detached; submitted work may still be running.",
      ),
    );
    await Promise.allSettled(this.pending);
  }
}

export function createSharedAcpRuntime(options: SharedAcpRuntimeOptions): SharedAcpRuntime {
  return new SharedAcpRuntime(options);
}
