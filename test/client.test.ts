import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { getEventListeners } from "node:events";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import type {
  AnyMessage,
  ClientConnection,
  ClientCapabilities,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  AcpClient,
  buildAgentSpawnOptions,
  buildQoderAcpCommandArgs,
  parseAcpJsonMessageLine,
  resolveClaudeCodeSettingSources,
  resolveAgentCloseAfterStdinEndMs,
  shouldIgnoreNonJsonAgentOutputLine,
} from "../src/acp/client.js";
import {
  AgentDisconnectedError,
  AgentSpawnError,
  AgentStartupError,
  AuthPolicyError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
  UnsupportedPromptContentError,
} from "../src/errors.js";
import type { AcpProcessStarted } from "../src/types.js";

test("parseAcpJsonMessageLine ignores non-object JSON values", () => {
  for (const line of ["1", "null", '"diagnostic"', "[]", "[{}]"]) {
    assert.equal(parseAcpJsonMessageLine(line), undefined);
  }
});

test("parseAcpJsonMessageLine preserves object-shaped protocol values", () => {
  assert.deepEqual(parseAcpJsonMessageLine('{"jsonrpc":"2.0","method":"session/update"}'), {
    jsonrpc: "2.0",
    method: "session/update",
  });
});

type ClientInternals = {
  createTappedStream?: (base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  }) => {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  };
  createConnection?: (
    stream: {
      readable: ReadableStream<AnyMessage>;
      writable: WritableStream<AnyMessage>;
    },
    launch: { devinAcp: boolean },
    capabilities: ClientCapabilities,
  ) => ClientConnection;
  selectAuthMethod?: (methods: Array<{ id: string }>) =>
    | {
        methodId: string;
        credential: string;
        source: "env" | "config";
      }
    | undefined;
  authenticateIfRequired?: (
    connection: {
      agent: { request: (method: string, params: { methodId: string }) => Promise<void> };
    },
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
    child: ClientInternals["agent"],
    reason: "process_exit" | "process_close" | "pipe_close" | "connection_close",
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  attachAgentLifecycleObservers?: (
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    startedProcess: AcpProcessStarted,
    exitNotificationBarrier: Promise<void>,
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
        elicitationController?: AbortController;
      }
    | undefined;
  cancellingSessionIds: Set<string>;
  promptPermissionFailures: Map<string, PermissionPromptUnavailableError>;
  initResult?: Partial<InitializeResponse>;
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
          agent: {
            request: async (method: string, { methodId }: { methodId: string }) => {
              assert.equal(method, "authenticate");
              authenticatedMethod = methodId;
            },
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
          agent: {
            request: async (method: string, { methodId }: { methodId: string }) => {
              assert.equal(method, "authenticate");
              authenticatedMethod = methodId;
            },
          },
        },
        [{ id: "openai-api-key" }],
      );

      assert.equal(authenticatedMethod, undefined);
    },
  );
});

test("AcpClient uses XAI_API_KEY for Grok Build xai.api_key auth", async () => {
  await withEnv(
    {
      XAI_API_KEY: "xai-ambient",
      ACPX_AUTH_XAI_API_KEY: undefined,
    },
    async () => {
      const client = makeClient({ agentCommand: "grok agent stdio" });
      const internals = asInternals(client);

      const selection = internals.selectAuthMethod?.([{ id: "xai.api_key" }]);
      assert.deepEqual(selection, {
        methodId: "xai.api_key",
        credential: "xai-ambient",
        source: "env",
      });

      let authenticatedMethod: string | undefined;
      await internals.authenticateIfRequired?.(
        {
          agent: {
            request: async (method: string, { methodId }: { methodId: string }) => {
              assert.equal(method, "authenticate");
              authenticatedMethod = methodId;
            },
          },
        },
        [{ id: "xai.api_key" }],
      );

      assert.equal(authenticatedMethod, "xai.api_key");
    },
  );
});

test("AcpClient keeps XAI_API_KEY scoped to Grok Build auth", async () => {
  await withEnv(
    {
      XAI_API_KEY: "xai-ambient",
      ACPX_AUTH_XAI_API_KEY: undefined,
    },
    async () => {
      const client = makeClient({ agentCommand: "custom-acp-server" });
      const internals = asInternals(client);

      const selection = internals.selectAuthMethod?.([{ id: "xai.api_key" }]);
      assert.equal(selection, undefined);
    },
  );
});

test("AcpClient selects Grok Build cached_token as agent-managed auth", async () => {
  await withEnv(
    {
      XAI_API_KEY: undefined,
      ACPX_AUTH_CACHED_TOKEN: undefined,
    },
    async () => {
      const client = makeClient({ agentCommand: "grok agent stdio" });
      const internals = asInternals(client);

      const selection = internals.selectAuthMethod?.([{ id: "cached_token" }]);
      assert.deepEqual(selection, {
        methodId: "cached_token",
        source: "agent",
      });

      let authenticatedMethod: string | undefined;
      await internals.authenticateIfRequired?.(
        {
          agent: {
            request: async (method: string, { methodId }: { methodId: string }) => {
              assert.equal(method, "authenticate");
              authenticatedMethod = methodId;
            },
          },
        },
        [{ id: "cached_token" }],
      );

      assert.equal(authenticatedMethod, "cached_token");
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
          agent: { request: async () => {} },
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

test("AcpClient partial runtime option updates preserve permission policy", async () => {
  const client = makeClient({
    permissionMode: "approve-all",
    permissionPolicy: {
      autoDeny: ["execute"],
    },
  });

  client.updateRuntimeOptions({ verbose: true });

  const denied = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-policy-preserve-1", "execute"),
  );

  assert.deepEqual(denied, {
    outcome: {
      outcome: "selected",
      optionId: "reject",
    },
  });

  client.updateRuntimeOptions({ permissionPolicy: undefined });

  const approved = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-policy-preserve-2", "execute"),
  );

  assert.deepEqual(approved, {
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });
});

test("AcpClient snapshots permission policies at configuration boundaries", async () => {
  const initialPolicy = {
    autoDeny: ["execute"],
  };
  const client = makeClient({
    permissionMode: "approve-all",
    permissionPolicy: initialPolicy,
  });

  initialPolicy.autoDeny.splice(0, 1);
  const deniedFromInitialSnapshot = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-policy-snapshot-1", "execute"),
  );
  assert.equal(deniedFromInitialSnapshot?.outcome.outcome, "selected");
  if (deniedFromInitialSnapshot?.outcome.outcome === "selected") {
    assert.equal(deniedFromInitialSnapshot.outcome.optionId, "reject");
  }

  const updatedPolicy = {
    autoDeny: ["execute"],
  };
  client.updateRuntimeOptions({ permissionPolicy: updatedPolicy });
  updatedPolicy.autoDeny.splice(0, 1);
  const deniedFromUpdatedSnapshot = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-policy-snapshot-2", "execute"),
  );
  assert.equal(deniedFromUpdatedSnapshot?.outcome.outcome, "selected");
  if (deniedFromUpdatedSnapshot?.outcome.outcome === "selected") {
    assert.equal(deniedFromUpdatedSnapshot.outcome.optionId, "reject");
  }
});

