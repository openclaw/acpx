import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import {
  classifyPermissionDecision,
  decisionToResponse,
  inferToolKind,
  resolvePermissionRequest,
} from "../src/permissions.js";
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
    options: BASE_OPTIONS.map((option) => Object.assign({}, option)),
  } as RequestPermissionRequest;
}

function makeRequestWithTitle(
  title: string | undefined,
  kind?: RequestPermissionRequest["toolCall"]["kind"],
  options: PermissionChoice[] = BASE_OPTIONS.map((option) => Object.assign({}, option)),
): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind,
      title,
    },
    options: options.map((option) => Object.assign({}, option)),
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

test("decisionToResponse allow_once prefers allow_once over allow_always", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  const response = decisionToResponse(request, { outcome: "allow_once" });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "once" } });
});

test("decisionToResponse allow_always prefers allow_always over allow_once", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  const response = decisionToResponse(request, { outcome: "allow_always" });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "always" } });
});

test("decisionToResponse allow_once falls back to allow_always when allow_once is missing", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  const response = decisionToResponse(request, { outcome: "allow_once" });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "always" } });
});

test("decisionToResponse reject_once falls back to reject_always", () => {
  const onlyAlways = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject-always", kind: "reject_always" },
  ]);
  assert.deepEqual(decisionToResponse(onlyAlways, { outcome: "reject_once" }), {
    outcome: { outcome: "selected", optionId: "reject-always" },
  });
});

test("decisionToResponse cancels when no matching option exists", () => {
  const request = makeRequestWithTitle("tool", "edit", [{ optionId: "allow", kind: "allow_once" }]);
  assert.deepEqual(decisionToResponse(request, { outcome: "reject_once" }), {
    outcome: { outcome: "cancelled" },
  });
});

test("decisionToResponse cancel always returns cancelled", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  assert.deepEqual(decisionToResponse(request, { outcome: "cancel" }), {
    outcome: { outcome: "cancelled" },
  });
});

test("inferToolKind classifies titles when toolCall.kind is missing", () => {
  assert.equal(inferToolKind(makeRequest("edit")), "edit");
  assert.equal(inferToolKind(makeRequestWithTitle("patch: foo.ts", undefined)), "edit");
  assert.equal(inferToolKind(makeRequestWithTitle("cat README", undefined)), "read");
  assert.equal(inferToolKind(makeRequestWithTitle("totally unknown", undefined)), "other");
});
