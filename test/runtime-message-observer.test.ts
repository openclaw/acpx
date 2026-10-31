import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createSharedAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpJsonRpcMessage,
  type AcpMessageDirection,
  type AcpRuntimeOptions,
} from "../src/runtime.js";

const AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

for (const method of [
  "session/set_mode",
  "session/set_config_option",
  "session/set_model",
  "session/close",
] as const) {
  test(`runtime observes cold ${method} exchanges without observing health probes`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-cold-observer-"));
    const observed: Array<{ direction: AcpMessageDirection; message: AcpJsonRpcMessage }> = [];
    const options: AcpRuntimeOptions = {
      cwd,
      sessionStore: createFileSessionStore({ stateDir: path.join(cwd, "state") }),
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [
            process.execPath,
            AGENT,
            "--supports-load-session",
            "--supports-close-session",
            ...(method === "session/set_model"
              ? ["--advertise-legacy-models"]
              : ["--advertise-config-options"]),
          ],
        },
      }),
      permissionMode: "deny-all",
      probeAgent: "fixture",
      onAcpMessage: (direction, message) => observed.push({ direction, message }),
    };
    const first = createAcpRuntime(options);
    const runtime = createAcpRuntime(options);
    t.after(async () => {
      await Promise.all([first.shutdown(), runtime.shutdown()]);
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const handle = await first.ensureSession({
      sessionKey: "cold-observer",
      agent: "fixture",
      mode: "persistent",
    });
    await first.shutdown();
    observed.length = 0;
    assert.equal((await runtime.doctor()).ok, true);
    assert.equal(observed.length, 0);

    if (method === "session/set_mode") {
      await runtime.setMode({ handle, mode: "plan" });
    } else if (method === "session/set_config_option") {
      await runtime.setConfigOption({ handle, key: "reasoning_effort", value: "high" });
    } else if (method === "session/set_model") {
      await runtime.setModel({ handle, model: "alternate-model" });
    } else {
      await runtime.close({ handle, reason: "discard", discardPersistentState: true });
    }

    for (const expected of [
      "initialize",
      ...(method === "session/close" ? [] : ["session/load"]),
      method,
    ]) {
      const request = observed.find(
        ({ direction, message }) =>
          direction === "outbound" && "method" in message && message.method === expected,
      )?.message;
      assert(request && "id" in request, `missing outbound ${expected}`);
      assert(
        observed.some(
          ({ direction, message }) =>
            direction === "inbound" && "result" in message && message.id === request.id,
        ),
        `missing response to ${expected}`,
      );
    }
  });
}

test("runtime observes setup and reconnects while filtering elicitation payloads", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-observer-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const observed: Array<{ direction: AcpMessageDirection; message: AcpJsonRpcMessage }> = [];
  const options: AcpRuntimeOptions = {
    cwd,
    sessionStore: createFileSessionStore({ stateDir: path.join(cwd, "state") }),
    agentRegistry: createAgentRegistry({
      overrides: { fixture: [process.execPath, AGENT, "--supports-load-session"] },
    }),
    permissionMode: "deny-all",
    elicitationModes: ["form"],
    onAcpMessage: (direction, message) => {
      observed.push({ direction, message });
    },
  };
  const first = createAcpRuntime(options);
  t.after(() => first.shutdown());
  const handle = await first.ensureSession({
    sessionKey: "observe",
    agent: "fixture",
    mode: "persistent",
  });
  assert(
    observed.some(
      ({ direction, message }) =>
        direction === "outbound" && "method" in message && message.method === "initialize",
    ),
  );
  assert(observed.some(({ message }) => "method" in message && message.method === "session/new"));
  await first.shutdown();

  observed.length = 0;
  const runtime = createAcpRuntime(options);
  t.after(() => runtime.shutdown());
  let elicitationId: string | number | null | undefined;
  const turn = runtime.startTurn({
    handle,
    text: "elicitation form",
    mode: "prompt",
    requestId: "observe-question",
    onElicitation: async (_request, context) => {
      elicitationId = context.requestId;
      return { action: "accept", content: { answer: "private-answer" } };
    },
  });
  const events = [];
  for await (const event of turn.events) {
    events.push(event);
  }
  assert.equal((await turn.result).status, "completed");
  assert.notEqual(elicitationId, undefined);
  for (const method of ["initialize", "session/load", "session/prompt", "session/update"]) {
    assert(
      observed.some(({ message }) => "method" in message && message.method === method),
      method,
    );
  }
  assert(observed.some(({ direction, message }) => direction === "inbound" && "result" in message));
  assert(
    !observed.some(({ message }) => "method" in message && message.method === "elicitation/create"),
  );
  assert(
    !observed.some(
      ({ direction, message }) =>
        direction === "outbound" &&
        "id" in message &&
        !("method" in message) &&
        message.id === elicitationId,
    ),
  );
  assert(
    events.some((event) => event.type === "text_delta" && event.text.includes("private-answer")),
  );
});

for (const failure of ["sync", "async"] as const) {
  test(`runtime ignores ${failure} observer failures`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-observer-errors-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    let calls = 0;
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: createFileSessionStore({ stateDir: path.join(cwd, "state") }),
      agentRegistry: createAgentRegistry({ overrides: { fixture: [process.execPath, AGENT] } }),
      permissionMode: "deny-all",
      onAcpMessage: () => {
        calls += 1;
        if (failure === "sync") {
          throw new Error("observer failed");
        }
        return Promise.reject(new Error("observer failed"));
      },
    });
    t.after(() => runtime.shutdown());
    const handle = await runtime.ensureSession({
      sessionKey: "observe",
      agent: "fixture",
      mode: "persistent",
    });
    const turn = runtime.startTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "observer-errors",
    });
    for await (const event of turn.events) {
      assert(event.type);
    }
    assert.equal((await turn.result).status, "completed");
    assert(calls > 0);
  });
}

test("shared runtimes reject an in-process wire observer", () => {
  assert.throws(
    () =>
      createSharedAcpRuntime({
        cwd: process.cwd(),
        permissionMode: "deny-all",
        onAcpMessage: () => {},
      } as never),
    /onAcpMessage belongs to the in-process runtime/,
  );
});
