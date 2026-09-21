---
title: ACPX Error Strategy
author: Onur <2453968+osolmaz@users.noreply.github.com>
date: 2026-02-22
---

# ACPX Error Strategy

Permanent machine-facing error contract for `acpx` orchestrators (for example OpenClaw).

## Scope

This document defines how `acpx` should represent errors across:

- CLI entrypoints
- runtime/session execution
- queue owner IPC
- ACP protocol boundary

## Design principles

- Keep ACP semantics intact when available.
- Provide stable `acpx` codes for orchestrator logic.
- Avoid parsing free-form message text.
- Keep the JSON/machine contract stable; text mode may add additive remediation hints.
- Make changes additive to preserve backward compatibility.

## Two-layer contract

`acpx` should expose both:

- `acpx` machine codes (stable, small enum for orchestration)
- raw ACP error details (numeric JSON-RPC code/message/data) when the source error is ACP-native

## JSON error response shape

Locally generated CLI errors use JSON-RPC responses in JSON mode. For example,
disabled one-shot execution emits:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32603,
    "message": "exec subcommand is disabled by configuration (disableExec: true)",
    "data": {
      "acpxCode": "EXEC_DISABLED",
      "origin": "cli",
      "sessionId": "unknown"
    }
  }
}
```

For local errors:

- `id` is present and is `null` when the error has no associated RPC request.
- `error.code` is the numeric JSON-RPC code; `error.message` is the diagnostic.
- `error.data.acpxCode` carries the stable `acpx` classification.
- Optional `detailCode`, `origin`, `retryable`, `timestamp`, and `sessionId` fields live in `error.data` when available.

Streamed ACP messages remain raw JSON-RPC. When the shared builder renders an
ACP-native error, it retains the original numeric code, message, and data. Object
data is supplemented with available client metadata without overwriting the
agent's fields; non-object data is preserved as supplied. Do not require local
metadata on every native error.

The shared normalization layer calls the machine classification `code` and keeps
the original ACP error in `acp`. Those internal fields are projected into the
JSON-RPC response; the CLI does not emit a separate `type: "error"` envelope.

## Top-level `acpx` codes

- `NO_SESSION`: session missing/invalid (including ACP resource-not-found).
- `TIMEOUT`: local timeout wrappers fired.
- `PERMISSION_DENIED`: permission request denied/cancelled by policy/user.
- `PERMISSION_PROMPT_UNAVAILABLE`: non-interactive prompt policy is `fail` and prompt cannot be shown.
- `USAGE`: CLI/config invocation errors.
- `EXEC_DISABLED`: the configured `disableExec` policy blocks one-shot execution; exit `1`, with JSON-RPC code `-32603`.
- `RUNTIME`: all other failures.

Auth-required policy:

- keep top-level `code` as `RUNTIME` for compatibility
- use `detailCode=AUTH_REQUIRED` for deterministic machine handling
- include raw ACP payload in `acp` when available (for example `acp.code=-32000`)

Agent-spawn policy:

- keep top-level `code` as `RUNTIME` for compatibility
- use `detailCode=AGENT_SPAWN_ENOENT` when process creation fails with `ENOENT`
- describe the missing launch path without assuming it is always the command binary; the executable, interpreter, or working directory may be absent
- leave non-`ENOENT` spawn failures on the generic runtime path

## Queue detail codes (initial set)

- `QUEUE_OWNER_CLOSED`
- `QUEUE_OWNER_SHUTTING_DOWN`
- `QUEUE_REQUEST_INVALID`
- `QUEUE_REQUEST_PAYLOAD_INVALID_JSON`
- `QUEUE_ACK_MISSING`
- `QUEUE_DISCONNECTED_BEFORE_ACK`
- `QUEUE_DISCONNECTED_BEFORE_COMPLETION`
- `QUEUE_PROTOCOL_INVALID_JSON`
- `QUEUE_PROTOCOL_MALFORMED_MESSAGE`
- `QUEUE_PROTOCOL_UNEXPECTED_RESPONSE`
- `QUEUE_NOT_ACCEPTING_REQUESTS`

## ACP compatibility rules

- Treat ACP `-32002` as canonical resource-not-found.
- Keep compatibility fallback for legacy variants (`-32001` or known historical message forms), but do not use message parsing as primary detection.
- Preserve raw ACP error in `acp` whenever available.

## Cancellation semantics

Cancellation is a normal completion path, not an error path:

- expected result is `done`/`result` with `stopReason = "cancelled"`
- queue `error` should be used only for transport/protocol/runtime failure

## Rollout and compatibility

- Queue error parsing should accept both old (`message` only) and new (`code/detailCode/message`) payload shapes during migration.
- Text mode may add additive remediation hints; existing exit codes and JSON fields stay unchanged.
- New JSON fields remain additive.
- `--json-strict` is the recommended mode for orchestrators that need JSON-only output channels.

## Implementation notes

- Use the shared normalization path in `src/acp/error-normalization.ts` for CLI, runtime, and queue.
- Avoid duplicate mapping logic per layer.
- Keep mapping tests table-driven to prevent drift.

## Testing requirements

Unit:

- normalization mapping matrix (ACP/native/runtime/queue/usage/permission/timeouts)
- queue parse compatibility for old and new error payloads

Integration:

- queue disconnect/protocol failures emit typed `detailCode`
- no-session, timeout, permission paths emit structured error with expected `code`
- cancel flow ends with `stopReason = "cancelled"` and no spurious queue error