test("AcpClient onPermissionRequest decision short-circuits the mode-based resolver", async () => {
  let callbackInvocations = 0;
  const client = makeClient({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
    onPermissionRequest: async (req) => {
      callbackInvocations += 1;
      assert.equal(req.sessionId, "session-cb-1");
      assert.equal(req.inferredKind, "edit");
      return { outcome: "allow_once" };
    },
  });

  const response = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-cb-1", "edit"),
  );

  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });
  assert.equal(callbackInvocations, 1);
  assert.deepEqual(client.getPermissionStats(), {
    requested: 1,
    approved: 1,
    denied: 0,
    cancelled: 0,
  });
});

for (const scenario of [
  { name: "mode denial", ids: ["cancel", "decline"], expected: "decline" },
  {
    name: "automatic approval",
    ids: ["cancel", "decline"],
    expected: "allow",
    mode: "approve-all" as const,
  },
  {
    name: "noninteractive denial",
    ids: ["cancel", "decline"],
    expected: "decline",
    mode: "approve-reads" as const,
  },
  {
    name: "permission policy denial",
    ids: ["cancel", "decline"],
    expected: "decline",
    mode: "approve-all" as const,
    policy: { defaultAction: "deny" as const },
  },
  {
    name: "permission-profile refusal",
    ids: ["cancel", "reject_permissions"],
    expected: "reject_permissions",
  },
  { name: "already ordered denial", ids: ["decline", "cancel"], expected: "decline" },
  {
    name: "host denial",
    ids: ["cancel", "decline"],
    expected: "decline",
    host: "reject_once" as const,
  },
  { name: "abort-only refusal", ids: ["cancel"], expected: "cancel", notice: true },
  {
    name: "host denial despite a throwing notice observer",
    ids: ["cancel"],
    expected: "cancel",
    mode: "approve-all" as const,
    host: "reject_once" as const,
    notice: true,
    throwNotice: true,
  },
  {
    name: "mode denial despite a throwing notice observer",
    ids: ["cancel"],
    expected: "cancel",
    notice: true,
    throwNotice: true,
  },
  { name: "missing refusal", ids: [], notice: true },
  { name: "explicit host cancellation", ids: ["cancel", "decline"], host: "cancel" as const },
  {
    name: "unrelated adapter",
    ids: ["cancel", "decline"],
    expected: "cancel",
    agent: "unrelated-adapter",
  },
]) {
  test(`AcpClient routes Codex permission ${scenario.name} through ACP`, async (t) => {
    const notices: string[] = [];
    const fixture = createClientFixture(t, {
      client: {
        permissionMode: scenario.mode ?? "deny-all",
        permissionPolicy: scenario.policy,
        onClientOperation: (operation) => {
          notices.push(operation.summary);
          if (scenario.throwNotice) {
            throw new Error("synthetic notice observer failure");
          }
        },
        onPermissionRequest: scenario.host
          ? async (request) => {
              assert.deepEqual(
                request.raw.options.map((option) => option.optionId),
                ["allow", ...scenario.ids],
              );
              return { outcome: scenario.host };
            }
          : undefined,
      },
    });
    asInternals(fixture.client).initResult = {
      agentInfo: { name: scenario.agent ?? "@agentclientprotocol/codex-acp", version: "1.12.0" },
    };
    const request: RequestPermissionRequest = {
      sessionId: "synthetic-permission",
      toolCall: { toolCallId: "synthetic-call", title: "synthetic operation", kind: "execute" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        ...scenario.ids.map((optionId) => ({
          optionId,
          name: optionId,
          kind: "reject_once" as const,
        })),
      ],
    };
    await fixture.send({
      jsonrpc: "2.0",
      id: "permission",
      method: "session/request_permission",
      params: request,
    });
    const message = await fixture.message(0);
    assert("result" in message);
    const response = message.result as RequestPermissionResponse;
    assert.equal(fixture.client.getPermissionStats().requested, 1);
    assert.deepEqual(
      response.outcome,
      scenario.expected
        ? { outcome: "selected", optionId: scenario.expected }
        : { outcome: "cancelled" },
    );
    if (scenario.notice) {
      assert.equal(notices.length, 1);
      assert.match(notices[0], /cancel.*turn/i);
      assert.match(JSON.stringify(response._meta), /permissionNotice/);
    } else {
      assert.deepEqual(notices, []);
      assert.equal(response._meta, undefined);
    }
  });
}

test("AcpClient onPermissionRequest returning undefined falls through to mode-based resolver", async () => {
  let callbackInvocations = 0;
  const client = makeClient({
    permissionMode: "approve-all",
    onPermissionRequest: async () => {
      callbackInvocations += 1;
      return undefined;
    },
  });

  const response = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-cb-2", "edit"),
  );

  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });
  assert.equal(callbackInvocations, 1);
  assert.deepEqual(client.getPermissionStats(), {
    requested: 1,
    approved: 1,
    denied: 0,
    cancelled: 0,
  });
});

test("AcpClient onPermissionRequest throws fall through to mode-based resolver", async () => {
  let callbackInvocations = 0;
  const client = makeClient({
    permissionMode: "approve-all",
    onPermissionRequest: async () => {
      callbackInvocations += 1;
      throw new Error("UI exploded");
    },
  });

  const response = await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-cb-3", "edit"),
  );

  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });
  assert.equal(callbackInvocations, 1);
});

test("AcpClient onPermissionRequest receives an AbortSignal that fires on session cancel", async (t) => {
  let observedSignal: AbortSignal | undefined;
  const fixture = createClientFixture(t, {
    client: {
      permissionMode: "approve-all",
      onPermissionRequest: async (_req, ctx) => {
        observedSignal = ctx.signal;
        return { outcome: "allow_once" };
      },
    },
  });
  const { client } = fixture;

  await asInternals(client).handlePermissionRequest?.(
    makePermissionRequest("session-cb-4", "edit"),
  );

  assert(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal?.aborted, false);

  await client.cancel("session-cb-4");
  assert.equal(observedSignal?.aborted, true);
});

