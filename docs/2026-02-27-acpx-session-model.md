# ACPX Session Model

Date: 2026-02-27
Status: Implemented (v1 projection in `session.json`)

## Goal

Store ACP sessions as durable event logs so acpx can always reconstruct truth from disk, including all relevant ACP traffic, queue behavior, tool activity, and turn lifecycle.

This model is designed to survive protocol evolution without schema churn.

## Current Implementation (v1)

Implemented now in `session.json` under `acpProjection` (`schema: "acpx.session.acp.v1"`):

- captures all `session/update` notifications and client operation callbacks in-order
- keeps derived projection state for tool calls, plan, available commands, mode, session info, and usage
- preserves existing `turnHistory` for quick CLI previews

This is an additive step toward the full segment-based event-log layout below.

## Design Principles

1. Append-only event log is the source of truth.
2. Mutable state is only a projection that can be rebuilt from events.
3. Every ACP JSON-RPC frame is persisted losslessly (requests, responses, notifications, errors).
4. IDs are explicit and non-overlapping.
5. Unknown future ACP methods/fields are preserved without parser updates.
6. `_meta` is treated as opaque protocol extension data and never required for correctness.

## ACP Spec Constraints This Model Must Respect

From ACP docs/schema (`agent-client-protocol`):

- Transport is JSON-RPC 2.0 over a bidirectional channel.
- Baseline Agent methods: `initialize`, `session/new`, `session/prompt`.
- Baseline Agent notification target: `session/cancel`.
- Baseline Client method: `session/request_permission`.
- Baseline Client notification target: `session/update`.
- Optional methods include `authenticate`, `session/load`, `session/set_mode`, `session/set_config_option`, `fs/*`, `terminal/*`.
- `session/update` includes multiple update kinds (e.g. message chunks, thought chunks, tool calls, plans, command/mode/config updates).
- Agents may send updates after cancel; client must still accept them until prompt response arrives.
- `_meta` exists across protocol types; clients and agents must not assume non-standard keys as required.
- Extension methods start with `_` and must be preserved for forward compatibility.

Implication for storage:

- Storing only text turns is insufficient.
- Storing only normalized known event kinds is insufficient.
- Raw ACP frames must be first-class persisted records.

## Canonical IDs

- `acpxRecordId`: stable local record key for the lifetime of a saved acpx session record.
- `acpSessionId`: ACP session identity used on the wire. May change after reconnect fallback.
- `agentSessionId`: optional inner harness session id (UUID-like in current adapters) if exposed by adapter metadata.
- `turnId`: acpx-generated id for one `session/prompt` lifecycle (request -> final response/error).
- `requestId`: optional acpx queue/request correlation id.

## Storage Layout

Each session becomes a directory instead of one flat JSON file:

```text
~/.acpx/sessions/<acpxRecordId>/
  session.json                 # mutable projection
  events/
    000000000001.ndjson        # append-only segments
    000000000002.ndjson
  index/
    turns.json                 # optional derived index
    latest.json                # optional derived cursor cache
```

Rules:

- `events/*.ndjson` is authoritative.
- `session.json` and `index/*` are caches/projections only.
- Segment files are immutable once rotated.

## Event Envelope Schema

Each line in `events/*.ndjson`:

```json
{
  "schema": "acpx.event.v1",
  "seq": 1234,
  "eventId": "01J4...ULID",
  "at": "2026-02-27T10:11:12.345Z",
  "acpxRecordId": "019c...",
  "acpSessionId": "019c...",
  "agentSessionId": "550e8400-e29b-41d4-a716-446655440000",
  "turnId": "turn_...",
  "requestId": "req_...",
  "source": "acpx",
  "kind": "acp.frame",
  "payload": {}
}
```

Stable constraints:

- `schema` is required and versioned (`acpx.event.v1`).
- `seq` is strictly increasing per `acpxRecordId`.
- `eventId` is globally unique.
- `payload` is free-form JSON object and never discarded.

## Required Event Kinds

### 1) Raw ACP wire capture (mandatory)

Capture every inbound and outbound JSON-RPC frame as-is:

```json
{
  "kind": "acp.frame",
  "payload": {
    "direction": "out",
    "message": {
      "jsonrpc": "2.0",
      "id": 12,
      "method": "session/prompt",
      "params": {}
    }
  }
}
```

or

