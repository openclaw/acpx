import {
  methods,
  type AuthenticateRequest,
  type ClientCapabilities,
  type ClientConnection,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpElicitationMode } from "../types.js";
import { getAcpxVersion } from "../version.js";

const DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META = Object.freeze({
  "cognition.ai/requestDiagnostics": true,
});
const DEVIN_COMPATIBILITY_CLIENT_NAME = "windsurf";
// This is the embedded Windsurf IDE version bundled with Devin Desktop 3.1.7, the first locally verified version that passes Devin's server-side ACP precondition.
const DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION = "1.110.1";

export type AcpAgentConnection = {
  signal: AbortSignal;
  close?: (error?: unknown) => void;
  initialize: (params: InitializeRequest) => Promise<InitializeResponse>;
  authenticate: (params: AuthenticateRequest) => Promise<void>;
  newSession: (params: NewSessionRequest) => Promise<NewSessionResponse>;
  loadSession: (params: LoadSessionRequest) => Promise<LoadSessionResponse>;
  resumeSession: (params: ResumeSessionRequest) => Promise<ResumeSessionResponse>;
  prompt: (params: PromptRequest) => Promise<PromptResponse>;
  setSessionMode: (params: SetSessionModeRequest) => Promise<SetSessionModeResponse>;
  setSessionConfigOption: (
    params: SetSessionConfigOptionRequest,
  ) => Promise<SetSessionConfigOptionResponse>;
  extMethod: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancel: (params: { sessionId: string }) => Promise<void>;
  closeSession: (params: { sessionId: string }) => Promise<void>;
  listSessions: (params: ListSessionsRequest) => Promise<ListSessionsResponse>;
};

export function resolveClientInfo(devinAcp: boolean): { name: string; version: string } {
  if (!devinAcp) {
    return {
      name: "acpx",
      version: getAcpxVersion(),
    };
  }

  return {
    name: DEVIN_COMPATIBILITY_CLIENT_NAME,
    version: process.env.ACPX_DEVIN_WINDSURF_VERSION ?? DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION,
  };
}

export function createAgentConnectionFacade(connection: ClientConnection): AcpAgentConnection {
  const agent = connection.agent;
  return {
    signal: connection.signal,
    close: (error) => connection.close(error),
    initialize: async (params) => await agent.request(methods.agent.initialize, params),
    authenticate: async (params) => {
      await agent.request(methods.agent.authenticate, params);
    },
    newSession: async (params) => await agent.request(methods.agent.session.new, params),
    loadSession: async (params) => await agent.request(methods.agent.session.load, params),
    resumeSession: async (params) => await agent.request(methods.agent.session.resume, params),
    prompt: async (params) => await agent.request(methods.agent.session.prompt, params),
    setSessionMode: async (params) => await agent.request(methods.agent.session.setMode, params),
    setSessionConfigOption: async (params) =>
      await agent.request(methods.agent.session.setConfigOption, params),
    extMethod: async (method, params) =>
      await agent.request<Record<string, unknown>, Record<string, unknown>>(method, params),
    cancel: async (params) => await agent.notify(methods.agent.session.cancel, params),
    closeSession: async (params) => {
      await agent.request(methods.agent.session.close, params);
    },
    listSessions: async (params) => await agent.request(methods.agent.session.list, params),
  };
}

export function resolveClientCapabilities(params: {
  devinAcp: boolean;
  fs: boolean;
  terminal: boolean;
  elicitationModes: readonly AcpElicitationMode[];
}): ClientCapabilities {
  const baseCapabilities: ClientCapabilities = {
    fs: {
      readTextFile: params.fs,
      writeTextFile: params.fs,
    },
    terminal: params.terminal,
    ...(params.elicitationModes.length > 0
      ? {
          elicitation: {
            ...(params.elicitationModes.includes("form") ? { form: {} } : {}),
            ...(params.elicitationModes.includes("url") ? { url: {} } : {}),
          },
        }
      : {}),
  };

  if (!params.devinAcp) {
    return baseCapabilities;
  }

  return {
    ...baseCapabilities,
    _meta: DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META,
  };
}
