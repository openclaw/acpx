#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  type CloseSessionRequest,
  type CloseSessionResponse,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type ContentBlock,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionId,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionInfo,
  type SessionModelState,
} from "@agentclientprotocol/sdk";

type ParsedCommand = {
  command: string;
  args: string[];
};

type MockAgentOptions = {
  hangOnNewSession: boolean;
  newSessionMeta?: Record<string, string>;
  loadSessionMeta?: Record<string, string>;
  resumeSessionMeta?: Record<string, string>;
  supportsLoadSession: boolean;
  supportsResumeSession: boolean;
  supportsCloseSession: boolean;
  supportsListSessions: boolean;
  listPageSize: number;
  closeSessionMarker?: string;
  loadSessionNotFound: boolean;
  resumeSessionNotFound: boolean;
  loadSessionFailsOnEmpty: boolean;
  setSessionModeFails: boolean;
  setSessionModeInvalidParams: boolean;
  setSessionConfigInvalidParams: boolean;
  setSessionModelFails: boolean;
  setSessionModelInvalidParams: boolean;
  advertiseConfigOptions: boolean;
  advertiseModels: boolean;
  replayLoadSessionUpdates: boolean;
  loadReplayText: string;
  ignoreSigterm: boolean;
};

type SessionState = {
  pendingPrompt?: AbortController;
  hasCompletedPrompt: boolean;
  modeId: string;
  configValues: Record<string, string | boolean>;
  transientPromptAttempts: Record<string, number>;
  modelId: string;
};

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const fromMessage = (error as { message?: unknown }).message;
    if (typeof fromMessage === "string" && fromMessage.trim().length > 0) {
      return fromMessage;
    }

    const fromNested = (
      error as {
        error?: {
          message?: unknown;
        };
      }
    ).error?.message;
    if (typeof fromNested === "string" && fromNested.trim().length > 0) {
      return fromNested;
    }

    try {
      return JSON.stringify(error);
    } catch {
      // ignore serialization failure and fall through
    }
  }
  return String(error);
}

function getPromptText(prompt: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }

  return parts.join("").trim();
}

function describePromptBlocks(prompt: ContentBlock[]): string {
  return JSON.stringify(
    prompt.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "image":
          return { type: "image", mimeType: block.mimeType, bytes: block.data.length };
        case "audio":
          return { type: "audio", mimeType: block.mimeType, bytes: block.data.length };
        case "resource_link":
          return { type: "resource_link", uri: block.uri };
        case "resource":
          return {
            type: "resource",
            uri: block.resource.uri,
            hasText: "text" in block.resource && typeof block.resource.text === "string",
          };
        default:
          return { type: (block as { type: string }).type };
      }
    }),
  );
}

