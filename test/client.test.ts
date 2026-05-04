import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  AcpClient,
  buildAgentSpawnOptions,
  buildQoderAcpCommandArgs,
  resolveAgentCloseAfterStdinEndMs,
  shouldIgnoreNonJsonAgentOutputLine,
} from "../src/acp/client.js";
import {
  AgentDisconnectedError,
  AgentStartupError,
  AuthPolicyError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "../src/errors.js";

type ClientInternals = {
  selectAuthMethod?: (methods: Array<{ id: string }>) =>
    | {
        methodId: string;
        credential: string;
        source: "env" | "config";
      }
    | undefined;
  authenticateIfRequired?: (
    connection: { authenticate: (params: { methodId: string }) => Promise<void> },
    methods: Array<{ id: string }>,
  ) => Promise<void>;
  handlePermissionRequest?: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  handleReadTextFile?: (params: {
    sessionId: string;
    path: string;
    line?: number | null;
    limit?: number | null;
  }) => Promise<{ content: string }>;
  handleWriteTextFile?: (params: {
    sessionId: string;
    path: string;
    content: string;
  }) => Promise<Record<string, never>>;
  handleCreateTerminal?: (params: {
    sessionId: string;
    command: string;
    args?: string[];
  }) => Promise<{ terminalId: string }>;
  notePromptPermissionFailure?: (
    sessionId: string,
    error: PermissionPromptUnavailableError,
  ) => void;
  consumePromptPermissionFailure?: (
    sessionId: string,
  ) => PermissionPromptUnavailableError | undefined;
  handleSessionUpdate?: (notification: { sessionId: string }) => Promise<void>;
  waitForSessionUpdateDrain?: (idleMs: number, timeoutMs: number) => Promise<void>;
  recordAgentExit?: (
    reason: "process_exit" | "process_close" | "pipe_close" | "connection_close",
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  filesystem?: {
    readTextFile: (params: {
      sessionId: string;
      path: string;
      line?: number | null;
      limit?: number | null;
    }) => Promise<{ content: string }>;
    writeTextFile: (params: {
      sessionId: string;
      path: string;
      content: string;
    }) => Promise<Record<string, never>>;
  };
  terminalManager?: {
    shutdown: () => Promise<void>;
    createTerminal?: (params: {
      sessionId: string;
      command: string;
      args?: string[];
    }) => Promise<{ terminalId: string }>;
  };
  cancel?: (sessionId: string) => Promise<void>;
  connection?: unknown;
  agent?: {
    pid?: number;
    killed?: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: PassThrough & { destroyed: boolean; end: () => void; destroy: () => void };
    stdout: PassThrough & { destroyed: boolean; destroy: () => void };
    stderr: PassThrough & { destroyed: boolean; destroy: () => void };
    kill: (signal?: NodeJS.Signals) => void;
    unref: () => void;
  };
  activePrompt?:
    | {
        sessionId: string;
        promise: Promise<{ stopReason: "end_turn" | "cancelled" }>;
      }
    | undefined;
  cancellingSessionIds: Set<string>;
  promptPermissionFailures: Map<string, PermissionPromptUnavailableError>;
  initResult?: {
    agentCapabilities?: {
      sessionCapabilities?: {
        close?: Record<string, never>;
      };
    };
  };
  loadedSessionId?: string;
  lastKnownPid?: number;
  agentStartedAt?: string;
  closing: boolean;
  observedSessionUpdates: number;
  processedSessionUpdates: number;
  suppressSessionUpdates: boolean;
  suppressReplaySessionUpdateMessages: boolean;
};

test("buildAgentSpawnOptions normalizes auth env keys and preserves existing values", () => {
  withEnv(
    {
      ACPX_AUTH_API_TOKEN: "existing-prefixed",
      API_TOKEN: "existing-normalized",
    },
    () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", {
        "api-token": "from-config",
        EXPLICIT_KEY: "explicit",
        "bad=key": "ignored-for-raw-key",
        empty: "   ",
      });

      assert.equal(options.cwd, "/tmp/acpx-agent");
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.ACPX_AUTH_API_TOKEN, "existing-prefixed");
      assert.equal(options.env.API_TOKEN, "existing-normalized");
      assert.equal(options.env.EXPLICIT_KEY, "explicit");
      assert.equal(options.env.ACPX_AUTH_EXPLICIT_KEY, "explicit");
      assert.equal(options.env["bad=key"], undefined);
      assert.equal(options.env.ACPX_AUTH_BAD_KEY, "ignored-for-raw-key");
      assert.equal(options.env.empty, undefined);
    },
  );
});