test("AcpClient onPermissionRequest cancels a late decision after session cancel", async (t) => {
  let resolveDecision!: (decision: { outcome: "allow_once" }) => void;
  const decisionPromise = new Promise<{ outcome: "allow_once" }>((resolve) => {
    resolveDecision = resolve;
  });
  let callbackStarted!: () => void;
  const callbackStartedPromise = new Promise<void>((resolve) => {
    callbackStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;

  const fixture = createClientFixture(t, {
    client: {
      permissionMode: "approve-all",
      onPermissionRequest: async (_req, ctx) => {
        observedSignal = ctx.signal;
        callbackStarted();
        return await decisionPromise;
      },
    },
  });
  const { client } = fixture;
  const internals = asInternals(client);

  const responsePromise = internals.handlePermissionRequest?.(
    makePermissionRequest("session-cb-5", "edit"),
  );
  await callbackStartedPromise;

  await client.cancel("session-cb-5");
  assert.equal(observedSignal?.aborted, true);

  resolveDecision({ outcome: "allow_once" });
  const response = await responsePromise;

  assert.deepEqual(response, {
    outcome: {
      outcome: "cancelled",
    },
  });
  assert.deepEqual(client.getPermissionStats(), {
    requested: 1,
    approved: 0,
    denied: 0,
    cancelled: 1,
  });
});

test("AcpClient onPermissionRequest treats abort rejections as cancelled", async (t) => {
  let callbackStarted!: () => void;
  const callbackStartedPromise = new Promise<void>((resolve) => {
    callbackStarted = resolve;
  });

  const fixture = createClientFixture(t, {
    client: {
      permissionMode: "approve-all",
      onPermissionRequest: async (_req, ctx) => {
        callbackStarted();
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    },
  });
  const { client } = fixture;
  const internals = asInternals(client);

  const responsePromise = internals.handlePermissionRequest?.(
    makePermissionRequest("session-cb-6", "edit"),
  );
  await callbackStartedPromise;

  await client.cancel("session-cb-6");
  const response = await responsePromise;

  assert.deepEqual(response, {
    outcome: {
      outcome: "cancelled",
    },
  });
  assert.deepEqual(client.getPermissionStats(), {
    requested: 1,
    approved: 0,
    denied: 0,
    cancelled: 1,
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

for (const scenario of [
  {
    name: "AcpClient createSession forwards claudeCode options in _meta",
    options: { sessionOptions: { model: "sonnet", allowedTools: ["Read", "Grep"], maxTurns: 12 } },
    meta: {
      claudeCode: { options: { model: "sonnet", allowedTools: ["Read", "Grep"], maxTurns: 12 } },
    },
  },
  {
    name: "AcpClient creates built-in Claude sessions without user settings by default",
    options: { agentCommand: "npx -y @agentclientprotocol/claude-agent-acp" },
    meta: { claudeCode: { options: { settingSources: ["project", "local"] } } },
  },
  {
    name: "AcpClient createSession forwards systemPrompt string in _meta",
    options: { sessionOptions: { systemPrompt: "you are an obsidian assistant" } },
    meta: { systemPrompt: "you are an obsidian assistant" },
  },
  {
    name: "AcpClient createSession forwards systemPrompt append in _meta alongside claudeCode options",
    options: {
      sessionOptions: { model: "sonnet", systemPrompt: { append: "always speak in spanish" } },
    },
    meta: {
      claudeCode: { options: { model: "sonnet" } },
      systemPrompt: { append: "always speak in spanish" },
    },
  },
  {
    name: "AcpClient createSession forwards codex model metadata without setting it explicitly",
    options: {
      agentCommand: "npx -y @agentclientprotocol/codex-acp",
      sessionOptions: { model: "GPT-5-2" },
    },
    meta: { claudeCode: { options: { model: "GPT-5-2" } } },
  },
]) {
  test(scenario.name, async (t) => {
    const fixture = createClientFixture(t, { client: scenario.options });
    const cwd = path.resolve("/tmp/acpx-client-meta");
    const pending = fixture.track(fixture.client.createSession(cwd));
    const request = await fixture.message(0);
    assert("method" in request);
    assert.equal(request.method, "session/new");
    assert.deepEqual(request.params, { cwd, mcpServers: [], _meta: scenario.meta });
    await fixture.reply(request, { sessionId: "session-meta" });
    assert.equal((await pending).sessionId, "session-meta");
    assert.equal(fixture.messages.length, 1, "session creation must not send a model control");
  });
}

test("resolveClaudeCodeSettingSources includes user settings only when explicitly enabled", () => {
  assert.deepEqual(resolveClaudeCodeSettingSources({}), ["project", "local"]);
  assert.deepEqual(resolveClaudeCodeSettingSources({ ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1" }), [
    "user",
    "project",
    "local",
  ]);
  assert.deepEqual(resolveClaudeCodeSettingSources({ ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "true" }), [
    "project",
    "local",
  ]);
});

for (const scenario of [
  {
    name: "AcpClient setSessionModel uses the model session config option",
    client: {},
    model: "GPT-5-2",
    control: { configId: "model" },
    expected: "GPT-5-2",
  },
  {
    name: "AcpClient setSessionModel honors an advertised custom config id",
    client: {},
    model: "GPT-5-2",
    control: { configId: "llm" },
    expected: "GPT-5-2",
  },
  {
    name: "AcpClient normalizes a Cursor model alias to its unique advertised id",
    client: { agentCommand: "cursor-agent acp" },
    model: "composer-2.5",
    control: {
      configId: "model",
      availableModels: [{ modelId: "composer-2.5[fast=false]", name: "Composer 2.5" }],
    },
    expected: "composer-2.5[fast=false]",
  },
]) {
  test(scenario.name, async (t) => {
    const fixture = createClientFixture(t, { client: scenario.client });
    const pending = fixture.track(
      fixture.client.setSessionModel("session-456", scenario.model, scenario.control),
    );
    const request = await fixture.message(0);
    assert("method" in request);
    assert.equal(request.method, "session/set_config_option");
    assert.deepEqual(request.params, {
      sessionId: "session-456",
      configId: scenario.control.configId,
      value: scenario.expected,
    });
    await fixture.reply(request, { configOptions: [] });
    await pending;
  });
}

test("AcpClient setSessionModel rejects sessions without advertised model control", async () => {
  const client = makeClient();

  await assert.rejects(
    async () => await client.setSessionModel("session-456", "GPT-5-2"),
    /did not advertise a model config option or legacy session\/set_model support/,
  );
});

test("AcpClient setSessionModel preserves explicitly advertised legacy model control", async (t) => {
  const fixture = createClientFixture(t);
  const created = fixture.track(fixture.client.createSession("/tmp/acpx-client-legacy-model"));
  const createRequest = await fixture.message(0);
  assert("method" in createRequest);
  assert.equal(createRequest.method, "session/new");
  await fixture.reply(createRequest, {
    sessionId: "legacy-session",
    models: {
      currentModelId: "default-model",
      availableModels: [
        { modelId: "default-model", name: "Default Model" },
        { modelId: "alternate-model", name: "Alternate Model" },
      ],
    },
  });
  const result = await created;
  assert.equal(result.models?.configId, undefined);
  const changed = fixture.track(
    fixture.client.setSessionModel(result.sessionId, "alternate-model"),
  );
  const request = await fixture.message(1);
  assert("method" in request);
  assert.equal(request.method, "session/set_model");
  assert.deepEqual(request.params, { sessionId: "legacy-session", modelId: "alternate-model" });
  await fixture.reply(request, {});
  await changed;
});

test("AcpClient treats explicit null config options as an empty snapshot", async (t) => {
  const fixture = createClientFixture(t);
  const pending = fixture.track(
    fixture.client.loadSession("session-null-config", "/tmp/acpx-null-config"),
  );
  const request = await fixture.message(0);
  assert("method" in request);
  assert.equal(request.method, "session/load");
  await fixture.reply(request, { configOptions: null });
  const result = await pending;
  assert.equal(result.configOptionsPresent, true);
  assert.deepEqual(result.configOptions, []);
  assert.equal(result.models, undefined);
});

test("AcpClient closes sessions through session/close and clears the loaded session id", async (t) => {
  const fixture = createClientFixture(t);
  const { client } = fixture;
  const internals = asInternals(client);
  internals.initResult = { agentCapabilities: { sessionCapabilities: { close: {} } } };
  internals.loadedSessionId = "session-close-1";
  assert.equal(client.supportsCloseSession(), true);
  const pending = fixture.track(client.closeSession("session-close-1"));
  const request = await fixture.message(0);
  assert("method" in request);
  assert.equal(request.method, "session/close");
  assert.deepEqual(request.params, { sessionId: "session-close-1" });
  await fixture.reply(request, {});
  await pending;
  assert.equal(internals.loadedSessionId, undefined);
});

test("AcpClient lists agent sessions through session/list", async (t) => {
  const fixture = createClientFixture(t);
  const { client } = fixture;
  asInternals(client).initResult = { agentCapabilities: { sessionCapabilities: { list: {} } } };
  assert.equal(client.supportsListSessions(), true);
  const pending = fixture.track(
    client.listSessions({ cwd: "/tmp/acpx-client-list", cursor: "cursor-1" }),
  );
  const request = await fixture.message(0);
  assert("method" in request);
  assert.equal(request.method, "session/list");
  assert.deepEqual(request.params, { cwd: "/tmp/acpx-client-list", cursor: "cursor-1" });
  await fixture.reply(request, {
    sessions: [
      {
        sessionId: "agent-session-1",
        cwd: "/tmp/acpx-client-list",
        title: "Agent session",
        updatedAt: "2026-05-21T00:00:00.000Z",
        _meta: { messageCount: 3 },
      },
    ],
    nextCursor: "cursor-2",
  });
  const result = await pending;
  assert.equal(result.nextCursor, "cursor-2");
  assert.equal(result.sessions[0]?.sessionId, "agent-session-1");
  assert.deepEqual(result.sessions[0]?._meta, { messageCount: 3 });
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
    internals.handleSessionUpdate?.({ sessionId: "good" }),
    internals.handleSessionUpdate?.({ sessionId: "bad" }),
  ]);
  await internals.waitForSessionUpdateDrain?.(0, 100);

  assert.deepEqual(notifications, ["good", "bad"]);
  assert.equal(internals.observedSessionUpdates, 2);
  assert.equal(internals.processedSessionUpdates, 2);

  internals.suppressSessionUpdates = true;
  await internals.handleSessionUpdate?.({ sessionId: "suppressed" });
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

  internals.recordAgentExit?.(internals.agent, "process_exit", 1, "SIGTERM");
  internals.recordAgentExit?.(internals.agent, "pipe_close", 0, null);
  const snapshot = client.getAgentLifecycleSnapshot();
  assert.equal(snapshot.pid, 4321);
  assert.equal(snapshot.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.lastExit?.reason, "process_exit");
  assert.equal(snapshot.lastExit?.unexpectedDuringPrompt, true);

  const cancelled = await client.cancelActivePrompt(50);
  assert.deepEqual(cancelled, { stopReason: "cancelled" });
});

test(
  "AcpClient coalesces cancellation until the active prompt finishes",
  { timeout: 5_000 },
  async (t) => {
    const fixture = createClientFixture(t);
    const { client } = fixture;
    const first = fixture.prompt("session-cancel", "first");
    await fixture.message(0);

    assert.deepEqual(
      await Promise.all([
        client.cancel("session-cancel"),
        client.requestCancelActivePrompt(),
        client.cancelActivePrompt(0),
      ]),
      [undefined, true, undefined],
    );
    assert.equal(await client.requestCancelActivePrompt(), true);
    assert.deepEqual(
      fixture.messages.map((message) => "method" in message && message.method),
      ["session/prompt", "session/cancel"],
    );
    await fixture.reply(await fixture.message(0));
    await first;
    assert.equal(await client.requestCancelActivePrompt(), false);
    assert.equal(await client.cancelActivePrompt(0), undefined);
    assert.equal(fixture.messages.length, 2);

    const second = fixture.prompt("session-cancel", "second");
    await fixture.message(2);
    const waiting = fixture.track(client.cancelActivePrompt(5_000));
    await fixture.message(3);
    await fixture.reply(await fixture.message(2));
    assert.deepEqual(await waiting, { stopReason: "end_turn" });
    await second;
    assert.equal(fixture.messages.length, 4);

    await client.cancel("inactive-session");
    assert.deepEqual(fixture.messages[4], {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "inactive-session" },
    });
  },
);

test(
  "AcpClient cancellation of another session leaves the active prompt available",
  { timeout: 5_000 },
  async (t) => {
    let permissionSignal: AbortSignal | undefined;
    const fixture = createClientFixture(t, {
      client: {
        onPermissionRequest: async (_request, { signal }) => {
          permissionSignal = signal;
          return { outcome: "allow_once" };
        },
      },
    });
    const { client } = fixture;
    const prompt = fixture.prompt("session-active", "hello");
    const request = await fixture.message(0);
    await fixture.permission("session-active");
    assert(permissionSignal);
    await client.cancel("session-other");
    assert.equal(client.hasActivePrompt("session-active"), true);
    assert.equal(permissionSignal.aborted, false);
    assert.deepEqual(fixture.messages[1], {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-other" },
    });

    assert.equal(await client.requestCancelActivePrompt(), true);
    assert.equal(permissionSignal.aborted, true);
    assert.deepEqual(fixture.messages[2], {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-active" },
    });
    assert.equal(fixture.messages.length, 3);
    await fixture.reply(request);
    await prompt;
  },
);

test(
  "AcpClient coalesces synchronous elicitation and permission abort reentry",
  { timeout: 5_000 },
  async (t) => {
    const reentered: Array<Promise<boolean>> = [];
    const fixture = createClientFixture(t, {
      client: {
        onPermissionRequest: async (_request, { signal }) => {
          signal.addEventListener(
            "abort",
            () => {
              reentered.push(fixture.track(fixture.client.requestCancelActivePrompt()));
            },
            { once: true },
          );
          return { outcome: "allow_once" };
        },
      },
    });
    const { client } = fixture;
    const prompt = fixture.prompt("session-reentry", "hello");
    await fixture.message(0);
    await fixture.permission("session-reentry");
    const active = asInternals(client).activePrompt;
    assert(active?.elicitationController);
    active.elicitationController.signal.addEventListener(
      "abort",
      () => {
        reentered.push(fixture.track(client.requestCancelActivePrompt()));
      },
      { once: true },
    );

    await client.cancel("session-reentry");
    assert.equal(reentered.length, 2);
    assert.deepEqual(await Promise.all(reentered), [true, true]);
    assert.deepEqual(
      fixture.messages.map((message) => "method" in message && message.method),
      ["session/prompt", "session/cancel"],
    );
    await fixture.reply(await fixture.message(0));
    await prompt;
  },
);

test(
  "AcpClient queues cancellation before an abort listener starts the next prompt",
  { timeout: 5_000 },
  async (t) => {
    const fixture = createClientFixture(t);
    const { client } = fixture;
    const first = fixture.prompt("session-next", "first");
    await fixture.message(0);
    const active = asInternals(client).activePrompt;
    assert(active?.elicitationController);
    let second: Promise<unknown> | undefined;
    active.elicitationController.signal.addEventListener(
      "abort",
      () => {
        second = fixture.prompt("session-next", "second");
      },
      { once: true },
    );

    await client.cancel("session-next");
    const secondRequest = await fixture.message(2);
    assert.deepEqual(
      fixture.messages.map((message) => "method" in message && message.method),
      ["session/prompt", "session/cancel", "session/prompt"],
    );
    assert(second);
    await fixture.reply(await fixture.message(0));
    await fixture.reply(secondRequest);
    await Promise.all([first, second]);
  },
);

test(
  "AcpClient queues a replacement prompt before abort listeners cancel its owner",
  { timeout: 5_000 },
  async (t) => {
    const releaseSecondWrite = createDeferred<void>();
    let promptsWritten = 0;
    const fixture = createClientFixture(t, {
      async write(message) {
        if ("method" in message && message.method === "session/prompt" && ++promptsWritten === 2) {
          await releaseSecondWrite.promise;
        }
      },
      release: () => releaseSecondWrite.resolve(),
    });
    const { client } = fixture;
    const first = fixture.prompt("session-replaced", "first");
    await fixture.message(0);
    const active = asInternals(client).activePrompt;
    assert(active?.elicitationController);
    let cancellation: Promise<boolean> | undefined;
    active.elicitationController.signal.addEventListener(
      "abort",
      () => {
        cancellation = fixture.track(client.requestCancelActivePrompt());
      },
      { once: true },
    );

    const second = fixture.prompt("session-replaced", "second");
    const secondRequest = await fixture.message(1);
    assert("method" in secondRequest);
    assert.equal(secondRequest.method, "session/prompt");
    assert.equal(fixture.messages.length, 2);
    assert(cancellation);
    releaseSecondWrite.resolve();
    assert.equal(await cancellation, true);
    assert.equal(await client.requestCancelActivePrompt(), true);
    assert.deepEqual(
      fixture.messages.map((message) => "method" in message && message.method),
      ["session/prompt", "session/prompt", "session/cancel"],
    );
    await fixture.reply(await fixture.message(0));
    await fixture.reply(secondRequest);
    await Promise.all([first, second]);
  },
);

test(
  "AcpClient shares a failed cancellation attempt but permits an explicit retry",
  { timeout: 5_000 },
  async (t) => {
    const attempt = createDeferred<void>();
    const called = createDeferred<void>();
    const fixture = createClientFixture(t, { release: () => attempt.resolve() });
    const { client } = fixture;
    const prompt = fixture.prompt("session-retry", "hello");
    await fixture.message(0);
    const { agent } = fixture.connection;
    const sendCancel = agent.notify.bind(agent);
    let calls = 0;
    agent.notify = (method: string, params?: unknown) => {
      assert.equal(method, "session/cancel");
      calls += 1;
      if (calls === 1) {
        called.resolve();
        return attempt.promise;
      }
      return sendCancel(method, params);
    };
    const failure = new Error("cancel was not enqueued");
    const results = fixture.track(
      Promise.allSettled([client.cancel("session-retry"), client.requestCancelActivePrompt()]),
    );
    await called.promise;
    assert.equal(calls, 1);
    attempt.reject(failure);
    for (const result of await results) {
      assert(result.status === "rejected");
      assert.equal(result.reason, failure);
    }

    assert.equal(await client.requestCancelActivePrompt(), true);
    assert.equal(await client.requestCancelActivePrompt(), true);
    assert.equal(calls, 2);
    assert.deepEqual(
      fixture.messages.map((message) => "method" in message && message.method),
      ["session/prompt", "session/cancel"],
    );
    await fixture.reply(await fixture.message(0));
    await prompt;
  },
);

test(
  "AcpClient keeps a successor cancellation when an older attempt rejects",
  { timeout: 5_000 },
  async (t) => {
    const oldAttempt = createDeferred<void>();
    const oldCalled = createDeferred<void>();
    const releaseNewSend = createDeferred<void>();
    const fixture = createClientFixture(t, {
      async write(message) {
        if ("method" in message && message.method === "session/cancel") {
          await releaseNewSend.promise;
        }
      },
      release() {
        oldAttempt.resolve();
        releaseNewSend.resolve();
      },
    });
    const { client } = fixture;
    const first = fixture.prompt("session-isolation", "first");
    await fixture.message(0);
    const { agent } = fixture.connection;
    const sendCancel = agent.notify.bind(agent);
    let calls = 0;
    agent.notify = (method: string, params?: unknown) => {
      assert.equal(method, "session/cancel");
      calls += 1;
      if (calls === 1) {
        oldCalled.resolve();
        return oldAttempt.promise;
      }
      return sendCancel(method, params);
    };
    const oldResult = fixture.track(Promise.allSettled([client.requestCancelActivePrompt()]));
    await oldCalled.promise;
    const second = fixture.prompt("session-isolation", "second");
    const secondRequest = await fixture.message(1);
    const newer = fixture.track(client.requestCancelActivePrompt());
    await fixture.message(2);
    const failure = new Error("old cancel was not enqueued");
    oldAttempt.reject(failure);
    const [result] = await oldResult;
    assert(result?.status === "rejected");
    assert.equal(result.reason, failure);
    const repeated = fixture.track(client.requestCancelActivePrompt());
    releaseNewSend.resolve();
    assert.deepEqual(await Promise.all([newer, repeated]), [true, true]);
    assert.equal(calls, 2);
    assert.deepEqual(
      fixture.messages.map((message) => "method" in message && message.method),
      ["session/prompt", "session/prompt", "session/cancel"],
    );
    await fixture.reply(await fixture.message(0));
    await fixture.reply(secondRequest);
    await Promise.all([first, second]);
  },
);

for (const mode of ["same-session-live", "same-session-cancelled", "different-session"]) {
  test(
    "AcpClient preserves successor permission ownership: " + mode,
    { timeout: 5_000 },
    async (t) => {
      const signals: AbortSignal[] = [];
      const fixture = createClientFixture(t, {
        client: {
          onPermissionRequest: async (_request, { signal }) => {
            signals.push(signal);
            return { outcome: "allow_once" };
          },
        },
      });
      const { client } = fixture;
      const first = fixture.prompt("session-old", "first");
      const firstRequest = await fixture.message(0);
      await fixture.permission("session-old");
      const nextSession = mode === "different-session" ? "session-other" : "session-old";
      const second = fixture.prompt(nextSession, "second");
      const secondRequest = await fixture.message(1);
      await fixture.permission(nextSession);
      assert.equal(signals.length, 2);
      if (mode === "same-session-cancelled") {
        await client.cancel(nextSession);
      }

      await fixture.reply(firstRequest);
      await first;
      if (mode === "same-session-cancelled") {
        assert.deepEqual(await fixture.permission(nextSession), {
          outcome: { outcome: "cancelled" },
        });
        assert.equal(signals.length, 2);
      } else {
        assert.equal(signals[1]?.aborted, false);
        assert.equal(signals[0]?.aborted, mode === "different-session");
        await client.cancel(nextSession);
        assert.equal(signals[1]?.aborted, true);
      }
      assert.deepEqual(await fixture.permission(nextSession), {
        outcome: { outcome: "cancelled" },
      });
      assert.equal(signals.length, 2);
      await fixture.reply(secondRequest);
      await second;
    },
  );
}

for (const completion of ["older", "newer"]) {
  test(
    "AcpClient preserves pending session permissions behind another active session: " + completion,
    { timeout: 5_000 },
    async (t) => {
      const permissionEntered = createDeferred<AbortSignal>();
      const releasePermission = createDeferred<void>();
      const fixture = createClientFixture(t, {
        client: {
          onPermissionRequest: async (_request, { signal }) => {
            permissionEntered.resolve(signal);
            await releasePermission.promise;
            return { outcome: "allow_once" };
          },
        },
        release: () => releasePermission.resolve(),
      });
      const first = fixture.prompt("session-overlap", "first");
      const firstRequest = await fixture.message(0);
      const second = fixture.prompt("session-overlap", "second");
      const secondRequest = await fixture.message(1);
      const permission = fixture.permission("session-overlap");
      const signal = await permissionEntered.promise;
      const third = fixture.prompt("session-other", "third");
      const thirdRequest = await fixture.message(2);
      const finishOlder = completion === "older";

      await fixture.reply(finishOlder ? firstRequest : secondRequest);
      await (finishOlder ? first : second);
      releasePermission.resolve();
      assert.deepEqual(
        await permission,
        finishOlder
          ? { outcome: { outcome: "selected", optionId: "allow" } }
          : { outcome: { outcome: "cancelled" } },
      );
      assert.equal(signal.aborted, !finishOlder);

      await fixture.reply(finishOlder ? secondRequest : firstRequest);
      await (finishOlder ? second : first);
      assert.equal(signal.aborted, true);
      await fixture.reply(thirdRequest);
      await third;
    },
  );
}

for (const phase of ["cancel", "settle"]) {
  test(
    "AcpClient detaches permission ownership before " + phase + " callbacks",
    { timeout: 5_000 },
    async (t) => {
      const signals: AbortSignal[] = [];
      const fixture = createClientFixture(t, {
        client: {
          onPermissionRequest: async (_request, { signal }) => {
            signals.push(signal);
            return { outcome: "allow_once" };
          },
        },
      });
      const { client } = fixture;
      const first = fixture.prompt("session-callback", "first");
      const firstRequest = await fixture.message(0);
      await fixture.permission("session-callback");
      const active = asInternals(client).activePrompt;
      assert(active?.elicitationController);
      let second: Promise<unknown> | undefined;
      let nextPermission: Promise<RequestPermissionResponse> | undefined;
      active.elicitationController.signal.addEventListener(
        "abort",
        () => {
          second = fixture.prompt("session-callback", "second");
          nextPermission = fixture.permission("session-callback");
        },
        { once: true },
      );

      if (phase === "cancel") {
        await client.cancel("session-callback");
      } else {
        await fixture.reply(firstRequest);
        await first;
      }
      const secondRequest = await fixture.message(phase === "cancel" ? 2 : 1);
      assert(second);
      assert(nextPermission);
      assert.deepEqual(await nextPermission, {
        outcome: { outcome: "selected", optionId: "allow" },
      });
      assert.equal(signals.length, 2);
      assert.notEqual(signals[0], signals[1]);
      assert.equal(signals[0]?.aborted, true);
      assert.equal(signals[1]?.aborted, false);
      await client.cancel("session-callback");
      assert.equal(signals[1]?.aborted, true);

      if (phase === "cancel") {
        await fixture.reply(firstRequest);
        await first;
      }
      await fixture.reply(secondRequest);
      await second;
    },
  );
}

test("AcpClient reports prompt readiness only after the transport accepts the request", async () => {
  const writeEntered = createDeferred<AnyMessage>();
  const releaseWrite = createDeferred<void>();
  const requestWritten = createDeferred<void>();
  const agentToClient = new TransformStream<AnyMessage>();
  const client = makeClient();
  connectClientToStream(client, {
    readable: agentToClient.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        writeEntered.resolve(message);
        await releaseWrite.promise;
      },
    }),
  });

  let readinessCalls = 0;
  const prompt = client.prompt("session-write-ready", "hello", () => {
    readinessCalls += 1;
    requestWritten.resolve();
  });
  const request = await writeEntered.promise;

  assert.equal(readinessCalls, 0);
  releaseWrite.resolve();
  await requestWritten.promise;
  assert.equal(readinessCalls, 1);

  await writeAgentMessage(agentToClient.writable, responseFor(request));
  assert.deepEqual(await prompt, { stopReason: "end_turn" });
});

test("AcpClient rejects a failed prompt write without reporting readiness", async () => {
  const writeEntered = createDeferred<void>();
  const failWrite = createDeferred<void>();
  const agentToClient = new TransformStream<AnyMessage>();
  const client = makeClient();
  connectClientToStream(client, {
    readable: agentToClient.readable,
    writable: new WritableStream<AnyMessage>({
      async write() {
        writeEntered.resolve();
        await failWrite.promise;
      },
    }),
  });

  let readinessCalls = 0;
  const prompt = client.prompt("session-write-failed", "hello", () => {
    readinessCalls += 1;
  });

  await writeEntered.promise;
  failWrite.reject(new Error("transport write failed"));
  await assert.rejects(prompt, /transport write failed/);
  assert.equal(readinessCalls, 0);
});

test("AcpClient keeps accepted prompts alive when the readiness observer throws", async () => {
  const writeEntered = createDeferred<AnyMessage>();
  const agentToClient = new TransformStream<AnyMessage>();
  const client = makeClient();
  connectClientToStream(client, {
    readable: agentToClient.readable,
    writable: new WritableStream<AnyMessage>({
      write(message) {
        writeEntered.resolve(message);
      },
    }),
  });

  const prompt = client.prompt("session-observer-failed", "hello", () => {
    throw new Error("observer failed");
  });
  const request = await writeEntered.promise;
  await writeAgentMessage(agentToClient.writable, responseFor(request));

  assert.deepEqual(await prompt, { stopReason: "end_turn" });
});

test("AcpClient keeps a queued prompt unready until its own transport write succeeds", async () => {
  const firstWriteEntered = createDeferred<AnyMessage>();
  const secondWriteEntered = createDeferred<AnyMessage>();
  const releaseFirstWrite = createDeferred<void>();
  const releaseSecondWrite = createDeferred<void>();
  const firstRequestWritten = createDeferred<void>();
  const secondRequestWritten = createDeferred<void>();
  const agentToClient = new TransformStream<AnyMessage>();
  const client = makeClient();
  let writeCount = 0;
  connectClientToStream(client, {
    readable: agentToClient.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteEntered.resolve(message);
          await releaseFirstWrite.promise;
          return;
        }
        secondWriteEntered.resolve(message);
        await releaseSecondWrite.promise;
      },
    }),
  });

  let secondReadinessCalls = 0;
  const firstPrompt = client.prompt("session-queued", "first", () => {
    firstRequestWritten.resolve();
  });
  const secondPrompt = client.prompt("session-queued", "second", () => {
    secondReadinessCalls += 1;
    secondRequestWritten.resolve();
  });

  const firstRequest = await firstWriteEntered.promise;
  assert.equal(writeCount, 1);
  assert.equal(secondReadinessCalls, 0);

  releaseFirstWrite.resolve();
  await firstRequestWritten.promise;
  const secondRequest = await secondWriteEntered.promise;
  assert.equal(secondReadinessCalls, 0);

  await writeAgentMessage(agentToClient.writable, responseFor(firstRequest));
  releaseSecondWrite.resolve();
  await secondRequestWritten.promise;
  assert.equal(secondReadinessCalls, 1);
  await writeAgentMessage(agentToClient.writable, responseFor(secondRequest));

  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
});