```json
{
  "kind": "acp.frame",
  "payload": {
    "direction": "in",
    "message": {
      "jsonrpc": "2.0",
      "method": "session/update",
      "params": {}
    }
  }
}
```

Rules:

- Keep JSON-RPC `id` type as-is (`string|number|null`), never normalize by coercion.
- Preserve unknown methods/fields (including `_vendor/...`).
- Preserve full `_meta` content exactly.

### 2) Session lifecycle (normalized, optional but recommended)

- `session.created`
- `session.loaded`
- `session.closed`
- `session.rebound` (`acpSessionId` changed)
- `session.agent_session_id.updated`

### 3) Turn lifecycle (normalized, recommended)

- `turn.started`
- `turn.completed`
- `turn.cancelled`
- `turn.failed`

Turn boundaries are derived from raw `session/prompt` request/response pairs, not heuristics.

### 4) Queue/owner lifecycle (normalized, acpx-local)

- `queue.enqueued`
- `queue.dequeued`
- `queue.owner.started`
- `queue.owner.lease_renewed`
- `queue.owner.idle_expired`
- `queue.owner.stopped`

### 5) Runtime transport lifecycle (normalized)

- `runtime.connected`
- `runtime.disconnected`
- `runtime.reconnect_attempt`
- `runtime.reconnected`

### 6) Permission + client-ops projection (normalized, recommended)

Derived from captured ACP frames:

- `permission.requested`
- `permission.responded`
- `client.fs.read`
- `client.fs.write`
- `client.terminal.create`
- `client.terminal.output`
- `client.terminal.wait_for_exit`
- `client.terminal.kill`
- `client.terminal.release`

### 7) Error normalization (normalized, recommended)

- `error` with `origin`, `code`, `detailCode`, and the raw protocol/runtime error payload.

## Mutable Projection (`session.json`)

`session.json` is a fast cache, rebuildable from event replay:

```json
{
  "schema": "acpx.session.v1",
  "acpxRecordId": "019c...",
  "agent": {
    "command": "npx @zed-industries/codex-acp",
    "name": "codex"
  },
  "workspace": {
    "cwd": "/repo",
    "name": "backend"
  },
  "identity": {
    "acpSessionId": "019c...",
    "agentSessionId": "550e8400-e29b-41d4-a716-446655440000"
  },
  "lifecycle": {
    "createdAt": "...",
    "lastUsedAt": "...",
    "closed": false,
    "closedAt": null,
    "pid": 1234,
    "agentStartedAt": "...",
    "lastAgentExit": {
      "code": null,
      "signal": null,
      "at": "...",
      "reason": "connection_close"
    }
  },
  "log": {
    "firstSeq": 1,
    "lastSeq": 1234,
    "nextSeq": 1235,
    "activeSegment": "events/000000000002.ndjson"
  }
}
```

## Durability Rules

Write order for each event:

1. append event line to active segment
2. fsync segment
3. update projection fields in memory
4. periodically flush `session.json` (or on lifecycle boundaries)

Crash rule:

- If `session.json` lags, replay from `events/*` to recover.

## Replay and Recovery

On startup/session open:

1. read `session.json` if present
2. scan `events/*` from `log.lastSeq + 1` (or from start if missing)
3. apply reducer to reconstruct current state
4. rewrite `session.json` atomically

If projection is corrupt/missing, full replay is authoritative.

## Handling `_meta` and `agentSessionId`

- `_meta` is persisted exactly from ACP frames.
- acpx may derive `agentSessionId` as a best-effort convenience field.
- Missing or changed `agentSessionId` must never break session correctness.
- `agentSessionId` is advisory identity, not the ACP wire key.

## Retention and Compaction

- Keep events forever by default.
- Optional retention policy may archive old segments; never mutate existing segment contents.
- Derived indexes can be deleted at any time and rebuilt from events.

## Migration from Current Model

Current model stores one JSON record plus compact `turnHistory` previews.

Migration should:

1. create `<acpxRecordId>/session.json` from current fields
2. create `events/000000000001.ndjson`
3. backfill synthetic lifecycle events from existing metadata
4. backfill synthetic turn events from `turnHistory` previews
5. start persisting all ACP frames + normalized lifecycle events going forward

## Why This Should Last

- ACP protocol growth does not require storage schema changes because raw frames are preserved.
- Projection shape can evolve independently from immutable events.
- Auditing, debugging, replay, analytics, and cross-tool integrations rely on one stable contract: append-only event envelopes + full raw ACP frames.