test("resolveAgentCloseAfterStdinEndMs gives qodercli extra EOF shutdown grace", () => {
  assert.equal(resolveAgentCloseAfterStdinEndMs("qodercli --acp"), 750);
  assert.equal(resolveAgentCloseAfterStdinEndMs("/Users/me/bin/qodercli --acp"), 750);
  assert.equal(resolveAgentCloseAfterStdinEndMs("node ./test/mock-agent.js"), 100);
});

test("shouldIgnoreNonJsonAgentOutputLine ignores qoder shutdown chatter only", () => {
  assert.equal(
    shouldIgnoreNonJsonAgentOutputLine(
      "qodercli --acp",
      "Received interrupt signal. Cleaning up resources...",
    ),
    true,
  );
  assert.equal(
    shouldIgnoreNonJsonAgentOutputLine("qodercli --acp", "Cleanup completed. Exiting..."),
    true,
  );
  assert.equal(
    shouldIgnoreNonJsonAgentOutputLine(
      "node ./test/mock-agent.js",
      "Cleanup completed. Exiting...",
    ),
    false,
  );
  assert.equal(
    shouldIgnoreNonJsonAgentOutputLine("qodercli --acp", "unexpected non-json output"),
    false,
  );
});

test("buildQoderAcpCommandArgs forwards allowed-tools and max-turns", () => {
  assert.deepEqual(
    buildQoderAcpCommandArgs(["--acp"], {
      sessionOptions: {
        allowedTools: ["Read", "Grep", "custom_tool"],
        maxTurns: 9,
      },
    }),
    ["--acp", "--max-turns=9", "--allowed-tools=READ,GREP,custom_tool"],
  );
});

test("buildQoderAcpCommandArgs preserves explicit qoder startup flags", () => {
  assert.deepEqual(
    buildQoderAcpCommandArgs(
      ["--acp", "--max-turns=3", "--allowed-tools=READ", "--disallowed-tools=BASH"],
      {
        sessionOptions: {
          allowedTools: ["Write"],
          maxTurns: 7,
        },
      },
    ),
    ["--acp", "--max-turns=3", "--allowed-tools=READ", "--disallowed-tools=BASH"],
  );
});

test("AcpClient prefers env auth credentials over config credentials", async () => {
  await withEnv(
    {
      ACPX_AUTH_API_TOKEN: "from-env",
    },
    async () => {
      const client = makeClient({
        authCredentials: {
          API_TOKEN: "from-config",
          second_method: "fallback-config",
        },
      });
      const internals = asInternals(client);

      const selection = internals.selectAuthMethod?.([
        { id: "api-token" },
        { id: "second_method" },
      ]);
      assert.deepEqual(selection, {
        methodId: "api-token",
        credential: "from-env",
        source: "env",
      });

      let authenticatedMethod: string | undefined;
      await internals.authenticateIfRequired?.(
        {
          authenticate: async ({ methodId }: { methodId: string }) => {
            authenticatedMethod = methodId;
          },
        },
        [{ id: "api-token" }],
      );

      assert.equal(authenticatedMethod, "api-token");
    },
  );
});