test("AcpClient rejects rich prompt content not advertised by promptCapabilities", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let promptCalled = false;
  internals.initResult = {
    agentCapabilities: {
      promptCapabilities: {
        image: true,
      },
    },
  };
  internals.connection = {
    agent: {
      request: async () => {
        promptCalled = true;
        return { stopReason: "end_turn" };
      },
    },
  };

  await assert.rejects(
    async () =>
      await client.prompt("session-audio", [
        { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
      ]),
    (error: unknown) =>
      error instanceof UnsupportedPromptContentError &&
      error.message.includes("promptCapabilities.audio"),
  );
  assert.equal(promptCalled, false);
});

test("AcpClient sends audio prompts when the agent advertises audio support", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let capturedPrompt: unknown;
  internals.initResult = {
    agentCapabilities: {
      promptCapabilities: {
        audio: true,
      },
    },
  };
  internals.connection = {
    agent: {
      request: async (_method: string, params: { prompt: unknown }) => {
        capturedPrompt = params.prompt;
        return { stopReason: "end_turn" };
      },
    },
  };

  await client.prompt("session-audio", [
    { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
  ]);

  assert.deepEqual(capturedPrompt, [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }]);
});

test("AcpClient does not infer prompt readiness from connection promise creation", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let resolvePrompt!: (value: { stopReason: "end_turn" }) => void;
  const promptResponse = new Promise<{ stopReason: "end_turn" }>((resolve) => {
    resolvePrompt = resolve;
  });
  let reported = false;
  internals.connection = {
    agent: { request: () => promptResponse },
  };

  const pending = client.prompt("session-start", "hello", () => {
    reported = true;
  });
  await Promise.resolve();

  assert.equal(reported, false);
  assert.equal(client.hasActivePrompt(), true);
  resolvePrompt({ stopReason: "end_turn" });
  assert.deepEqual(await pending, { stopReason: "end_turn" });
  assert.equal(reported, false);
});

