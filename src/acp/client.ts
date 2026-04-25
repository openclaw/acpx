import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type AuthMethod,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type SessionModelState,
} from "@agentclientprotocol/sdk";
import { resolveBuiltInAgentLaunch } from "../agent-registry.js";
import { TimeoutError, withTimeout } from "../async-control.js";
import {
  AgentDisconnectedError,
  AgentSpawnError,
  AgentStartupError,
  AuthPolicyError,
  ClaudeAcpSessionCreateTimeoutError,
  GeminiAcpStartupTimeoutError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "../errors.js";
import { FileSystemHandlers } from "../filesystem.js";
import { classifyPermissionDecision, resolvePermissionRequest } from "../permissions.js";
import { textPrompt } from "../prompt-content.js";
import { extractRuntimeSessionId } from "../session/runtime-session-id.js";
import { buildSpawnCommandOptions } from "../spawn-command-options.js";
import type {
  AcpClientOptions,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionStats,
  PromptInput,
} from "../types.js";
import {
  buildClaudeAcpSessionCreateTimeoutMessage,
  buildClaudeCodeOptionsMeta,
  buildGeminiAcpStartupTimeoutMessage,
  buildQoderAcpCommandArgs,
  ensureCopilotAcpSupport,
  isClaudeAcpCommand,
  isCopilotAcpCommand,
  isGeminiAcpCommand,
  isQoderAcpCommand,
  resolveAgentCloseAfterStdinEndMs,
  resolveClaudeAcpSessionCreateTimeoutMs,
  resolveGeminiAcpStartupTimeoutMs,
  resolveGeminiCommandArgs,
  shouldIgnoreNonJsonAgentOutputLine,
} from "./agent-command.js";
import {
  buildAgentSpawnOptions,
  readEnvCredential,
  resolveConfiguredAuthCredential,
} from "./auth-env.js";
import {
  asAbsoluteCwd,
  isoNow,
  isChildProcessRunning,
  requireAgentStdio,
  splitCommandLine,
  waitForChildExit,
  waitForSpawn,
} from "./client-process.js";
import { extractAcpError } from "./error-shapes.js";
import { isSessionUpdateNotification } from "./jsonrpc.js";
import {
  formatSessionControlAcpSummary,
  maybeWrapSessionControlError,
} from "./session-control-errors.js";
import { TerminalManager } from "./terminal-manager.js";

export { buildSpawnCommandOptions };
export {
  buildAgentSpawnOptions,
  buildQoderAcpCommandArgs,
  resolveAgentCloseAfterStdinEndMs,
  shouldIgnoreNonJsonAgentOutputLine,
};

const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 20;
const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const AGENT_CLOSE_KILL_GRACE_MS = 1_000;
const STARTUP_STDERR_MAX_CHARS = 8_192;

type LoadSessionOptions = {
  suppressReplayUpdates?: boolean;
  replayIdleMs?: number;
  replayDrainTimeoutMs?: number;
};

export type SessionCreateResult = {
  sessionId: string;
  agentSessionId?: string;
  models?: SessionModelState;
};

export type SessionLoadResult = {
  agentSessionId?: string;
  models?: SessionModelState;
};

type AgentDisconnectReason = "process_exit" | "process_close" | "pipe_close" | "connection_close";

type PendingConnectionRequest = {
  settled: boolean;
  reject: (error: unknown) => void;
};

type AuthSelection = {
  methodId: string;
  credential: string;
  source: "env" | "config";
};

export type AgentExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
  reason: AgentDisconnectReason;
  unexpectedDuringPrompt: boolean;
};

export type AgentLifecycleSnapshot = {
  pid?: number;
  startedAt?: string;
  running: boolean;
  lastExit?: AgentExitInfo;
};

type ConsoleErrorMethod = typeof console.error;

function shouldSuppressSdkConsoleError(args: unknown[]): boolean {
  if (args.length === 0) {
    return false;
  }
  return typeof args[0] === "string" && args[0] === "Error handling request";
}

