---
title: acpx OpenClaw Integration Plan
author: Onur <2453968+osolmaz@users.noreply.github.com>
date: 2026-02-22
---

# acpx OpenClaw Integration Plan

Plan for making `acpx` a robust runtime backend for OpenClaw ACP sessions in Discord threads.

## Context

OpenClaw will route bound Discord thread messages to ACP-backed sessions and use `acpx` as the data-plane runtime backend.

`acpx` already provides most required primitives:

- persistent sessions and named sessions
- queue owner with prompt queueing
- cooperative cancel
- TTL-based queue owner lifetime
- `--format json` streaming output

What is missing for production-safe orchestration is mostly machine-facing contract hardening.

## Goals

- Make `acpx` JSON output fully correlation-safe for orchestrators.
- Make failures machine-readable in JSON mode.
- Make non-interactive permission behavior explicit and policy-driven.
- Add idempotent session ensure flow for orchestrators.
- Keep human CLI UX unchanged for default text mode.

## Non-goals

- No ACP protocol redesign.
- No daemon/server rewrite.
- No breaking changes to existing text output UX.

## Required changes

### 1. Correlation-safe JSON event envelope

Current `--format json` events do not consistently carry session/request correlation fields.

Add envelope fields to all JSON stream events:

- `eventVersion: 1`
- `sessionId: string`
- `requestId?: string`
- `seq: number` (monotonic per request stream)
- `stream: "prompt" | "control"`
- existing payload-specific fields (`type`, `content`, `toolCallId`, etc.)

Notes:

- `requestId` is required for queue-owner submitted turns.
- For direct (non-queued) local turn execution, `requestId` may be omitted.
- `seq` resets per request stream.

### 2. Structured JSON errors

In JSON mode, `acpx` currently writes many failures to stderr only.

Add final structured error event in JSON mode:

```json
{
  "type": "error",
  "code": "NO_SESSION|TIMEOUT|PERMISSION_DENIED|RUNTIME|USAGE",
  "message": "...",
  "sessionId": "...",
  "requestId": "...",
  "timestamp": "..."
}
```

Rules:

- Emit before process exit.
- Keep stderr text for text mode.
- Exit codes remain unchanged.

### 3. Explicit non-interactive permission policy

Current behavior in non-TTY environments effectively denies interactive approvals.

Add explicit option:

- `--non-interactive-permissions <deny|fail>`

Config key:

- `nonInteractivePermissions: "deny" | "fail"`

Default:

- `deny` (preserve current behavior)

Behavior:

- `deny`: reject permission request as today
- `fail`: abort with structured error (`PERMISSION_PROMPT_UNAVAILABLE`) so orchestrator can retry with different permission mode

### 4. Session ensure command

Add idempotent session ensure for orchestrators:

- `acpx <agent> sessions ensure [--name <name>]`

Behavior:

- if matching active session exists for `(agent command, cwd walk, optional name)`, return it
- otherwise create a new session and return it

JSON output:

```json
{
  "type": "session_ensured",
  "id": "...",
  "sessionId": "...",
  "name": "...",
  "created": true|false
}
```

### 5. Queue event parity in JSON mode

Ensure queued turn lifecycle emits deterministic machine stream:

- `accepted`
- zero or more streamed events
- `done`
- `result`

and on failures:

- `error` with `code` and `message`

## Backward compatibility

- Text mode output remains unchanged.
- Existing JSON consumers continue to receive `type` and existing fields.
- New envelope fields are additive.
- Exit codes unchanged.

## Implementation sketch

Primary files:

- `src/types.ts`
  - extend `OutputEvent` for envelope + `error` event type
- `src/output.ts`
  - emit envelope fields and `seq`
- `src/session-runtime.ts`
  - plumb `sessionId/requestId` context into formatter lifecycle
- `src/queue-ipc.ts`
  - ensure request lifecycle always surfaces typed failures
- `src/permissions.ts` + `src/permission-prompt.ts`
  - add non-interactive policy behavior
- `src/cli.ts`
  - parse new flag/config and emit structured errors in JSON mode
- `src/config.ts`
  - config key for non-interactive policy

## Phased delivery

### Phase 1 (MVP hardening)

- JSON envelope (`eventVersion/sessionId/requestId/seq`)
- structured JSON errors
- session ensure command

### Phase 2 (policy hardening)

- non-interactive permission policy flag + config
- queue failure typing cleanup

### Phase 3 (polish)

- docs updates (`README.md`, `docs/CLI.md`)
- end-to-end examples for orchestrators

## Testing plan

Unit tests:

- output formatter JSON envelope fields and sequence behavior
- structured error mapping from exit paths
- ensure command path resolution (`created=true|false`)
- non-interactive permission policy behavior (`deny|fail`)

Integration tests:

- queued request emits deterministic JSON lifecycle
- timeout path returns structured error event and expected exit code
- no-session path returns structured error in JSON mode

Regression tests:

- text mode snapshots unchanged
- existing queue behavior unchanged for non-JSON mode

## Acceptance criteria

- every JSON event in streamed prompt mode includes `eventVersion`, `sessionId`, and `seq`
- queue-submitted turns include `requestId` on all events
- JSON mode failures emit at least one structured `error` event before exit
- `sessions ensure` is idempotent and returns deterministic JSON
- non-interactive permission behavior is explicitly configurable

## Open questions

- Should `requestId` be mandatory for direct non-queued prompt calls as well?
- Should we add `--json-strict` that suppresses all non-JSON stderr output?
- Should structured error codes be centralized in `types.ts` for external SDK consumers?