test("AcpClient ignores ambient normalized provider env vars for auth selection", async () => {
  await withEnv(
    {
      OPENAI_API_KEY: "sk-ambient",
      ACPX_AUTH_OPENAI_API_KEY: undefined,
    },
    async () => {
      const client = makeClient();
      const internals = asInternals(client);

      const selection = internals.selectAuthMethod?.([{ id: "openai-api-key" }]);
      assert.equal(selection, undefined);

      let authenticatedMethod: string | undefined;
      await internals.authenticateIfRequired?.(
        {
          authenticate: async ({ methodId }: { methodId: string }) => {
            authenticatedMethod = methodId;
          },
        },
        [{ id: "openai-api-key" }],
      );

      assert.equal(authenticatedMethod, undefined);
    },
  );
});

test("AcpClient authenticateIfRequired throws when auth policy is fail and credentials are missing", async () => {
  const client = makeClient({ authPolicy: "fail" });
  const internals = asInternals(client);

  await assert.rejects(
    async () =>
      await internals.authenticateIfRequired?.(
        {
          authenticate: async () => {},
        },
        [{ id: "api-token" }],
      ),
    AuthPolicyError,
  );
});

test("AcpClient handlePermissionRequest short-circuits cancels and tracks unavailable prompts", async () => {
  const client = makeClient({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
  });
  const internals = asInternals(client);
  const request = makePermissionRequest("session-1", "edit");

  internals.cancellingSessionIds.add("session-1");
  const cancelled = await internals.handlePermissionRequest?.(request);
  assert.deepEqual(cancelled, {
    outcome: {
      outcome: "cancelled",
    },
  });
  assert.deepEqual(client.getPermissionStats(), {
    requested: 0,
    approved: 0,
    denied: 0,
    cancelled: 0,
  });

  internals.cancellingSessionIds.clear();
  await withTty(false, false, async () => {
    const unavailable = await internals.handlePermissionRequest?.(request);
    assert.deepEqual(unavailable, {
      outcome: {
        outcome: "cancelled",
      },
    });
  });

  assert.deepEqual(client.getPermissionStats(), {
    requested: 1,
    approved: 0,
    denied: 0,
    cancelled: 1,
  });
  const noted = internals.consumePromptPermissionFailure?.("session-1");
  assert(noted instanceof PermissionPromptUnavailableError);
  assert.equal(internals.consumePromptPermissionFailure?.("session-1"), undefined);
});

test("AcpClient handlePermissionRequest records approved decisions", async () => {
  const client = makeClient({
    permissionMode: "approve-all",
  });

  const response = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-2", "read"),
  );

  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });
  assert.deepEqual(client.getPermissionStats(), {
    requested: 1,
    approved: 1,
    denied: 0,
    cancelled: 0,
  });
});

test("AcpClient client-method permission errors update permission stats", async () => {
  const client = makeClient();
  const internals = asInternals(client);

  internals.filesystem = {
    readTextFile: async () => {
      throw new PermissionDeniedError("Permission denied for fs/read_text_file");
    },
    writeTextFile: async () => {
      throw new PermissionDeniedError("Permission denied for fs/write_text_file");
    },
  };
  internals.terminalManager = {
    shutdown: async () => {},
    createTerminal: async () => {
      throw new PermissionPromptUnavailableError();
    },
  };

  await assert.rejects(
    async () =>
      await internals.handleReadTextFile?.({
        sessionId: "session-read",
        path: "/tmp/read.txt",
      }),
    PermissionDeniedError,
  );
  await assert.rejects(
    async () =>
      await internals.handleWriteTextFile?.({
        sessionId: "session-write",
        path: "/tmp/write.txt",
        content: "updated",
      }),
    PermissionDeniedError,
  );
  await assert.rejects(
    async () =>
      await internals.handleCreateTerminal?.({
        sessionId: "session-terminal",
        command: "echo",
        args: ["hi"],
      }),
    PermissionPromptUnavailableError,
  );

  assert.deepEqual(client.getPermissionStats(), {
    requested: 3,
    approved: 0,
    denied: 2,
    cancelled: 1,
  });
  const noted = internals.consumePromptPermissionFailure?.("session-terminal");
  assert(noted instanceof PermissionPromptUnavailableError);
});

