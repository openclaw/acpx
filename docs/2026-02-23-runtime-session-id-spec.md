# 2026-02-23 Runtime Session ID Specification

Status: Draft
Owner: acpx
Last updated: 2026-02-23

## Context

`acpx sessions ensure --format json` currently returns:

- `id`
- `sessionId`
- `name`
- `created`

In current acpx behavior, `id` and `sessionId` are identical because acpx persists one identifier for both record identity and ACP session identity.

For orchestrators (for example OpenClaw), this is not enough to distinguish:

- acpx record/session identity
- runtime/provider-native identity (for example Codex/Claude internal session id) when available

## Problem Statement

When adapters expose an additional runtime/provider session identifier, acpx cannot currently preserve and expose it.

This causes downstream UX to show duplicated values and prevents precise diagnostics across layers.

## Goals

1. Add first-class support for an optional runtime/provider session identifier.
2. Preserve backward compatibility for existing acpx consumers.
3. Keep behavior deterministic when runtime id is unavailable.
4. Avoid brittle scraping (logs, PTY parsing, out-of-band files).

## Non-Goals

1. Inventing a runtime/provider id when adapter does not expose one.
2. Requiring ACP spec changes for v1.
3. Changing existing `id` semantics for acpx record lookup.

## Proposed Data Model

### SessionRecord

Extend `SessionRecord` with an optional field:

- `runtimeSessionId?: string`

Semantics:

- `id`: acpx record id (stable local record key)
- `sessionId`: ACP session id used for ACP method calls
- `runtimeSessionId`: provider/runtime-native id if exposed via ACP metadata

### Output JSON

Include optional `runtimeSessionId` in JSON payloads when known:

- `sessions new --format json`
- `sessions ensure --format json`
- `status --format json`
- `sessions show --format json` (already full record; ensure field is present)

If unknown, omit field (do not emit null/placeholder).

## Source of Truth for runtimeSessionId

acpx SHOULD extract runtime/provider id from ACP `_meta` on session setup responses:

- `newSession` response `_meta`
- if available, `loadSession` response `_meta` for reconciliation

### Metadata key contract

For interoperability, acpx will support this precedence list:

1. `_meta.runtimeSessionId`
2. `_meta.providerSessionId`
3. `_meta.codexSessionId`
4. `_meta.claudeSessionId`

Notes:

- Keys are optional.
- First non-empty string wins.
- Unknown keys are ignored.
- This does not block future ACP standardization.

## Behavioral Requirements

1. acpx MUST keep existing behavior for `id` and `sessionId`.
2. acpx MUST persist `runtimeSessionId` when discovered.
3. acpx MUST NOT fail session creation/loading if runtime id is absent.
4. acpx SHOULD update stored `runtimeSessionId` on later session attach if newly discovered.
5. acpx SHOULD preserve an existing `runtimeSessionId` unless a new non-empty value is provided.

## Implementation Plan (acpx)

1. Types
   - Add `runtimeSessionId?: string` to `SessionRecord`.

2. Client layer
   - Change `AcpClient#createSession` to return a structured object, not bare string:
     - `{ sessionId: string; runtimeSessionId?: string }`
   - Parse `_meta` with precedence list.

3. Session runtime
   - Update `createSession(...)` flow to persist `runtimeSessionId`.
   - Update reconnect/load paths to reconcile runtime id when metadata is available.

4. CLI JSON output
   - Add optional `runtimeSessionId` in JSON event payloads for `sessions new`, `sessions ensure`, and `status`.

5. Persistence/migration
   - No migration required.
   - Existing session files remain valid; field is optional.

## Test Plan

1. Unit: metadata parsing
   - `_meta.runtimeSessionId` maps correctly.
   - precedence order is respected.
   - empty/non-string values are ignored.

2. Unit: session persistence
   - record writes include `runtimeSessionId` when present.
   - existing records without field load unchanged.

3. CLI tests (json mode)
   - `sessions new` emits `runtimeSessionId` when available.
   - `sessions ensure` emits `runtimeSessionId` when available.
   - `status` emits `runtimeSessionId` from stored record.

4. Regression
   - all existing text/quiet outputs unchanged.
   - all existing code paths pass when runtime id is absent.

## OpenClaw Integration Impact

No protocol break is required.

OpenClaw can consume:

- `sessionId` as ACP id
- `id` as acpx id
- `runtimeSessionId` as inner/provider id (when present)

If `runtimeSessionId` is absent, OpenClaw should avoid implying a separate inner id.

## Rollout

1. Implement field + JSON outputs in acpx.
2. Release acpx.
3. Update OpenClaw ACP runtime adapter to prefer `runtimeSessionId` from acpx output.
4. In OpenClaw thread intros, suppress duplicate lines when two IDs are equal.

## Risks

1. Adapter metadata key variance.
   - Mitigation: precedence list + optional field.

2. Consumers assuming `id === sessionId` forever.
   - Mitigation: compatibility maintained; only additive optional field.

3. False confidence when adapter provides no runtime id.
   - Mitigation: explicit optional semantics and no synthetic IDs.