test("AcpClient does not report prompt readiness when request creation throws", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let reported = false;
  internals.connection = {
    agent: {
      request: () => {
        throw new Error("request creation failed");
      },
    },
  };

  await assert.rejects(
    client.prompt("session-start-failure", "hello", () => {
      reported = true;
    }),
    /request creation failed/,
  );

  assert.equal(reported, false);
});

test("AcpClient does not report prompt readiness when the connection is already closed", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let reported = false;
  const failure = new Error("ACP connection closed");
  internals.connection = {
    signal: AbortSignal.abort(failure),
    agent: { request: () => Promise.reject(failure) },
  };

  await assert.rejects(
    client.prompt("session-closed-before-start", "hello", () => {
      reported = true;
    }),
    failure,
  );

  assert.equal(reported, false);
});

test("AcpClient does not submit a prompt after agent exit settles the queued request", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  let promptCalls = 0;
  let reported = false;
  internals.connection = {
    agent: {
      request: async () => {
        promptCalls += 1;
        return { stopReason: "end_turn" as const };
      },
    },
  };

  const pending = client.prompt("session-exited-before-start", "hello", () => {
    reported = true;
  });
  internals.recordAgentExit?.(internals.agent, "connection_close", null, null);

  await assert.rejects(pending, AgentDisconnectedError);
  await Promise.resolve();
  assert.equal(promptCalls, 0);
  assert.equal(reported, false);
});