test("AcpClient createSession forwards claudeCode options in _meta", async () => {
  const client = makeClient({
    sessionOptions: {
      model: "sonnet",
      allowedTools: ["Read", "Grep"],
      maxTurns: 12,
    },
  });

  let capturedParams: Record<string, unknown> | undefined;
  asInternals(client).connection = {
    newSession: async (params: Record<string, unknown>) => {
      capturedParams = params;
      return { sessionId: "session-123" };
    },
  };

  const result = await client.createSession("/tmp/acpx-client-meta");
  assert.equal(result.sessionId, "session-123");
  assert.deepEqual(capturedParams, {
    cwd: "/tmp/acpx-client-meta",
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: {
          model: "sonnet",
          allowedTools: ["Read", "Grep"],
          maxTurns: 12,
        },
      },
    },
  });
});

test("AcpClient createSession forwards systemPrompt string in _meta", async () => {
  const client = makeClient({
    sessionOptions: {
      systemPrompt: "you are an obsidian assistant",
    },
  });

  let capturedParams: Record<string, unknown> | undefined;
  asInternals(client).connection = {
    newSession: async (params: Record<string, unknown>) => {
      capturedParams = params;
      return { sessionId: "session-sp-string" };
    },
  };

  await client.createSession("/tmp/acpx-client-system-prompt");
  assert.deepEqual(capturedParams, {
    cwd: "/tmp/acpx-client-system-prompt",
    mcpServers: [],
    _meta: {
      systemPrompt: "you are an obsidian assistant",
    },
  });
});

test("AcpClient createSession forwards systemPrompt append in _meta alongside claudeCode options", async () => {
  const client = makeClient({
    sessionOptions: {
      model: "sonnet",
      systemPrompt: { append: "always speak in spanish" },
    },
  });

  let capturedParams: Record<string, unknown> | undefined;
  asInternals(client).connection = {
    newSession: async (params: Record<string, unknown>) => {
      capturedParams = params;
      return { sessionId: "session-sp-append" };
    },
  };

  await client.createSession("/tmp/acpx-client-system-prompt-append");
  assert.deepEqual(capturedParams, {
    cwd: "/tmp/acpx-client-system-prompt-append",
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: {
          model: "sonnet",
        },
      },
      systemPrompt: { append: "always speak in spanish" },
    },
  });
});

test("AcpClient createSession forwards codex model metadata without setting it explicitly", async () => {
  const client = makeClient({
    agentCommand: "npx @zed-industries/codex-acp",
    sessionOptions: {
      model: "GPT-5-2",
    },
  });

  let capturedNewSessionParams: Record<string, unknown> | undefined;
  let setConfigCalled = false;
  asInternals(client).connection = {
    newSession: async (params: Record<string, unknown>) => {
      capturedNewSessionParams = params;
      return { sessionId: "session-456" };
    },
    setSessionConfigOption: async () => {
      setConfigCalled = true;
      return { configOptions: [] };
    },
  };

  const result = await client.createSession("/tmp/acpx-client-codex-model");
  assert.equal(result.sessionId, "session-456");
  assert.deepEqual(capturedNewSessionParams, {
    cwd: "/tmp/acpx-client-codex-model",
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: {
          model: "GPT-5-2",
        },
      },
    },
  });
  assert.equal(setConfigCalled, false);
});

test("AcpClient setSessionModel uses session/set_model", async () => {
  const client = makeClient();

  let capturedSetModelParams:
    | {
        sessionId: string;
        modelId: string;
      }
    | undefined;
  asInternals(client).connection = {
    unstable_setSessionModel: async (params: { sessionId: string; modelId: string }) => {
      capturedSetModelParams = params;
    },
  };

  await client.setSessionModel("session-456", "GPT-5-2");
  assert.deepEqual(capturedSetModelParams, {
    sessionId: "session-456",
    modelId: "GPT-5-2",
  });
});