function installSdkConsoleErrorSuppression(): () => void {
  const originalConsoleError: ConsoleErrorMethod = console.error;
  console.error = (...args: unknown[]) => {
    if (shouldSuppressSdkConsoleError(args)) {
      return;
    }
    originalConsoleError(...args);
  };
  return () => {
    console.error = originalConsoleError;
  };
}

function createNdJsonMessageStream(
  agentCommand: string,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split("\n");
          content = lines.pop() || "";
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) {
              continue;
            }
            try {
              const message = JSON.parse(trimmedLine) as AnyMessage;
              controller.enqueue(message);
            } catch (err) {
              console.error("Failed to parse JSON message:", trimmedLine, err);
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

export class AcpClient {
  private options: AcpClientOptions;
  private connection?: ClientSideConnection;
  private agent?: ChildProcessByStdio<Writable, Readable, Readable>;
  private initResult?: InitializeResponse;
  private loadedSessionId?: string;
  private eventHandlers: Pick<
    AcpClientOptions,
    "onAcpMessage" | "onAcpOutputMessage" | "onSessionUpdate" | "onClientOperation"
  >;
  private readonly permissionStats: PermissionStats = {
    requested: 0,
    approved: 0,
    denied: 0,
    cancelled: 0,
  };
  private readonly filesystem: FileSystemHandlers;
  private readonly terminalManager: TerminalManager;
  private sessionUpdateChain: Promise<void> = Promise.resolve();
  private observedSessionUpdates = 0;
  private processedSessionUpdates = 0;
  private suppressSessionUpdates = false;
  private suppressReplaySessionUpdateMessages = false;
  private activePrompt?: {
    sessionId: string;
    promise: Promise<PromptResponse>;
  };
  private readonly cancellingSessionIds = new Set<string>();
  private closing = false;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;
  private readonly promptPermissionFailures = new Map<string, PermissionPromptUnavailableError>();
  private readonly pendingConnectionRequests = new Set<PendingConnectionRequest>();

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      cwd: asAbsoluteCwd(options.cwd),
      authPolicy: options.authPolicy ?? "skip",
    };
    this.eventHandlers = {
      onAcpMessage: this.options.onAcpMessage,
      onAcpOutputMessage: this.options.onAcpOutputMessage,
      onSessionUpdate: this.options.onSessionUpdate,
      onClientOperation: this.options.onClientOperation,
    };

    this.filesystem = new FileSystemHandlers({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: (operation) => {
        this.eventHandlers.onClientOperation?.(operation);
      },
    });
    this.terminalManager = new TerminalManager({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: (operation) => {
        this.eventHandlers.onClientOperation?.(operation);
      },
    });
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.initResult;
  }

  getAgentPid(): number | undefined {
    return this.agent?.pid ?? this.lastKnownPid;
  }

  getPermissionStats(): PermissionStats {
    return { ...this.permissionStats };
  }

  getAgentLifecycleSnapshot(): AgentLifecycleSnapshot {
    const pid = this.agent?.pid ?? this.lastKnownPid;
    const running =
      Boolean(this.agent) &&
      this.agent?.exitCode == null &&
      this.agent?.signalCode == null &&
      !this.agent?.killed;
    return {
      pid,
      startedAt: this.agentStartedAt,
      running,
      lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : undefined,
    };
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.loadSession);
  }

  supportsCloseSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.close);
  }

  setEventHandlers(
    handlers: Pick<
      AcpClientOptions,
      "onAcpMessage" | "onAcpOutputMessage" | "onSessionUpdate" | "onClientOperation"
    >,
  ): void {
    this.eventHandlers = { ...handlers };
  }

  clearEventHandlers(): void {
    this.eventHandlers = {};
  }

  updateRuntimeOptions(options: {
    permissionMode?: PermissionMode;
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    suppressSdkConsoleErrors?: boolean;
    verbose?: boolean;
  }): void {
    if (options.permissionMode) {
      this.options.permissionMode = options.permissionMode;
    }
    if (options.nonInteractivePermissions !== undefined) {
      this.options.nonInteractivePermissions = options.nonInteractivePermissions;
    }
    if (options.permissionMode || options.nonInteractivePermissions !== undefined) {
      this.filesystem.updatePermissionPolicy(
        this.options.permissionMode,
        this.options.nonInteractivePermissions,
      );
      this.terminalManager.updatePermissionPolicy(
        this.options.permissionMode,
        this.options.nonInteractivePermissions,
      );
    }
    if (options.suppressSdkConsoleErrors !== undefined) {
      this.options.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
    }
    if (options.verbose !== undefined) {
      this.options.verbose = options.verbose;
    }
  }

  hasReusableSession(sessionId: string): boolean {
    return (
      this.connection != null &&
      this.agent != null &&
      isChildProcessRunning(this.agent) &&
      this.loadedSessionId === sessionId
    );
  }

  hasActivePrompt(sessionId?: string): boolean {
    if (!this.activePrompt) {
      return false;
    }
    if (sessionId == null) {
      return true;
    }
    return this.activePrompt.sessionId === sessionId;
  }

  async start(): Promise<void> {
    if (this.connection && this.agent && isChildProcessRunning(this.agent)) {
      return;
    }
    if (this.connection || this.agent) {
      await this.close();
    }

    const configuredCommand = splitCommandLine(this.options.agentCommand);
    const resolvedBuiltInLaunch = resolveBuiltInAgentLaunch(this.options.agentCommand);
    const spawnCommand = resolvedBuiltInLaunch?.command ?? configuredCommand.command;
    let args = resolvedBuiltInLaunch?.args ?? configuredCommand.args;
    args = await resolveGeminiCommandArgs(spawnCommand, args);
    if (isQoderAcpCommand(spawnCommand, args)) {
      args = buildQoderAcpCommandArgs(args, this.options);
    }
    if (resolvedBuiltInLaunch?.source === "installed") {
      this.log(
        `spawning installed built-in agent ${resolvedBuiltInLaunch.packageName}${resolvedBuiltInLaunch.packageVersion ? `@${resolvedBuiltInLaunch.packageVersion}` : ""} via ${spawnCommand} ${args.join(" ")}`,
      );
    } else if (resolvedBuiltInLaunch?.source === "package-exec") {
      this.log(
        `spawning built-in agent ${resolvedBuiltInLaunch.packageName}@${resolvedBuiltInLaunch.packageRange} via current Node package exec bridge ${spawnCommand} ${args.join(" ")}`,
      );
    } else {
      this.log(`spawning agent: ${spawnCommand} ${args.join(" ")}`);
    }
    const geminiAcp = isGeminiAcpCommand(spawnCommand, args);
    const copilotAcp = isCopilotAcpCommand(spawnCommand, args);

    if (copilotAcp) {
      await ensureCopilotAcpSupport(spawnCommand);
    }

    const spawnedChild = spawn(
      spawnCommand,
      args,
      buildSpawnCommandOptions(
        spawnCommand,
        buildAgentSpawnOptions(this.options.cwd, this.options.authCredentials),
      ),
    ) as ChildProcessByStdio<Writable, Readable, Readable>;

    try {
      await waitForSpawn(spawnedChild);
    } catch (error) {
      throw new AgentSpawnError(this.options.agentCommand, error);
    }
    const child = requireAgentStdio(spawnedChild);
    this.closing = false;
    this.agentStartedAt = isoNow();
    this.lastAgentExit = undefined;
    this.lastKnownPid = child.pid ?? undefined;
    this.attachAgentLifecycleObservers(child);
    const startupStderr: string[] = [];

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.captureStartupStderr(startupStderr, chunk);
      if (!this.options.verbose) {
        return;
      }
      process.stderr.write(chunk);
    });

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = this.createTappedStream(
      createNdJsonMessageStream(this.options.agentCommand, input, output),
    );

    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          await this.handleSessionUpdate(params);
        },
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return this.handlePermissionRequest(params);
        },
        readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
          return this.handleReadTextFile(params);
        },
        writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
          return this.handleWriteTextFile(params);
        },
        createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
          return this.handleCreateTerminal(params);
        },
        terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
          return this.handleTerminalOutput(params);
        },
        waitForTerminalExit: async (
          params: WaitForTerminalExitRequest,
        ): Promise<WaitForTerminalExitResponse> => {
          return this.handleWaitForTerminalExit(params);
        },
        killTerminal: async (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
          return this.handleKillTerminal(params);
        },
        releaseTerminal: async (
          params: ReleaseTerminalRequest,
        ): Promise<ReleaseTerminalResponse> => {
          return this.handleReleaseTerminal(params);
        },
      }),
      stream,
    );
    connection.signal.addEventListener(
      "abort",
      () => {
        this.recordAgentExit("connection_close", child.exitCode ?? null, child.signalCode ?? null);
      },
      { once: true },
    );
    const startupFailure = this.createStartupFailureWatcher(child, startupStderr);

    try {
      const initResult = await Promise.race([
        (async () => {
          const initializePromise = connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: {
                readTextFile: true,
                writeTextFile: true,
              },
              terminal: true,
            },
            clientInfo: {
              name: "acpx",
              version: "0.1.0",
            },
          });
          const initialized = geminiAcp
            ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs())
            : await initializePromise;

          await this.authenticateIfRequired(connection, initialized.authMethods ?? []);
          return initialized;
        })(),
        startupFailure.promise,
      ]);
      startupFailure.dispose();

      this.connection = connection;
      this.agent = child;
      this.initResult = initResult;
      this.log(`initialized protocol version ${initResult.protocolVersion}`);
    } catch (error) {
      startupFailure.dispose();
      const normalizedError = await this.normalizeInitializeError(error, child, startupStderr);
      try {
        child.kill();
      } catch {
        // best effort
      }
      if (geminiAcp && error instanceof TimeoutError) {
        throw new GeminiAcpStartupTimeoutError(
          await buildGeminiAcpStartupTimeoutMessage(spawnCommand),
          {
            cause: error,
            retryable: true,
          },
        );
      }
      throw normalizedError;
    }
  }

  private createTappedStream(base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  }): {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  } {
    const onAcpMessage = () => this.eventHandlers.onAcpMessage;
    const onAcpOutputMessage = () => this.eventHandlers.onAcpOutputMessage;

    const shouldSuppressInboundReplaySessionUpdate = (message: AnyMessage): boolean => {
      return this.suppressReplaySessionUpdateMessages && isSessionUpdateNotification(message);
    };

    const readable = new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = base.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            if (!shouldSuppressInboundReplaySessionUpdate(value)) {
              onAcpOutputMessage()?.("inbound", value);
              onAcpMessage()?.("inbound", value);
            }
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });

    const writable = new WritableStream<AnyMessage>({
      async write(message) {
        onAcpOutputMessage()?.("outbound", message);
        onAcpMessage()?.("outbound", message);
        const writer = base.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
    });

    return { readable, writable };
  }

  async createSession(cwd = this.options.cwd): Promise<SessionCreateResult> {
    const connection = this.getConnection();
    const { command, args } = splitCommandLine(this.options.agentCommand);
    const claudeAcp = isClaudeAcpCommand(command, args);

    let result: Awaited<ReturnType<typeof connection.newSession>>;
    try {
      const createPromise = this.runConnectionRequest(() =>
        connection.newSession({
          cwd: asAbsoluteCwd(cwd),
          mcpServers: this.options.mcpServers ?? [],
          _meta: buildClaudeCodeOptionsMeta(this.options.sessionOptions),
        }),
      );
      result = claudeAcp
        ? await withTimeout(createPromise, resolveClaudeAcpSessionCreateTimeoutMs())
        : await createPromise;
    } catch (error) {
      if (claudeAcp && error instanceof TimeoutError) {
        throw new ClaudeAcpSessionCreateTimeoutError(buildClaudeAcpSessionCreateTimeoutMessage(), {
          cause: error,
          retryable: true,
        });
      }
      throw error;
    }

    this.loadedSessionId = result.sessionId;

    return {
      sessionId: result.sessionId,
      agentSessionId: extractRuntimeSessionId(result._meta),
      models: result.models ?? undefined,
    };
  }

  async loadSession(sessionId: string, cwd = this.options.cwd): Promise<SessionLoadResult> {
    this.getConnection();
    return await this.loadSessionWithOptions(sessionId, cwd, {});
  }

  async loadSessionWithOptions(
    sessionId: string,
    cwd = this.options.cwd,
    options: LoadSessionOptions = {},
  ): Promise<SessionLoadResult> {
    const connection = this.getConnection();
    const previousSuppression = this.suppressSessionUpdates;
    const previousReplaySuppression = this.suppressReplaySessionUpdateMessages;
    this.suppressSessionUpdates = previousSuppression || Boolean(options.suppressReplayUpdates);
    this.suppressReplaySessionUpdateMessages =
      previousReplaySuppression || Boolean(options.suppressReplayUpdates);

    let response: LoadSessionResponse | undefined;

    try {
      response = await this.runConnectionRequest(() =>
        connection.loadSession({
          sessionId,
          cwd: asAbsoluteCwd(cwd),
          mcpServers: this.options.mcpServers ?? [],
        }),
      );

      await this.waitForSessionUpdateDrain(
        options.replayIdleMs ?? REPLAY_IDLE_MS,
        options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS,
      );
    } finally {
      this.suppressSessionUpdates = previousSuppression;
      this.suppressReplaySessionUpdateMessages = previousReplaySuppression;
    }

    this.loadedSessionId = sessionId;

    return {
      agentSessionId: extractRuntimeSessionId(response?._meta),
      models: response?.models ?? undefined,
    };
  }

  async prompt(sessionId: string, prompt: PromptInput | string): Promise<PromptResponse> {
    const connection = this.getConnection();
    const restoreConsoleError = this.options.suppressSdkConsoleErrors
      ? installSdkConsoleErrorSuppression()
      : undefined;

    let promptPromise: Promise<PromptResponse>;
    try {
      promptPromise = this.runConnectionRequest(() =>
        connection.prompt({
          sessionId,
          prompt: typeof prompt === "string" ? textPrompt(prompt) : prompt,
        }),
      );
    } catch (error) {
      restoreConsoleError?.();
      throw error;
    }

    this.activePrompt = {
      sessionId,
      promise: promptPromise,
    };

    try {
      const response = await promptPromise;
      const permissionFailure = this.consumePromptPermissionFailure(sessionId);
      if (permissionFailure) {
        throw permissionFailure;
      }
      return response;
    } catch (error) {
      const permissionFailure = this.consumePromptPermissionFailure(sessionId);
      if (permissionFailure) {
        throw permissionFailure;
      }
      throw error;
    } finally {
      restoreConsoleError?.();
      if (this.activePrompt?.promise === promptPromise) {
        this.activePrompt = undefined;
      }
      this.cancellingSessionIds.delete(sessionId);
      this.promptPermissionFailures.delete(sessionId);
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const connection = this.getConnection();
    try {
      await this.runConnectionRequest(() =>
        connection.setSessionMode({
          sessionId,
          modeId,
        }),
      );
    } catch (error) {
      throw maybeWrapSessionControlError("session/set_mode", error, `for mode "${modeId}"`);
    }
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const connection = this.getConnection();
    try {
      return await this.runConnectionRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId,
          value,
        }),
      );
    } catch (error) {
      throw maybeWrapSessionControlError(
        "session/set_config_option",
        error,
        `for "${configId}"="${value}"`,
      );
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const connection = this.getConnection();
    try {
      await this.runConnectionRequest(() =>
        connection.unstable_setSessionModel({
          sessionId,
          modelId,
        }),
      );
    } catch (error) {
      const wrapped = maybeWrapSessionControlError(
        "session/set_model",
        error,
        `for model "${modelId}"`,
      );
      if (wrapped !== error) {
        throw wrapped;
      }
      const acp = extractAcpError(error);
      const summary = acp
        ? formatSessionControlAcpSummary(acp)
        : error instanceof Error
          ? error.message
          : String(error);
      if (error instanceof Error) {
        throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, {
          cause: error,
        });
      }
      throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, {
        cause: error,
      });
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    this.cancellingSessionIds.add(sessionId);
    await this.runConnectionRequest(() =>
      connection.cancel({
        sessionId,
      }),
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    await this.runConnectionRequest(() =>
      connection.closeSession({
        sessionId,
      }),
    );
    if (this.loadedSessionId === sessionId) {
      this.loadedSessionId = undefined;
    }
  }

  async requestCancelActivePrompt(): Promise<boolean> {
    const active = this.activePrompt;
    if (!active) {
      return false;
    }
    await this.cancel(active.sessionId);
    return true;
  }

  async cancelActivePrompt(waitMs = 2_500): Promise<PromptResponse | undefined> {
    const active = this.activePrompt;
    if (!active) {
      return undefined;
    }

    try {
      await this.cancel(active.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send session/cancel: ${message}`);
    }

    if (waitMs <= 0) {
      return undefined;
    }

    let timer: NodeJS.Timeout | number | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });

    try {
      return await Promise.race([
        active.promise.then(
          (response) => response,
          () => undefined,
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;

    await this.terminalManager.shutdown();

    const agent = this.agent;
    if (agent) {
      await this.terminateAgentProcess(agent);
    }
    if (this.pendingConnectionRequests.size > 0) {
      this.rejectPendingConnectionRequests(
        this.lastAgentExit
          ? new AgentDisconnectedError(
              this.lastAgentExit.reason,
              this.lastAgentExit.exitCode,
              this.lastAgentExit.signal,
              {
                outputAlreadyEmitted: Boolean(this.activePrompt),
              },
            )
          : new AgentDisconnectedError("connection_close", null, null, {
              outputAlreadyEmitted: Boolean(this.activePrompt),
            }),
      );
    }

    this.sessionUpdateChain = Promise.resolve();
    this.observedSessionUpdates = 0;
    this.processedSessionUpdates = 0;
    this.suppressSessionUpdates = false;
    this.suppressReplaySessionUpdateMessages = false;
    this.activePrompt = undefined;
    this.cancellingSessionIds.clear();
    this.promptPermissionFailures.clear();
    this.loadedSessionId = undefined;
    this.initResult = undefined;
    this.connection = undefined;
    this.agent = undefined;
  }

  private async terminateAgentProcess(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): Promise<void> {
    const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);

    // Closing stdin is the most graceful shutdown signal for stdio-based ACP agents.
    if (!child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        // best effort
      }
    }

    let exited = await waitForChildExit(child, stdinCloseGraceMs);
    if (!exited && isChildProcessRunning(child)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      exited = await waitForChildExit(child, AGENT_CLOSE_TERM_GRACE_MS);
    }

    if (!exited && isChildProcessRunning(child)) {
      this.log(`agent did not exit after ${AGENT_CLOSE_TERM_GRACE_MS}ms; forcing SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
      exited = await waitForChildExit(child, AGENT_CLOSE_KILL_GRACE_MS);
    }

    // Ensure stdio handles don't keep this process alive after close() returns.
    this.detachAgentHandles(child, !exited);
  }

  private detachAgentHandles(agent: ChildProcess, unref: boolean): void {
    const stdin = agent.stdin;
    const stdout = agent.stdout;
    const stderr = agent.stderr;

    stdin?.destroy();
    stdout?.destroy();
    stderr?.destroy();

    if (unref) {
      try {
        agent.unref();
      } catch {
        // best effort
      }
    }
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP client not started");
    }
    return this.connection;
  }

  private log(message: string): void {
    if (!this.options.verbose) {
      return;
    }
    process.stderr.write(`[acpx] ${message}\n`);
  }

  private captureStartupStderr(target: string[], chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) {
      return;
    }
    target.push(text);
    const overflow = target.join("").length - STARTUP_STDERR_MAX_CHARS;
    if (overflow <= 0) {
      return;
    }
    const joined = target.join("");
    target.splice(0, target.length, joined.slice(-STARTUP_STDERR_MAX_CHARS));
  }

  private summarizeStartupStderr(target: string[]): string | undefined {
    const joined = target.join("").trim();
    if (!joined) {
      return undefined;
    }
    const collapsed = joined.replace(/\s+/gu, " ").trim();
    return collapsed.slice(0, STARTUP_STDERR_MAX_CHARS);
  }

  private createStartupFailureWatcher(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    startupStderr: string[],
  ): {
    promise: Promise<never>;
    dispose: () => void;
  } {
    let settled = false;
    let rejectPromise: (error: unknown) => void;

    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        rejectPromise(error);
      }
    };

    const createError = (params?: {
      cause?: unknown;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    }) =>
      new AgentStartupError({
        agentCommand: this.options.agentCommand,
        exitCode: params?.exitCode ?? child.exitCode ?? null,
        signal: params?.signal ?? child.signalCode ?? null,
        stderrSummary: this.summarizeStartupStderr(startupStderr),
        cause: params?.cause,
      });

    const onError = (error: Error) => {
      finish(createError({ cause: error }));
    };

    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      finish(createError({ exitCode, signal }));
    };

    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      finish(createError({ exitCode, signal }));
    };

    const promise = new Promise<never>((_resolve, reject) => {
      rejectPromise = reject;
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
    });

    return {
      promise,
      dispose: () => finish(),
    };
  }

  private async normalizeInitializeError(
    error: unknown,
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    startupStderr: string[],
  ): Promise<unknown> {
    if (error instanceof AgentStartupError) {
      return error;
    }

    const connectionClosedDuringInitialize =
      error instanceof Error && /acp connection closed/i.test(error.message);
    if (!connectionClosedDuringInitialize) {
      return error;
    }

    await waitForChildExit(child, 100);
    return new AgentStartupError({
      agentCommand: this.options.agentCommand,
      exitCode: child.exitCode ?? null,
      signal: child.signalCode ?? null,
      stderrSummary: this.summarizeStartupStderr(startupStderr),
      cause: error,
    });
  }

  private selectAuthMethod(methods: AuthMethod[]): AuthSelection | undefined {
    for (const method of methods) {
      const envCredential = readEnvCredential(method.id);
      if (envCredential) {
        return {
          methodId: method.id,
          credential: envCredential,
          source: "env",
        };
      }

      const configCredential = resolveConfiguredAuthCredential(
        method.id,
        this.options.authCredentials,
      );
      if (typeof configCredential === "string" && configCredential.trim().length > 0) {
        return {
          methodId: method.id,
          credential: configCredential,
          source: "config",
        };
      }
    }

    return undefined;
  }

  private async authenticateIfRequired(
    connection: ClientSideConnection,
    methods: AuthMethod[],
  ): Promise<void> {
    if (methods.length === 0) {
      return;
    }

    const selected = this.selectAuthMethod(methods);
    if (!selected) {
      if (this.options.authPolicy === "fail") {
        throw new AuthPolicyError(
          `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found`,
        );
      }

      this.log(
        `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`,
      );
      return;
    }

    await connection.authenticate({
      methodId: selected.methodId,
    });

    this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.cancellingSessionIds.has(params.sessionId)) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    let response: RequestPermissionResponse;
    try {
      response = await resolvePermissionRequest(
        params,
        this.options.permissionMode,
        this.options.nonInteractivePermissions ?? "deny",
      );
    } catch (error) {
      if (error instanceof PermissionPromptUnavailableError) {
        this.notePromptPermissionFailure(params.sessionId, error);
        this.recordPermissionDecision("cancelled");
        return {
          outcome: {
            outcome: "cancelled",
          },
        };
      }
      throw error;
    }

    const decision = classifyPermissionDecision(params, response);
    this.recordPermissionDecision(decision);

    return response;
  }

  private attachAgentLifecycleObservers(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): void {
    child.once("exit", (exitCode, signal) => {
      this.recordAgentExit("process_exit", exitCode, signal);
    });

    child.once("close", (exitCode, signal) => {
      this.recordAgentExit("process_close", exitCode, signal);
    });

    child.stdout.once("close", () => {
      this.recordAgentExit("pipe_close", child.exitCode ?? null, child.signalCode ?? null);
    });
  }

  private recordAgentExit(
    reason: AgentDisconnectReason,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.lastAgentExit) {
      return;
    }

    this.lastAgentExit = {
      exitCode,
      signal,
      exitedAt: isoNow(),
      reason,
      unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt),
    };
    this.rejectPendingConnectionRequests(
      new AgentDisconnectedError(reason, exitCode, signal, {
        outputAlreadyEmitted: Boolean(this.activePrompt),
      }),
    );
  }

  private notePromptPermissionFailure(
    sessionId: string,
    error: PermissionPromptUnavailableError,
  ): void {
    if (!this.promptPermissionFailures.has(sessionId)) {
      this.promptPermissionFailures.set(sessionId, error);
    }
  }

  private consumePromptPermissionFailure(
    sessionId: string,
  ): PermissionPromptUnavailableError | undefined {
    const error = this.promptPermissionFailures.get(sessionId);
    if (error) {
      this.promptPermissionFailures.delete(sessionId);
    }
    return error;
  }

  private async runConnectionRequest<T>(run: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const pending: PendingConnectionRequest = {
        settled: false,
        reject,
      };

      const finish = (cb: () => void) => {
        if (pending.settled) {
          return;
        }
        pending.settled = true;
        this.pendingConnectionRequests.delete(pending);
        cb();
      };

      this.pendingConnectionRequests.add(pending);
      void Promise.resolve()
        .then(run)
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
    });
  }

  private rejectPendingConnectionRequests(error: unknown): void {
    for (const pending of this.pendingConnectionRequests) {
      if (pending.settled) {
        this.pendingConnectionRequests.delete(pending);
        continue;
      }
      pending.settled = true;
      this.pendingConnectionRequests.delete(pending);
      pending.reject(error);
    }
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      return await this.filesystem.readTextFile(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      return await this.filesystem.writeTextFile(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    try {
      return await this.terminalManager.createTerminal(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return await this.terminalManager.terminalOutput(params);
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return await this.terminalManager.waitForTerminalExit(params);
  }

  private async handleKillTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return await this.terminalManager.killTerminal(params);
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return await this.terminalManager.releaseTerminal(params);
  }

  private recordPermissionDecision(decision: "approved" | "denied" | "cancelled"): void {
    this.permissionStats.requested += 1;
    if (decision === "approved") {
      this.permissionStats.approved += 1;
      return;
    }
    if (decision === "denied") {
      this.permissionStats.denied += 1;
      return;
    }
    this.permissionStats.cancelled += 1;
  }

  private recordPermissionError(sessionId: string, error: unknown): void {
    if (error instanceof PermissionPromptUnavailableError) {
      this.notePromptPermissionFailure(sessionId, error);
      this.recordPermissionDecision("cancelled");
      return;
    }
    if (error instanceof PermissionDeniedError) {
      this.recordPermissionDecision("denied");
    }
  }

  private async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const sequence = ++this.observedSessionUpdates;
    this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
      try {
        if (!this.suppressSessionUpdates) {
          this.eventHandlers.onSessionUpdate?.(notification);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`session update handler failed: ${message}`);
      } finally {
        this.processedSessionUpdates = sequence;
      }
    });

    await this.sessionUpdateChain;
  }

  private async waitForSessionUpdateDrain(idleMs: number, timeoutMs: number): Promise<void> {
    const normalizedIdleMs = Math.max(0, idleMs);
    const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
    const deadline = Date.now() + normalizedTimeoutMs;
    let lastObserved = this.observedSessionUpdates;
    let idleSince = Date.now();

    while (Date.now() <= deadline) {
      const observed = this.observedSessionUpdates;
      if (observed !== lastObserved) {
        lastObserved = observed;
        idleSince = Date.now();
      }

      if (
        this.processedSessionUpdates === this.observedSessionUpdates &&
        Date.now() - idleSince >= normalizedIdleMs
      ) {
        await this.sessionUpdateChain;
        if (this.processedSessionUpdates === this.observedSessionUpdates) {
          return;
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
      });
    }

    throw new Error(`Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`);
  }

  async waitForSessionUpdatesIdle(options?: {
    idleMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    await this.waitForSessionUpdateDrain(options?.idleMs ?? 0, options?.timeoutMs ?? 0);
  }
}
