import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import { classifyPermissionDecision, resolvePermissionRequest } from "../src/permissions.js";
import { withMockedReadline, withTtyState } from "./tty-test-helpers.js";

const BASE_OPTIONS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "reject", kind: "reject_once" },
] as const;

type PermissionChoice = {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

function makeRequest(kind: RequestPermissionRequest["toolCall"]["kind"]): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind,
      title: "tool call",
    },
    options: BASE_OPTIONS.map((option) => ({ ...option })),
  } as RequestPermissionRequest;
}

function makeRequestWithTitle(
  title: string | undefined,
  kind: RequestPermissionRequest["toolCall"]["kind"] = undefined,
  options: PermissionChoice[] = BASE_OPTIONS.map((option) => ({ ...option })),
): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind,
      title,
    },
    options: options.map((option) => ({ ...option })),
  } as RequestPermissionRequest;
}

function withNonTty<T>(run: () => Promise<T>): Promise<T> {
  return withTtyState({ stdin: false, stderr: false }, run);
}

test("approve-all approves everything", async () => {
  const request = makeRequest("execute");
  const response = await resolvePermissionRequest(request, "approve-all");
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow" } });
});

test("deny-all denies everything", async () => {
  const request = makeRequest("execute");
  const response = await resolvePermissionRequest(request, "deny-all");
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "reject" } });
});

test("approve-reads approves reads and denies writes", async () => {
  await withNonTty(async () => {
    const readResponse = await resolvePermissionRequest(makeRequest("read"), "approve-reads");
    assert.deepEqual(readResponse, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const writeResponse = await resolvePermissionRequest(makeRequest("edit"), "approve-reads");
    assert.deepEqual(writeResponse, {
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });
});

test("non-interactive policy fail throws when prompt is required", async () => {
  await withNonTty(async () => {
    await assert.rejects(
      async () => await resolvePermissionRequest(makeRequest("edit"), "approve-reads", "fail"),
      PermissionPromptUnavailableError,
    );
  });
});

test("approve-all falls back to the first option when no allow option exists", async () => {
  const response = await resolvePermissionRequest(
    makeRequestWithTitle("tool", "execute", [{ optionId: "custom", kind: "reject_once" }]),
    "approve-all",
  );

  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "custom" } });
});

test("deny-all cancels when no reject option exists", async () => {
  const response = await resolvePermissionRequest(
    makeRequestWithTitle("tool", "execute", [{ optionId: "allow", kind: "allow_once" }]),
    "deny-all",
  );

  assert.deepEqual(response, { outcome: { outcome: "cancelled" } });
});

test("approve-reads infers read-like titles without an explicit tool kind", async () => {
  await withNonTty(async () => {
    for (const title of ["cat: README.md", "grep: TODO", "search: prompts"]) {
      const response = await resolvePermissionRequest(
        makeRequestWithTitle(title, undefined),
        "approve-reads",
      );

      assert.deepEqual(response, {
        outcome: { outcome: "selected", optionId: "allow" },
      });
    }
  });
});

test("approve-reads rejects non-read title inference when prompting is unavailable", async () => {
  await withNonTty(async () => {
    for (const title of [
      "patch: src/cli.ts",
      "remove: old-file",
      "rename: before after",
      "run: pnpm test",
      "http: https://example.com",
      "think: plan",
      undefined,
    ]) {
      const response = await resolvePermissionRequest(
        makeRequestWithTitle(title, undefined),
        "approve-reads",
      );

      assert.deepEqual(response, {
        outcome: { outcome: "selected", optionId: "reject" },
      });
    }
  });
});

test("approve-reads prompts interactively for non-read tools", async () => {
  let closed = false;
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withMockedReadline(
      () => ({
        question: async () => "yes",
        close: () => {
          closed = true;
        },
      }),
      async () => {
        const response = await resolvePermissionRequest(
          makeRequestWithTitle("run: pnpm test", undefined),
          "approve-reads",
        );

        assert.deepEqual(response, {
          outcome: { outcome: "selected", optionId: "allow" },
        });
      },
    );
  });

  assert.equal(closed, true);
});

test("classifyPermissionDecision maps selected outcomes to approved, denied, or cancelled", () => {
  const request = makeRequest("execute");

  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "allow" },
    }),
    "approved",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "reject" },
    }),
    "denied",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "missing" },
    }),
    "cancelled",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "cancelled" },
    }),
    "cancelled",
  );
});