test("AcpClient closes sessions through session/close and clears the loaded session id", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let capturedCloseSessionParams: { sessionId: string } | undefined;
  internals.initResult = {
    agentCapabilities: {
      sessionCapabilities: {
        close: {},
      },
    },
  };
  internals.loadedSessionId = "session-close-1";
  internals.connection = {
    closeSession: async (params: { sessionId: string }) => {
      capturedCloseSessionParams = params;
      return {};
    },
  };

  assert.equal(client.supportsCloseSession(), true);
  await client.closeSession("session-close-1");

  assert.deepEqual(capturedCloseSessionParams, {
    sessionId: "session-close-1",
  });
  assert.equal(internals.loadedSessionId, undefined);
});

test("AcpClient session update handling drains queued callbacks and swallows handler failures", async () => {
  const notifications: string[] = [];
  const client = makeClient({
    onSessionUpdate: (notification) => {
      notifications.push(notification.sessionId);
      if (notification.sessionId === "bad") {
        throw new Error("boom");
      }
    },
  });
  const internals = asInternals(client);

  await Promise.all([
    internals.handleSessionUpdate?.({ sessionId: "good" } as never),
    internals.handleSessionUpdate?.({ sessionId: "bad" } as never),
  ]);
  await internals.waitForSessionUpdateDrain?.(0, 100);

  assert.deepEqual(notifications, ["good", "bad"]);
  assert.equal(internals.observedSessionUpdates, 2);
  assert.equal(internals.processedSessionUpdates, 2);

  internals.suppressSessionUpdates = true;
  await internals.handleSessionUpdate?.({ sessionId: "suppressed" } as never);
  assert.deepEqual(notifications, ["good", "bad"]);
});

test("AcpClient lifecycle snapshot and cancel helpers reflect active prompt state", async () => {
  const client = makeClient();
  const internals = asInternals(client);

  assert.equal(client.hasActivePrompt(), false);
  assert.equal(await client.requestCancelActivePrompt(), false);
  assert.equal(await client.cancelActivePrompt(0), undefined);

  let cancelledSessionId: string | undefined;
  internals.cancel = async (sessionId: string) => {
    cancelledSessionId = sessionId;
  };
  internals.activePrompt = {
    sessionId: "session-3",
    promise: Promise.resolve({ stopReason: "cancelled" }),
  };
  internals.lastKnownPid = 4321;
  internals.agentStartedAt = "2026-01-01T00:00:00.000Z";

  assert.equal(client.hasActivePrompt(), true);
  assert.equal(client.hasActivePrompt("session-3"), true);
  assert.equal(await client.requestCancelActivePrompt(), true);
  assert.equal(cancelledSessionId, "session-3");

  internals.recordAgentExit?.("process_exit", 1, "SIGTERM");
  internals.recordAgentExit?.("pipe_close", 0, null);
  const snapshot = client.getAgentLifecycleSnapshot();
  assert.equal(snapshot.pid, 4321);
  assert.equal(snapshot.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.lastExit?.reason, "process_exit");
  assert.equal(snapshot.lastExit?.unexpectedDuringPrompt, true);

  const cancelled = await client.cancelActivePrompt(50);
  assert.deepEqual(cancelled, { stopReason: "cancelled" });
});

test("AcpClient prompt rejects when the agent disconnects mid-prompt", async () => {
  const client = makeClient();
  const internals = asInternals(client);

  internals.connection = {
    prompt: async () => await new Promise(() => {}),
  };

  const pending = client.prompt("session-5", "sleep 60000");
  internals.recordAgentExit?.("connection_close", null, null);

  const result = await Promise.race([
    pending.then(
      () => ({ type: "resolved" as const }),
      (error) => ({ type: "rejected" as const, error }),
    ),
    new Promise<{ type: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ type: "timeout" }), 100);
    }),
  ]);

  assert.equal(result.type, "rejected");
  assert(result.error instanceof AgentDisconnectedError);
  assert.match(result.error.message, /disconnected during request/i);
  assert.equal(client.hasActivePrompt(), false);
});