test("AcpClient does not report prompt readiness when the connection closes during request creation", async () => {
  const client = makeClient();
  const internals = asInternals(client);
  const connection = new AbortController();
  let reported = false;
  internals.connection = {
    signal: connection.signal,
    agent: {
      request: () => {
        connection.abort(new Error("closed after request creation began"));
        return Promise.resolve({ stopReason: "end_turn" });
      },
    },
  };

  await client.prompt("session-close-during-start", "hello", () => {
    reported = true;
  });

  assert.equal(reported, false);
});

test("AcpClient prompt rejects when the agent disconnects mid-prompt", async () => {
  const client = makeClient();
  const internals = asInternals(client);

  internals.connection = {
    agent: { request: async () => await new Promise(() => {}) },
  };

  const pending = client.prompt("session-5", "sleep 60000");
  internals.recordAgentExit?.(internals.agent, "connection_close", null, null);

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

test("AcpClient reports ordered process lifecycle events to embedding hosts", async () => {
  const observed: string[] = [];
  let launchId: string | undefined;
  let pid: number | undefined;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const client = makeClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, path.join(process.cwd(), "dist-test", "test", "mock-agent.js")],
    processLaunchScope: { kind: "runtime-session", sessionKey: "lease-session" },
    processLifecycle: {
      onBeforeSpawn: (launch) => {
        observed.push("before");
        launchId = launch.launchId;
        assert.equal(Object.isFrozen(launch), true);
        assert.equal(Object.isFrozen(launch.args), true);
        assert.deepEqual(launch.scope, {
          kind: "runtime-session",
          sessionKey: "lease-session",
        });
        assert.equal(launch.cwd, process.cwd());
        assert(launch.command.length > 0);
      },
      onSpawned: (started) => {
        observed.push("spawned");
        assert.equal(started.launchId, launchId);
        assert.equal(Object.isFrozen(started), true);
        assert(Number.isInteger(started.pid));
        assert(started.startedAt.length > 0);
        pid = started.pid;
      },
      onSpawnFailed: () => {
        assert.fail("spawn should succeed");
      },
      onExit: (exit) => {
        observed.push("exit");
        assert.equal(exit.launchId, launchId);
        assert.equal(exit.pid, pid);
        assert(exit.exitedAt.length > 0);
        resolveExit?.();
      },
    },
  });

  await client.start();
  await client.close();
  await exited;

  assert.deepEqual(observed, ["before", "spawned", "exit"]);
});