function splitCommandLine(value: string): ParsedCommand {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Invalid command line: ${value}`);
  }

  if (current.length > 0) {
    parts.push(current);
  }

  if (parts.length === 0) {
    throw new Error("Command is required");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

async function sleepWithCancel(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  assertNotCancelled(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      run();
    };

    const onAbort = () => {
      finish(() => reject(new CancelledError()));
    };

    const timer = setTimeout(() => {
      finish(() => resolve());
    }, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        onAbort();
      },
      { once: true },
    );
  });
}

function parseOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value.trim();
}

function parsePositiveIntegerOption(args: string[], index: number, flag: string): number {
  const value = parseOptionValue(args, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

type MetaFlagTarget = "newSessionMeta" | "loadSessionMeta" | "resumeSessionMeta";

type MetaFlagSpec = {
  target: MetaFlagTarget;
  key: string;
  supportsLoadSession?: boolean;
  supportsResumeSession?: boolean;
};

const META_FLAG_SPECS: Record<string, MetaFlagSpec> = {
  "--runtime-session-id": {
    target: "newSessionMeta",
    key: "agentSessionId",
  },
  "--provider-session-id": {
    target: "newSessionMeta",
    key: "agentSessionId",
  },
  "--codex-session-id": {
    target: "newSessionMeta",
    key: "agentSessionId",
  },
  "--claude-session-id": {
    target: "newSessionMeta",
    key: "agentSessionId",
  },
  "--load-runtime-session-id": {
    target: "loadSessionMeta",
    key: "agentSessionId",
    supportsLoadSession: true,
  },
  "--load-provider-session-id": {
    target: "loadSessionMeta",
    key: "agentSessionId",
    supportsLoadSession: true,
  },
  "--load-codex-session-id": {
    target: "loadSessionMeta",
    key: "agentSessionId",
    supportsLoadSession: true,
  },
  "--load-claude-session-id": {
    target: "loadSessionMeta",
    key: "agentSessionId",
    supportsLoadSession: true,
  },
  "--resume-runtime-session-id": {
    target: "resumeSessionMeta",
    key: "agentSessionId",
    supportsResumeSession: true,
  },
  "--resume-provider-session-id": {
    target: "resumeSessionMeta",
    key: "agentSessionId",
    supportsResumeSession: true,
  },
  "--resume-codex-session-id": {
    target: "resumeSessionMeta",
    key: "agentSessionId",
    supportsResumeSession: true,
  },
  "--resume-claude-session-id": {
    target: "resumeSessionMeta",
    key: "agentSessionId",
    supportsResumeSession: true,
  },
};

function parseMockAgentOptions(argv: string[]): MockAgentOptions {
  const newSessionMeta: Record<string, string> = {};
  const loadSessionMeta: Record<string, string> = {};
  const resumeSessionMeta: Record<string, string> = {};
  let supportsLoadSession = false;
  let supportsResumeSession = false;
  let supportsCloseSession = false;
  let supportsListSessions = false;
  let listPageSize = 100;
  let closeSessionMarker: string | undefined;
  let loadSessionNotFound = false;
  let resumeSessionNotFound = false;
  let loadSessionFailsOnEmpty = false;
  let setSessionModeFails = false;
  let setSessionModeInvalidParams = false;
  let setSessionConfigInvalidParams = false;
  let setSessionModelFails = false;
  let setSessionModelInvalidParams = false;
  let advertiseConfigOptions = false;
  let advertiseModels = false;
  let replayLoadSessionUpdates = false;
  let loadReplayText = "replayed load session update";
  let ignoreSigterm = false;
  let hangOnNewSession = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--supports-load-session") {
      supportsLoadSession = true;
      continue;
    }

    if (token === "--supports-resume-session") {
      supportsResumeSession = true;
      continue;
    }

    if (token === "--load-session-fails-on-empty") {
      supportsLoadSession = true;
      loadSessionFailsOnEmpty = true;
      continue;
    }

    if (token === "--load-session-not-found") {
      supportsLoadSession = true;
      loadSessionNotFound = true;
      continue;
    }

    if (token === "--resume-session-not-found") {
      supportsResumeSession = true;
      resumeSessionNotFound = true;
      continue;
    }

    if (token === "--set-session-mode-fails") {
      setSessionModeFails = true;
      continue;
    }

    if (token === "--set-session-mode-invalid-params") {
      setSessionModeInvalidParams = true;
      continue;
    }

    if (token === "--set-session-config-invalid-params") {
      setSessionConfigInvalidParams = true;
      continue;
    }

    if (token === "--set-session-model-fails") {
      setSessionModelFails = true;
      advertiseModels = true;
      continue;
    }

    if (token === "--set-session-model-invalid-params") {
      setSessionModelInvalidParams = true;
      advertiseModels = true;
      continue;
    }

    if (token === "--advertise-models") {
      advertiseModels = true;
      continue;
    }

    if (token === "--advertise-config-options") {
      advertiseConfigOptions = true;
      continue;
    }

    if (token === "--replay-load-session-updates") {
      supportsLoadSession = true;
      replayLoadSessionUpdates = true;
      continue;
    }

    if (token === "--supports-close-session") {
      supportsCloseSession = true;
      continue;
    }

    if (token === "--supports-list-sessions") {
      supportsListSessions = true;
      continue;
    }

    if (token === "--list-page-size") {
      supportsListSessions = true;
      listPageSize = parsePositiveIntegerOption(argv, index + 1, token);
      index += 1;
      continue;
    }

    if (token === "--close-session-marker") {
      supportsCloseSession = true;
      closeSessionMarker = parseOptionValue(argv, index + 1, token);
      index += 1;
      continue;
    }

    if (token === "--ignore-sigterm") {
      ignoreSigterm = true;
      continue;
    }

    if (token === "--hang-on-new-session") {
      hangOnNewSession = true;
      continue;
    }

    if (token === "--claude-agent-acp") {
      continue;
    }

    if (token === "--load-replay-text") {
      supportsLoadSession = true;
      replayLoadSessionUpdates = true;
      loadReplayText = parseOptionValue(argv, index + 1, token);
      index += 1;
      continue;
    }

    const metaFlag = META_FLAG_SPECS[token];
    if (metaFlag) {
      const value = parseOptionValue(argv, index + 1, token);
      if (metaFlag.target === "newSessionMeta") {
        newSessionMeta[metaFlag.key] = value;
      } else if (metaFlag.target === "loadSessionMeta") {
        loadSessionMeta[metaFlag.key] = value;
      } else {
        resumeSessionMeta[metaFlag.key] = value;
      }
      if (metaFlag.supportsLoadSession) {
        supportsLoadSession = true;
      }
      if (metaFlag.supportsResumeSession) {
        supportsResumeSession = true;
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown mock-agent option: ${token}`);
  }

  return {
    hangOnNewSession,
    newSessionMeta: Object.keys(newSessionMeta).length > 0 ? { ...newSessionMeta } : undefined,
    loadSessionMeta: Object.keys(loadSessionMeta).length > 0 ? { ...loadSessionMeta } : undefined,
    resumeSessionMeta:
      Object.keys(resumeSessionMeta).length > 0 ? { ...resumeSessionMeta } : undefined,
    supportsLoadSession,
    supportsResumeSession,
    supportsCloseSession,
    supportsListSessions,
    listPageSize,
    closeSessionMarker,
    loadSessionNotFound,
    resumeSessionNotFound,
    loadSessionFailsOnEmpty,
    setSessionModeFails,
    setSessionModeInvalidParams,
    setSessionConfigInvalidParams,
    setSessionModelFails,
    setSessionModelInvalidParams,
    advertiseConfigOptions,
    advertiseModels,
    replayLoadSessionUpdates,
    loadReplayText,
    ignoreSigterm,
  };
}

