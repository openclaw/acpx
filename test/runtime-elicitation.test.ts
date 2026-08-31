import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AnyMessage, JsonRpcId } from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.js";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpElicitationHandler,
  type AcpElicitationResponse,
  type AcpRuntimeOptions,
  type AcpRuntimeTurnInput,
  type AcpRuntimeEvent,
} from "../src/runtime.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type ExpectedElicitationHandler = AcpElicitationHandler;

type RuntimeOptionsWithElicitation = AcpRuntimeOptions & {
  elicitationModes?: readonly ("form" | "url")[];
};

type TurnInputWithElicitation = AcpRuntimeTurnInput & {
  onElicitation?: ExpectedElicitationHandler;
};

async function withRuntime(
  modes: readonly ("form" | "url")[] | undefined,
  run: (context: {
    runtime: ReturnType<typeof createAcpRuntime>;
    handle: Awaited<ReturnType<ReturnType<typeof createAcpRuntime>["ensureSession"]>>;
  }) => Promise<void>,
  mockAgentArgs: string[] = [],
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-elicitation-"));
  const options: RuntimeOptionsWithElicitation = {
    cwd: rootDir,
    sessionStore: createFileSessionStore({ stateDir: path.join(rootDir, "state") }),
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [process.execPath, MOCK_AGENT_PATH, "--supports-close-session", ...mockAgentArgs],
      },
    }),
    permissionMode: "approve-reads",
    ...(modes ? { elicitationModes: modes } : {}),
  };
  const runtime = createAcpRuntime(options);
  const handle = await runtime.ensureSession({
    sessionKey: "elicitation-test",
    agent: "fixture",
    mode: "persistent",
  });
  try {
    await run({ runtime, handle });
  } finally {
    await runtime.close({ handle, reason: "test complete", discardPersistentState: true });
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function runTurn(
  runtime: ReturnType<typeof createAcpRuntime>,
  input: TurnInputWithElicitation,
): Promise<{ text: string; status: string }> {
  const turn = runtime.startTurn(input);
  const events: AcpRuntimeEvent[] = [];
  for await (const event of turn.events) {
    events.push(event);
  }
  const result = await turn.result;
  const text = events
    .filter((event): event is Extract<AcpRuntimeEvent, { type: "text_delta" }> => {
      return event.type === "text_delta";
    })
    .map((event) => event.text)
    .join("");
  return { text, status: result.status };
}

function turnInput(
  handle: TurnInputWithElicitation["handle"],
  text: string,
  onElicitation?: ExpectedElicitationHandler,
): TurnInputWithElicitation {
  return {
    handle,
    text,
    mode: "prompt",
    requestId: `request-${text}`,
    ...(onElicitation ? { onElicitation } : {}),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("runtime advertises only configured elicitation modes", async () => {
  await withRuntime(undefined, async ({ runtime, handle }) => {
    const result = await runTurn(runtime, turnInput(handle, "client-capabilities"));
    const capabilities = JSON.parse(result.text) as { elicitation?: unknown };
    assert.equal(capabilities.elicitation, undefined);
  });

  await withRuntime(["form", "url"], async ({ runtime, handle }) => {
    const result = await runTurn(runtime, turnInput(handle, "client-capabilities"));
    const capabilities = JSON.parse(result.text) as { elicitation?: unknown };
    assert.deepEqual(capabilities.elicitation, { form: {}, url: {} });
  });
});

test("runtime routes form elicitation context and known responses", async (t) => {
  await withRuntime(["form"], async ({ runtime, handle }) => {
    for (const response of [
      { action: "accept", content: { answer: "yes" } },
      { action: "decline" },
      { action: "cancel" },
    ] satisfies AcpElicitationResponse[]) {
      await t.test(response.action, async () => {
        let seenRequestId: JsonRpcId | undefined;
        const result = await runTurn(
          runtime,
          turnInput(handle, "elicitation form", async (request, context) => {
            seenRequestId = context.requestId;
            assert.equal(context.signal.aborted, false);
            assert.equal(request.mode, "form");
            assert.equal(
              "sessionId" in request ? request.sessionId : undefined,
              handle.backendSessionId,
            );
            assert.equal("toolCallId" in request ? request.toolCallId : undefined, "tool-123");
            return response;
          }),
        );
        assert.equal(result.status, "completed");
        assert.deepEqual(JSON.parse(result.text), response);
        assert.notEqual(seenRequestId, undefined);
      });
    }
  });
});

test("runtime routes request-scoped elicitation owned by the active prompt", async () => {
  await withRuntime(["form"], async ({ runtime, handle }) => {
    let promptRequestId: JsonRpcId | undefined;
    let elicitationRequestId: JsonRpcId | undefined;
    const result = await runTurn(
      runtime,
      turnInput(handle, "elicitation request-scoped", async (request, context) => {
        const scopedId = "requestId" in request ? request.requestId : undefined;
        if (scopedId === null || typeof scopedId === "string" || typeof scopedId === "number") {
          promptRequestId = scopedId;
        }
        elicitationRequestId = context.requestId;
        return { action: "decline" };
      }),
    );
    assert.deepEqual(JSON.parse(result.text), { action: "decline" });
    assert.notEqual(promptRequestId, undefined);
    assert.notEqual(elicitationRequestId, undefined);
    assert.notEqual(promptRequestId, elicitationRequestId);
  });
});

test("runtime combines exact request and session cancellation signals", async () => {
  await withRuntime(["form"], async ({ runtime, handle }) => {
    let exactSignalAborted = false;
    const requestCancelled = await runTurn(
      runtime,
      turnInput(handle, "elicitation request-cancel", async (_request, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        exactSignalAborted = context.signal.aborted;
        return { action: "accept", content: { ignored: true } };
      }),
    );
    assert.equal(await waitFor(() => exactSignalAborted), true);
    assert.match(requestCancelled.text, /"action":"cancel"/);
    assert.match(requestCancelled.text, /aborted:true/);

    let turnSignalAborted = false;
    const turn = runtime.startTurn(
      turnInput(handle, "elicitation form", async (_request, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        turnSignalAborted = context.signal.aborted;
        return { action: "accept", content: { ignored: true } };
      }),
    );
    await turn.promptStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await turn.cancel();
    for await (const event of turn.events) {
      void event;
    }
    await turn.result;
    assert.equal(await waitFor(() => turnSignalAborted), true);
  });
});

test("runtime suppresses stale handler resolutions after prompt completion", async () => {
  await withRuntime(["form"], async ({ runtime, handle }) => {
    let resolveHandler!: (response: AcpElicitationResponse) => void;
    let handlerStarted = false;
    const handlerResponse = new Promise<AcpElicitationResponse>((resolve) => {
      resolveHandler = resolve;
    });
    const dispatched = await runTurn(
      runtime,
      turnInput(handle, "elicitation late", async () => {
        handlerStarted = true;
        return await handlerResponse;
      }),
    );
    assert.equal(dispatched.status, "completed");
    assert.equal(await waitFor(() => handlerStarted), true);
    resolveHandler({ action: "accept", content: { stale: true } });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const observed = await runTurn(runtime, turnInput(handle, "elicitation last-response"));
    assert.deepEqual(JSON.parse(observed.text), {
      action: "cancel",
      _meta: { message: "elicitation owner is no longer active" },
    });
  });
});

test("runtime aborts the elicitation owner when a turn times out", async () => {
  await withRuntime(
    ["form"],
    async ({ runtime, handle }) => {
      let resolveHandler!: (response: AcpElicitationResponse) => void;
      let handlerStarted = false;
      let handlerAborted = false;
      const handlerResponse = new Promise<AcpElicitationResponse>((resolve) => {
        resolveHandler = resolve;
      });
      const timedOut = await runTurn(runtime, {
        ...turnInput(handle, "elicitation timeout-late", async (_request, context) => {
          handlerStarted = true;
          context.signal.addEventListener(
            "abort",
            () => {
              handlerAborted = true;
            },
            { once: true },
          );
          return await handlerResponse;
        }),
        timeoutMs: 50,
      });
      assert.equal(timedOut.status, "failed");
      assert.equal(handlerStarted, true);
      assert.equal(await waitFor(() => handlerAborted), true);

      resolveHandler({ action: "accept", content: { stale: true } });
      const nextTurn = await runTurn(runtime, turnInput(handle, "echo after timeout"));
      assert.deepEqual(nextTurn, { status: "completed", text: "after timeout" });
    },
    ["--supports-load-session"],
  );
});

test("runtime explicitly cancels unsupported or unauthorised elicitations", async () => {
  await withRuntime(["form"], async ({ runtime, handle }) => {
    const cases = [
      ["elicitation form", "elicitation handler is unavailable", false],
      ["elicitation mismatched-session", "elicitation session is not active", true],
      ["elicitation custom-mode", "elicitation mode is not supported", true],
    ] as const;
    for (const [prompt, message, passHandler] of cases) {
      const result = await runTurn(
        runtime,
        turnInput(
          handle,
          prompt,
          passHandler
            ? async () => {
                assert.fail("handler must not run");
              }
            : undefined,
        ),
      );
      assert.deepEqual(JSON.parse(result.text), {
        action: "cancel",
        _meta: { message },
      });
    }

    const failed = await runTurn(
      runtime,
      turnInput(handle, "elicitation form", async () => {
        throw new Error("host UI failed with private form data");
      }),
    );
    assert.deepEqual(JSON.parse(failed.text), {
      action: "cancel",
      _meta: { message: "elicitation handler is unavailable" },
    });
  });
});

test("runtime cancels request-scoped elicitation without an active owner", async () => {
  await withRuntime(
    ["form"],
    async ({ runtime, handle }) => {
      const observed = await runTurn(runtime, turnInput(handle, "elicitation last-response"));
      assert.deepEqual(JSON.parse(observed.text), {
        action: "cancel",
        _meta: { message: "elicitation owner is no longer active" },
      });
    },
    ["--elicit-on-new-session"],
  );
});

test("runtime accepts elicitation complete notifications", async () => {
  await withRuntime(["url"], async ({ runtime, handle }) => {
    const result = await runTurn(runtime, turnInput(handle, "elicitation complete"));
    assert.equal(result.status, "completed");
    assert.equal(result.text, "elicitation complete accepted");
  });
});

test("client taps omit elicitation forms and answers", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-elicitation-tap-"));
  const tapped: AnyMessage[] = [];
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, MOCK_AGENT_PATH],
    cwd: rootDir,
    permissionMode: "approve-reads",
    elicitationModes: ["form"],
    onAcpMessage: (_direction, message) => tapped.push(message),
  });
  try {
    await client.start();
    const session = await client.createSession();
    await client.prompt(session.sessionId, "elicitation form-no-echo", undefined, async () => ({
      action: "accept",
      content: { answer: "sensitive-answer" },
    }));
    await client.cancel(session.sessionId);
    let postCancelHandled = false;
    await client.prompt(session.sessionId, "elicitation form-no-echo", undefined, async () => {
      postCancelHandled = true;
      return { action: "accept", content: { answer: "after-idle-cancel" } };
    });
    assert.equal(postCancelHandled, true);
    await client.prompt(
      session.sessionId,
      "elicitation request-cancel",
      undefined,
      async (_request, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { action: "cancel" };
      },
    );
  } finally {
    await client.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }

  const serialized = JSON.stringify(tapped);
  assert.doesNotMatch(serialized, /Choose a value/);
  assert.doesNotMatch(serialized, /sensitive-answer/);
  assert.doesNotMatch(serialized, /after-idle-cancel/);
  assert.equal(
    tapped.some((message) => "method" in message && message.method === "$/cancel_request"),
    true,
  );
});