test("AcpClient aborts before spawn when lifecycle admission fails", async () => {
  const admissionError = new Error("lease persistence failed");
  let spawned = false;
  const client = makeClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, path.join(process.cwd(), "dist-test", "test", "mock-agent.js")],
    processLifecycle: {
      onBeforeSpawn: async () => {
        throw admissionError;
      },
      onSpawned: () => {
        spawned = true;
      },
    },
  });

  await assert.rejects(
    () => client.start(),
    (error: unknown) => {
      assert.equal(error, admissionError);
      return true;
    },
  );
  assert.equal(spawned, false);
});

test("AcpClient correlates spawn failures with the prepared launch", async () => {
  let launchId: string | undefined;
  let failureLaunchId: string | undefined;
  let observedFailure: unknown;
  let exited = false;
  const client = makeClient({
    agentCommand: "acpx-test-missing-agent",
    agentArgv: ["acpx-test-missing-agent"],
    processLifecycle: {
      onBeforeSpawn: (launch) => {
        launchId = launch.launchId;
      },
      onSpawnFailed: (failure) => {
        failureLaunchId = failure.launchId;
        observedFailure = failure.error;
        assert(failure.failedAt.length > 0);
      },
      onExit: () => {
        exited = true;
      },
    },
  });

  await assert.rejects(
    () => client.start(),
    (error: unknown) => {
      assert(error instanceof AgentSpawnError);
      assert.equal(error, observedFailure);
      return true;
    },
  );
  assert.equal(failureLaunchId, launchId);
  assert.equal(exited, false);
});

test("AcpClient does not await non-settling spawn failure observers", async () => {
  let observerCalled = false;
  const client = makeClient({
    agentCommand: "acpx-test-missing-agent",
    agentArgv: ["acpx-test-missing-agent"],
    processLifecycle: {
      onSpawnFailed: () => {
        observerCalled = true;
        return new Promise<void>(() => {});
      },
    },
  });

  const result = await Promise.race([
    client.start().then(
      () => ({ type: "resolved" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    ),
    new Promise<{ type: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ type: "timeout" }), 100);
    }),
  ]);

  assert.equal(observerCalled, true);
  assert.equal(result.type, "rejected");
  assert(result.error instanceof AgentSpawnError);
});