test("AcpClient start fails fast when the agent exits during initialize", async () => {
  const stderrLine = "startup boom";
  const client = makeClient({
    agentCommand: `${JSON.stringify(process.execPath)} --eval ${JSON.stringify(
      `process.stderr.write(${JSON.stringify(`${stderrLine}\n`)}); process.exit(1);`,
    )}`,
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => client.start(),
    (error: unknown) => {
      assert(error instanceof AgentStartupError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.signal, null);
      assert.match(error.message, /startup boom/);
      return true;
    },
  );
  assert(Date.now() - startedAt < 2_000);
});

test("AcpClient close resets in-memory state and shuts down terminal manager", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let shutdownCalls = 0;
  let killCalls = 0;
  let unrefCalls = 0;

  internals.terminalManager = {
    shutdown: async () => {
      shutdownCalls += 1;
    },
  };

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  internals.agent = {
    pid: 9876,
    killed: false,
    exitCode: 0,
    signalCode: null,
    stdin: Object.assign(stdin, {
      end: () => stdin.destroy(),
      destroy: () => PassThrough.prototype.destroy.call(stdin),
    }),
    stdout: Object.assign(stdout, {
      destroy: () => PassThrough.prototype.destroy.call(stdout),
    }),
    stderr: Object.assign(stderr, {
      destroy: () => PassThrough.prototype.destroy.call(stderr),
    }),
    kill: () => {
      killCalls += 1;
    },
    unref: () => {
      unrefCalls += 1;
    },
  };
  internals.connection = { closed: false };
  internals.activePrompt = {
    sessionId: "session-4",
    promise: new Promise(() => {}),
  };
  internals.cancellingSessionIds.add("session-4");
  internals.notePromptPermissionFailure?.("session-4", new PermissionPromptUnavailableError());
  internals.observedSessionUpdates = 5;
  internals.processedSessionUpdates = 4;
  internals.suppressSessionUpdates = true;
  internals.suppressReplaySessionUpdateMessages = true;

  await client.close();

  assert.equal(shutdownCalls, 1);
  assert.equal(killCalls, 0);
  assert.equal(unrefCalls, 0);
  assert.equal(internals.connection, undefined);
  assert.equal(internals.agent, undefined);
  assert.equal(internals.activePrompt, undefined);
  assert.equal(internals.cancellingSessionIds.size, 0);
  assert.equal(internals.promptPermissionFailures.size, 0);
  assert.equal(internals.observedSessionUpdates, 0);
  assert.equal(internals.processedSessionUpdates, 0);
  assert.equal(internals.suppressSessionUpdates, false);
  assert.equal(internals.suppressReplaySessionUpdateMessages, false);
  assert.equal(internals.closing, true);
});

function makeClient(
  overrides: Partial<ConstructorParameters<typeof AcpClient>[0]> = {},
): AcpClient {
  return new AcpClient({
    agentCommand: "node ./test/mock-agent.js",
    cwd: process.cwd(),
    permissionMode: "approve-reads",
    ...overrides,
  });
}

function asInternals(client: AcpClient): ClientInternals {
  return client as unknown as ClientInternals;
}

function makePermissionRequest(
  sessionId: string,
  kind: RequestPermissionRequest["toolCall"]["kind"],
): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: {
      toolCallId: "call-1",
      title: "edit file",
      kind,
    },
    options: [
      {
        optionId: "allow",
        name: "Allow",
        kind: "allow_once",
      },
      {
        optionId: "reject",
        name: "Reject",
        kind: "reject_once",
      },
    ],
  };
}

async function withEnv(
  entries: Record<string, string | undefined>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withTty(
  stdinIsTty: boolean,
  stderrIsTty: boolean,
  run: () => Promise<void>,
): Promise<void> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: stdinIsTty,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: stderrIsTty,
  });

  try {
    await run();
  } finally {
    restoreDescriptor(process.stdin, "isTTY", stdinDescriptor);
    restoreDescriptor(process.stderr, "isTTY", stderrDescriptor);
  }
}

function restoreDescriptor(
  target: object,
  key: "isTTY",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    delete (target as Record<string, unknown>)[key];
  }
}
