import assert from "node:assert/strict";
import test from "node:test";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  codexPermissionNotice,
  isLegacyZedCodexAcpInvocation,
  preferCodexPermissionRefusal,
} from "../src/acp/codex-compat.js";

const CODEX_AGENT = "@agentclientprotocol/codex-acp";

function permissionRequest(options: PermissionOption[]): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1" },
    options,
  };
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

test("isLegacyZedCodexAcpInvocation matches the zed-industries codex-acp package", () => {
  assert.equal(isLegacyZedCodexAcpInvocation("npx -y @zed-industries/codex-acp"), true);
});

test("isLegacyZedCodexAcpInvocation rejects the current agentclientprotocol package", () => {
  assert.equal(isLegacyZedCodexAcpInvocation("npx -y @agentclientprotocol/codex-acp"), false);
});

test("isLegacyZedCodexAcpInvocation rejects an unrelated agent command", () => {
  assert.equal(isLegacyZedCodexAcpInvocation("claude"), false);
});

test("preferCodexPermissionRefusal leaves requests for other agents untouched", () => {
  const request = permissionRequest([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
  ]);

  assert.equal(preferCodexPermissionRefusal(request, "claude"), request);
  assert.equal(preferCodexPermissionRefusal(request, undefined), request);
});

test("preferCodexPermissionRefusal moves the decline refusal ahead of other options", () => {
  const request = permissionRequest([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
    { optionId: "cancel", name: "Cancel", kind: "reject_once" },
  ]);

  const result = preferCodexPermissionRefusal(request, CODEX_AGENT);

  assert.deepEqual(
    result.options.map((option) => option.optionId),
    ["decline", "allow", "cancel"],
  );
});

test("preferCodexPermissionRefusal recognises the reject_permissions refusal option", () => {
  const request = permissionRequest([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject_permissions", name: "Reject", kind: "reject_once" },
  ]);

  const result = preferCodexPermissionRefusal(request, CODEX_AGENT);

  assert.equal(result.options[0]?.optionId, "reject_permissions");
});

test("preferCodexPermissionRefusal keeps the request when no matching refusal exists", () => {
  const request = permissionRequest([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "cancel", name: "Cancel", kind: "reject_once" },
    { optionId: "decline", name: "Decline", kind: "allow_once" },
  ]);

  assert.equal(preferCodexPermissionRefusal(request, CODEX_AGENT), request);
});

test("codexPermissionNotice returns nothing for other agents", () => {
  const request = permissionRequest([{ optionId: "cancel", name: "Cancel", kind: "reject_once" }]);

  assert.equal(codexPermissionNotice(request, selected("cancel"), "claude"), undefined);
});

test("codexPermissionNotice warns when Codex cancels without a matching option", () => {
  const request = permissionRequest([{ optionId: "allow", name: "Allow", kind: "allow_once" }]);

  assert.equal(
    codexPermissionNotice(request, { outcome: { outcome: "cancelled" } }, CODEX_AGENT),
    "No matching permission option was available. The request was safely cancelled; Codex may end the current turn.",
  );
});

test("codexPermissionNotice warns when the refusal option was selected to cancel", () => {
  const request = permissionRequest([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "cancel", name: "Cancel", kind: "reject_once" },
  ]);

  assert.equal(
    codexPermissionNotice(request, selected("cancel"), CODEX_AGENT),
    "Permission refused using Codex's cancellation option; this can end the current turn. The operation was not approved.",
  );
});

test("codexPermissionNotice stays silent for an ordinary selection", () => {
  const request = permissionRequest([{ optionId: "allow", name: "Allow", kind: "allow_once" }]);

  assert.equal(codexPermissionNotice(request, selected("allow"), CODEX_AGENT), undefined);
});

test("codexPermissionNotice stays silent when the cancel option is not a reject_once", () => {
  const request = permissionRequest([
    { optionId: "cancel", name: "Cancel", kind: "reject_always" },
  ]);

  assert.equal(codexPermissionNotice(request, selected("cancel"), CODEX_AGENT), undefined);
});