test("AcpClient terminates a spawned process when spawned admission fails", async () => {
  const admissionError = new Error("spawned lease persistence failed");
  let spawnedPid: number | undefined;
  let exitedPid: number | undefined;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const client = makeClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, path.join(process.cwd(), "dist-test", "test", "mock-agent.js")],
    processLifecycle: {
      onSpawned: (started) => {
        spawnedPid = started.pid;
        throw admissionError;
      },
      onExit: (exit) => {
        exitedPid = exit.pid;
        resolveExit?.();
      },
    },
  });

  await assert.rejects(
    () => client.start(),
    (error: unknown) => {
      assert.equal(error, admissionError);
      return true;
    },
  );
  await exited;

  assert.equal(exitedPid, spawnedPid);
});

test("AcpClient reports an early exit after spawned admission settles", async () => {
  const admissionError = new Error("spawned lease persistence failed");
  const observed: string[] = [];
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const client = makeClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, path.join(process.cwd(), "dist-test", "test", "mock-agent.js")],
    processLifecycle: {
      onSpawned: async (started) => {
        observed.push("spawned:start");
        process.kill(started.pid);
        await new Promise((resolve) => setTimeout(resolve, 100));
        observed.push("spawned:end");
        throw admissionError;
      },
      onExit: () => {
        observed.push("exit");
        resolveExit?.();
      },
    },
  });

  await assert.rejects(
    () => client.start(),
    (error: unknown) => {
      assert.equal(error, admissionError);
      return true;
    },
  );
  await exited;

  assert.deepEqual(observed, ["spawned:start", "spawned:end", "exit"]);
});

test("AcpClient rejects when the agent exits during successful spawned admission", async () => {
  const stderrLine = "exited during spawned admission";
  const observed: string[] = [];
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const client = makeClient({
    agentCommand: process.execPath,
    agentArgv: [
      process.execPath,
      "--eval",
      `setTimeout(() => {
        process.stderr.write(${JSON.stringify(`${stderrLine}\n`)});
        process.exit(17);
      }, 20);`,
    ],
    processLifecycle: {
      onSpawned: async () => {
        observed.push("spawned:start");
        await new Promise((resolve) => setTimeout(resolve, 100));
        observed.push("spawned:end");
      },
      onExit: () => {
        observed.push("exit");
        resolveExit?.();
      },
    },
  });

  const result = await Promise.race([
    client.start().then(
      () => ({ type: "resolved" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    ),
    new Promise<{ type: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ type: "timeout" }), 2_000);
    }),
  ]);

  assert.equal(result.type, "rejected");
  assert(result.error instanceof AgentStartupError);
  assert.equal(result.error.exitCode, 17);
  assert.equal(result.error.signal, null);
  assert.match(result.error.message, /exited during spawned admission/);
  await exited;
  assert.deepEqual(observed, ["spawned:start", "spawned:end", "exit"]);
});

test("AcpClient reports a prior launch exit without invalidating the current launch", async (t) => {
  const observed: Array<{ exitCode: number | null; signal: NodeJS.Signals | null }> = [];
  const client = makeClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, path.join(process.cwd(), "dist-test", "test", "mock-agent.js")],
    processLifecycle: {
      onExit: ({ exitCode, signal }) => {
        observed.push({ exitCode, signal });
      },
    },
  });
  t.after(async () => await client.close());
  const child = spawn(process.execPath, ["--eval", "process.exit(17)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  assert.equal(child.exitCode, 17);
  await client.start();

  const startedProcess: AcpProcessStarted = Object.freeze({
    launchId: "already-exited-launch",
    scope: Object.freeze({ kind: "client" }),
    command: process.execPath,
    args: Object.freeze(["--eval", "process.exit(17)"]),
    cwd: process.cwd(),
    pid: child.pid!,
    startedAt: new Date().toISOString(),
  });
  const internals = asInternals(client);
  internals.attachAgentLifecycleObservers?.(child, startedProcess, Promise.resolve());
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(observed, [{ exitCode: 17, signal: null }]);
  assert.equal(client.getAgentLifecycleSnapshot().lastExit, undefined);
  assert.equal(client.getAgentLifecycleSnapshot().running, true);
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
  internals.connection = { close: () => {} };
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createClientFixture(
  t: TestContext,
  options: {
    client?: Partial<ConstructorParameters<typeof AcpClient>[0]>;
    write?: (message: AnyMessage) => Promise<void> | void;
    release?: () => void;
  } = {},
) {
  const client = makeClient(options.client);
  const incoming = new TransformStream<AnyMessage>();
  const messages: AnyMessage[] = [];
  const written: Array<Deferred<AnyMessage>> = [];
  const pending: Array<Promise<unknown>> = [];
  const message = (index: number) => (written[index] ??= createDeferred<AnyMessage>()).promise;
  function track<T>(operation: Promise<T>): Promise<T> {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }
  const connection = connectClientToStream(client, {
    readable: incoming.readable,
    writable: new WritableStream<AnyMessage>({
      async write(value) {
        const index = messages.push(value) - 1;
        void message(index);
        written[index].resolve(value);
        await options.write?.(value);
      },
    }),
  });
  t.after(async () => {
    options.release?.();
    try {
      await incoming.writable.close();
    } finally {
      await client.close();
      await Promise.allSettled(pending);
    }
  });
  return {
    client,
    connection,
    messages,
    message,
    track,
    send(value: AnyMessage) {
      return writeAgentMessage(incoming.writable, value);
    },
    prompt(sessionId: string, text: string) {
      return track(client.prompt(sessionId, text));
    },
    permission(sessionId: string) {
      const handler = asInternals(client).handlePermissionRequest;
      assert(handler);
      return track(handler.call(client, makePermissionRequest(sessionId, "edit")));
    },
    reply(request: AnyMessage, result?: Record<string, unknown>) {
      return writeAgentMessage(incoming.writable, responseFor(request, result));
    },
  };
}

function connectClientToStream(
  client: AcpClient,
  base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  },
): ClientConnection {
  const internals = asInternals(client);
  const tapped = internals.createTappedStream?.(base);
  assert(tapped);
  const connection = internals.createConnection?.(
    tapped,
    { devinAcp: false },
    {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  );
  assert(connection);
  internals.connection = connection;
  return connection;
}

function responseFor(
  request: AnyMessage,
  result: Record<string, unknown> = { stopReason: "end_turn" },
): AnyMessage {
  assert("id" in request);
  return {
    jsonrpc: "2.0",
    id: request.id,
    result,
  };
}

async function writeAgentMessage(
  writable: WritableStream<AnyMessage>,
  message: AnyMessage,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(message);
  } finally {
    writer.releaseLock();
  }
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

test("host permission decisions release their abort listeners after settlement", async () => {
  let signal: AbortSignal | undefined;
  const client = makeClient({
    onPermissionRequest: async (_request, context) => {
      signal = context.signal;
      return { outcome: "allow_once" };
    },
  });
  for (let index = 0; index < 3; index++) {
    await asInternals(client).handlePermissionRequest?.(
      makePermissionRequest("idle-permissions", "edit"),
    );
  }
  assert.ok(signal);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