const DEFAULT_MODEL_ID = "default-model";
const AVAILABLE_MODELS = ["default-model", "fast-model", "smart-model"];

function buildModelsState(currentModelId: string): SessionModelState {
  return {
    currentModelId,
    availableModels: AVAILABLE_MODELS.map((id) => ({ modelId: id, name: id })),
  };
}

function createSessionState(hasCompletedPrompt = false): SessionState {
  return {
    hasCompletedPrompt,
    modeId: "auto",
    modelId: DEFAULT_MODEL_ID,
    configValues: {
      reasoning_effort: "medium",
    },
    transientPromptAttempts: {},
  };
}

function buildMockSessionInventory(cwd: string): SessionInfo[] {
  return [
    {
      sessionId: "mock-session-alpha",
      cwd,
      title: "Alpha task",
      updatedAt: "2026-05-21T00:00:00.000Z",
      _meta: {
        source: "mock-agent",
        messageCount: 2,
      },
    },
    {
      sessionId: "mock-session-beta",
      cwd: path.join(cwd, "other"),
      title: "Beta task",
      updatedAt: "2026-05-20T00:00:00.000Z",
      _meta: {
        source: "mock-agent",
        messageCount: 4,
      },
    },
    {
      sessionId: "mock-session-gamma",
      cwd,
      updatedAt: "2026-05-19T00:00:00.000Z",
      _meta: {
        source: "mock-agent",
        messageCount: 6,
      },
    },
  ];
}

function parseListCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }

  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw RequestError.invalidParams({ cursor }, "Invalid list cursor");
  }
  return parsed;
}

function buildConfigOptions(state: SessionState): SetSessionConfigOptionResponse["configOptions"] {
  const reasoningEffort =
    typeof state.configValues.reasoning_effort === "string"
      ? state.configValues.reasoning_effort
      : "medium";

  return [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: state.modeId,
      options: [
        { value: "read-only", name: "Read Only" },
        { value: "auto", name: "Default" },
        { value: "full-access", name: "Full Access" },
        { value: "plan", name: "Plan" },
        { value: "default", name: "Default" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.modelId,
      options: [
        { value: "default", name: "Default" },
        { value: "gpt-5.4", name: "gpt-5.4" },
        { value: "gpt-5.2", name: "gpt-5.2" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: reasoningEffort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Xhigh" },
      ],
    },
  ];
}

class MockAgent implements Agent {
  private readonly connection: AgentConnection;
  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly options: MockAgentOptions;

  constructor(connection: AgentConnection, options: MockAgentOptions) {
    this.connection = connection;
    this.options = options;
  }

  async initialize(): Promise<InitializeResponse> {
    const sessionCapabilities = {
      ...(this.options.supportsCloseSession ? { close: {} } : {}),
      ...(this.options.supportsListSessions ? { list: {} } : {}),
      ...(this.options.supportsResumeSession ? { resume: {} } : {}),
    };
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {
        ...(this.options.supportsLoadSession ? { loadSession: true } : {}),
        ...(Object.keys(sessionCapabilities).length > 0 ? { sessionCapabilities } : {}),
      },
    };
  }

  async authenticate(): Promise<void> {
    return;
  }

  async newSession(): Promise<NewSessionResponse> {
    if (this.options.hangOnNewSession) {
      return await new Promise<NewSessionResponse>(() => {});
    }

    const sessionId = randomUUID();
    this.sessions.set(sessionId, createSessionState(false));

    const response: NewSessionResponse = { sessionId };

    if (this.options.newSessionMeta) {
      response._meta = { ...this.options.newSessionMeta };
    }

    if (this.options.advertiseModels) {
      response.models = buildModelsState(DEFAULT_MODEL_ID);
    }
    if (this.options.advertiseConfigOptions) {
      response.configOptions = buildConfigOptions(
        this.sessions.get(sessionId) ?? createSessionState(false),
      );
    }

    return response;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!this.options.supportsLoadSession) {
      throw new Error("loadSession is not supported");
    }

    if (this.options.loadSessionNotFound) {
      throw RequestError.resourceNotFound(params.sessionId);
    }

    const existing = this.sessions.get(params.sessionId);
    if (this.options.loadSessionFailsOnEmpty && (!existing || !existing.hasCompletedPrompt)) {
      const error = new Error("Internal error") as Error & {
        code: number;
        data: {
          details: string;
        };
      };
      error.code = -32603;
      error.data = {
        details: "Query closed before response received",
      };
      throw error;
    }

    this.sessions.set(params.sessionId, existing ?? createSessionState(false));

    if (this.options.replayLoadSessionUpdates) {
      await this.sendAssistantMessage(params.sessionId, this.options.loadReplayText);
    }

    return this.buildSessionReconnectResponse(params.sessionId, this.options.loadSessionMeta);
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!this.options.supportsResumeSession) {
      throw new Error("resumeSession is not supported");
    }

    if (this.options.resumeSessionNotFound) {
      throw RequestError.resourceNotFound(params.sessionId);
    }

    const existing = this.sessions.get(params.sessionId);
    this.sessions.set(params.sessionId, existing ?? createSessionState(false));

    return this.buildSessionReconnectResponse(params.sessionId, this.options.resumeSessionMeta);
  }

  private buildSessionReconnectResponse(
    sessionId: SessionId,
    responseMeta: Record<string, string> | undefined,
  ): LoadSessionResponse {
    const response: LoadSessionResponse = {};

    if (responseMeta) {
      response._meta = { ...responseMeta };
    }

    if (this.options.advertiseModels) {
      const session = this.sessions.get(sessionId);
      response.models = buildModelsState(session?.modelId ?? DEFAULT_MODEL_ID);
    }
    if (this.options.advertiseConfigOptions) {
      response.configOptions = buildConfigOptions(
        this.sessions.get(sessionId) ?? createSessionState(false),
      );
    }

    return response;
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.sessions.delete(params.sessionId);
    if (this.options.closeSessionMarker) {
      writeFileSync(this.options.closeSessionMarker, `${params.sessionId}\n`, { flag: "a" });
    }
    return {};
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!this.options.supportsListSessions) {
      throw RequestError.methodNotFound("session/list");
    }

    const start = parseListCursor(params.cursor);
    const cwd = params.cwd ?? undefined;
    const sessions = buildMockSessionInventory(cwd ?? process.cwd()).filter((session) =>
      cwd ? session.cwd === cwd : true,
    );
    const pageEnd = start + this.options.listPageSize;
    return {
      _meta: {
        source: "mock-agent-list",
      },
      sessions: sessions.slice(start, pageEnd),
      nextCursor: pageEnd < sessions.length ? String(pageEnd) : undefined,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.internalError(
        { sessionId: params.sessionId },
        `Unknown session: ${params.sessionId}`,
      );
    }

    session.pendingPrompt?.abort();
    const promptAbort = new AbortController();
    session.pendingPrompt = promptAbort;
    const text = getPromptText(params.prompt);

    if (text === "partial-retryable-error") {
      try {
        await this.sendAssistantMessage(params.sessionId, "partial update");
        const error = new Error("Internal error") as Error & {
          code: number;
          data: {
            details: string;
          };
        };
        error.code = -32603;
        error.data = {
          details: "transient failure after partial output",
        };
        throw error;
      } finally {
        if (session.pendingPrompt === promptAbort) {
          session.pendingPrompt = undefined;
        }
      }
    }

    if (text === "retryable-error-once") {
      const attempts = session.transientPromptAttempts[text] ?? 0;
      session.transientPromptAttempts[text] = attempts + 1;
      if (attempts === 0) {
        try {
          const error = new Error("Internal error") as Error & {
            code: number;
            data: {
              details: string;
            };
          };
          error.code = -32603;
          error.data = {
            details: "transient failure before output",
          };
          throw error;
        } finally {
          if (session.pendingPrompt === promptAbort) {
            session.pendingPrompt = undefined;
          }
        }
      }
    }

    try {
      const response =
        text === "inspect-prompt"
          ? describePromptBlocks(params.prompt)
          : await this.handlePrompt(params.sessionId, text, promptAbort.signal);
      session.hasCompletedPrompt = true;
      await this.sendAssistantMessage(params.sessionId, response);
      return { stopReason: "end_turn" };
    } catch (error) {
      if (promptAbort.signal.aborted || error instanceof CancelledError) {
        return { stopReason: "cancelled" };
      }

      await this.sendAssistantMessage(params.sessionId, `error: ${toErrorMessage(error)}`);
      return { stopReason: "end_turn" };
    } finally {
      if (session.pendingPrompt === promptAbort) {
        session.pendingPrompt = undefined;
      }
    }
  }

  async cancel(params: { sessionId: SessionId }): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.ensureSession(params.sessionId);
    if (this.options.setSessionModeInvalidParams) {
      const error = new Error("Invalid params") as Error & {
        code: number;
        data: {
          method: string;
          modeId: string;
        };
      };
      error.code = -32602;
      error.data = {
        method: "session/set_mode",
        modeId: params.modeId,
      };
      throw error;
    }
    if (this.options.setSessionModeFails) {
      throw new Error("setSessionMode failed");
    }
    session.modeId = params.modeId;
    return {};
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const session = this.ensureSession(params.sessionId);
    if (this.options.setSessionModelInvalidParams) {
      const error = new Error("Invalid params") as Error & {
        code: number;
        data: {
          method: string;
          modelId: string;
        };
      };
      error.code = -32602;
      error.data = {
        method: "session/set_model",
        modelId: params.modelId,
      };
      throw error;
    }
    if (this.options.setSessionModelFails) {
      throw new Error("setSessionModel failed");
    }
    session.modelId = params.modelId;
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.ensureSession(params.sessionId);
    if (this.options.setSessionConfigInvalidParams) {
      const error = new Error("Invalid params") as Error & {
        code: number;
        data: {
          method: string;
          configId: string;
          value: string | boolean;
        };
      };
      error.code = -32602;
      error.data = {
        method: "session/set_config_option",
        configId: params.configId,
        value: params.value,
      };
      throw error;
    }
    if (params.configId === "mode" && typeof params.value === "string") {
      session.modeId = params.value;
    } else {
      session.configValues[params.configId] = params.value;
    }

    return {
      configOptions: buildConfigOptions(session),
    };
  }

  private async sendAssistantMessage(sessionId: SessionId, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });
  }

  private emitLateToolCall(sessionId: SessionId, delayMs: number, text: string): void {
    const scheduledDelay = Math.max(0, Math.round(delayMs));
    const toolCallId = randomUUID();

    setTimeout(() => {
      void (async () => {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "LateTool",
            kind: "other",
            status: "in_progress",
            rawInput: {
              text,
            },
          },
        });

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });

        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "LateTool",
            kind: "other",
            status: "completed",
            rawInput: {
              text,
            },
            rawOutput: {
              echoedText: text,
            },
          },
        });
      })().catch((error: unknown) => {
        process.stderr.write(`late-tool failed: ${toErrorMessage(error)}\n`);
      });
    }, scheduledDelay);
  }

  private ensureSession(sessionId: SessionId): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = createSessionState(false);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private async handlePrompt(
    sessionId: SessionId,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    assertNotCancelled(signal);

    if (text.startsWith("echo ")) {
      return text.slice("echo ".length);
    }
    if (text === "echo") {
      return "";
    }
    if (text === "retryable-error-once") {
      return "recovered after retry";
    }

    if (text.startsWith("late-tool ")) {
      const rest = text.slice("late-tool ".length).trim();
      const firstSpace = rest.search(/\s/);

      if (firstSpace <= 0) {
        throw new Error("Usage: late-tool <milliseconds> <text>");
      }

      const rawMs = rest.slice(0, firstSpace).trim();
      const lateText = rest.slice(firstSpace + 1).trim();
      const delayMs = Number(rawMs);

      if (!Number.isFinite(delayMs) || delayMs < 0 || lateText.length === 0) {
        throw new Error("Usage: late-tool <milliseconds> <text>");
      }

      await this.sendAssistantMessage(sessionId, "writing now");
      this.emitLateToolCall(sessionId, delayMs, lateText);
      return `late-tool scheduled: ${lateText}`;
    }

    if (text.startsWith("read ")) {
      const filePath = text.slice("read ".length).trim();
      if (!filePath) {
        throw new Error("Usage: read <path>");
      }

      const readResult = await this.connection.readTextFile({
        sessionId,
        path: filePath,
      });
      return readResult.content;
    }

    if (text.startsWith("read-tool ")) {
      const filePath = text.slice("read-tool ".length).trim();
      if (!filePath) {
        throw new Error("Usage: read-tool <path>");
      }

      const toolCallId = randomUUID();
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Read",
          kind: "read",
          status: "in_progress",
          rawInput: {
            filePath,
          },
        },
      });

      const readResult = await this.connection.readTextFile({
        sessionId,
        path: filePath,
      });

      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: "Read",
          kind: "read",
          status: "completed",
          rawInput: {
            filePath,
          },
          rawOutput: {
            content: readResult.content,
          },
        },
      });

      return `read complete: ${filePath}`;
    }

    if (text.startsWith("write ")) {
      const rest = text.slice("write ".length).trim();
      const firstSpace = rest.search(/\s/);

      if (firstSpace <= 0) {
        throw new Error("Usage: write <path> <content>");
      }

      const filePath = rest.slice(0, firstSpace).trim();
      const content = rest.slice(firstSpace + 1);

      await this.connection.writeTextFile({
        sessionId,
        path: filePath,
        content,
      });

      return `wrote ${filePath}`;
    }

    if (text.startsWith("permission ")) {
      const rest = text.slice("permission ".length).trim();
      const firstSpace = rest.search(/\s/);

      if (firstSpace <= 0) {
        throw new Error("Usage: permission <kind> <title>");
      }

      const rawKind = rest.slice(0, firstSpace).trim();
      const title = rest.slice(firstSpace + 1).trim();
      const toolCallId = randomUUID();
      const response = await this.connection.requestPermission({
        sessionId,
        toolCall: {
          toolCallId,
          title,
          kind: rawKind as RequestPermissionRequest["toolCall"]["kind"],
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });

      if (response.outcome.outcome === "selected") {
        return `permission selected:${response.outcome.optionId}`;
      }
      return "permission cancelled";
    }

    if (text.startsWith("terminal ")) {
      const rawCommand = text.slice("terminal ".length).trim();
      if (!rawCommand) {
        throw new Error("Usage: terminal <command>");
      }

      return await this.runTerminalCommand(sessionId, rawCommand, signal);
    }

    if (text.startsWith("sleep ")) {
      const rawMs = text.slice("sleep ".length).trim();
      if (!rawMs) {
        throw new Error("Usage: sleep <milliseconds>");
      }

      const ms = Number(rawMs);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("Usage: sleep <milliseconds>");
      }

      await sleepWithCancel(Math.round(ms), signal);
      return `slept ${Math.round(ms)}ms`;
    }

    if (text.startsWith("stream-sleep ")) {
      const rest = text.slice("stream-sleep ".length).trim();
      const firstSpace = rest.search(/\s/);
      if (firstSpace <= 0) {
        throw new Error("Usage: stream-sleep <milliseconds> <text>");
      }

      const rawMs = rest.slice(0, firstSpace).trim();
      const liveText = rest.slice(firstSpace + 1).trim();
      const ms = Number(rawMs);
      if (!Number.isFinite(ms) || ms < 0 || liveText.length === 0) {
        throw new Error("Usage: stream-sleep <milliseconds> <text>");
      }

      await this.sendAssistantMessage(sessionId, liveText);
      await sleepWithCancel(Math.round(ms), signal);
      return `stream-sleep done: ${liveText}`;
    }

    if (text.startsWith("disconnect ")) {
      const rawMs = text.slice("disconnect ".length).trim();
      if (!rawMs) {
        throw new Error("Usage: disconnect <milliseconds>");
      }

      const ms = Number(rawMs);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("Usage: disconnect <milliseconds>");
      }

      await sleepWithCancel(Math.round(ms), signal);
      process.exit(91);
    }

    if (text.startsWith("kill-terminal ")) {
      const rawCommand = text.slice("kill-terminal ".length).trim();
      if (!rawCommand) {
        throw new Error("Usage: kill-terminal <command>");
      }

      return await this.runKillTerminalCommand(sessionId, rawCommand, signal);
    }

    return `unrecognized prompt: ${text}`;
  }

  private async runTerminalCommand(
    sessionId: SessionId,
    rawCommand: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { command, args } = splitCommandLine(rawCommand);
    const terminal = await this.connection.createTerminal({
      sessionId,
      command,
      args,
    });

    try {
      let outputSnapshot = await terminal.currentOutput();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assertNotCancelled(signal);
        if (outputSnapshot.exitStatus) {
          break;
        }

        await sleepWithCancel(40, signal);
        outputSnapshot = await terminal.currentOutput();
      }

      const exitStatus = await terminal.waitForExit();
      const finalOutput = await terminal.currentOutput();

      return [
        finalOutput.output.trimEnd(),
        `exit: ${exitStatus.exitCode ?? "null"} signal: ${exitStatus.signal ?? "null"}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    } finally {
      await terminal.release();
    }
  }

  private async runKillTerminalCommand(
    sessionId: SessionId,
    rawCommand: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { command, args } = splitCommandLine(rawCommand);
    const terminal = await this.connection.createTerminal({
      sessionId,
      command,
      args,
    });

    try {
      await sleepWithCancel(120, signal);
      await terminal.kill();
      const exitStatus = await terminal.waitForExit();
      const finalOutput = await terminal.currentOutput();

      return [
        `killed terminal`,
        `exit: ${exitStatus.exitCode ?? "null"} signal: ${exitStatus.signal ?? "null"}`,
        finalOutput.output.trimEnd(),
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    } finally {
      await terminal.release();
    }
  }
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);
const mockAgentOptions = parseMockAgentOptions(process.argv.slice(2));

if (mockAgentOptions.ignoreSigterm) {
  process.on("SIGTERM", () => {
    // Intentionally ignore to exercise ACP client SIGKILL fallback behavior.
  });
}

const connection = new AgentSideConnection(
  (agentConnection) => new MockAgent(agentConnection, mockAgentOptions),
  stream,
);
void connection;
