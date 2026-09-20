# ACPX Session Model

Date: 2026-02-27; journal extension: 2026-09-16
Status: Current session and journal contract

## Goal

Define a long-term stable persistence model with:

- one authoritative session journal containing the ACP transcript,
- one session checkpoint/index schema,
- strict separation between ACP stream data and local runtime bookkeeping.

## Core Decisions

1. Actual ACP messages are stored unchanged, one JSON-RPC message per line.
2. The append-only NDJSON journal also contains explicitly local segment and turn records needed for passive watching.
3. `session.json` is a derived checkpoint/index, not a second event protocol.
4. Queue ownership, processes, retries, and locks remain outside the journal. Local turn records associate output with its submitting request and record its settled result.
5. No custom envelope is added to actual ACP messages. Local records are never sent to the agent or included in ACP-only output.

The journal extension intentionally supersedes the original raw-ACP-only **on-disk** rule. It adds metadata to the existing journal rather than creating a second event store. ACP transport, strict JSON stdout, and portable archive history retain their raw-ACP contracts.

## Canonical ID Semantics

- `acpx_record_id`: acpx local record id (stable storage id).
- `acp_session_id`: ACP session id used on wire.
- `agent_session_id`: harness-native id (Codex/Claude/OpenCode/Pi/etc), when available.
- Raw ACP `id`: the request identifier on the ACP connection.
- Local journal `request_id`: the acpx turn submission identifier, shared with the queue and turn result. It is independent of ACP request IDs.

Rules:

- `acpx_record_id` is always required in local storage.
- `acp_session_id` and `agent_session_id` are optional and may appear later.
- Values may be equal in some runtimes; semantics remain distinct.

## Storage Layout

For each `acpx_record_id`:

```text
~/.acpx/sessions/<acpx_record_id>.stream.ndjson
~/.acpx/sessions/<acpx_record_id>.stream.1.ndjson
~/.acpx/sessions/<acpx_record_id>.stream.2.ndjson
...
~/.acpx/sessions/<acpx_record_id>.json
~/.acpx/sessions/<acpx_record_id>.stream.lock
```

Rules:

- `*.stream*.ndjson` is authoritative history.
- `<acpx_record_id>.json` is the local checkpoint/index.
- No second persisted event protocol is allowed.

## ACP Records

Each ACP record is one raw ACP JSON-RPC message as exchanged over ACP.

Allowed message shapes are standard JSON-RPC 2.0 forms used by ACP:

- request: `{ "jsonrpc": "2.0", "id": ..., "method": "...", "params": ... }`
- response: `{ "jsonrpc": "2.0", "id": ..., "result": ... }`
- error: `{ "jsonrpc": "2.0", "id": ..., "error": { "code": ..., "message": ..., "data": ... } }`
- notification: `{ "jsonrpc": "2.0", "method": "...", "params": ... }`

Examples:

```json
{"jsonrpc":"2.0","id":"req-1","method":"session/prompt","params":{"sessionId":"019c...","prompt":[{"type":"text","text":"hi"}]}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019c...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}
{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"}}
```

Hard constraints:

- no custom `schema` field added to ACP messages,
- no synthetic `type`/`stream` envelope keys,
- no acpx-only control/event wrappers around ACP messages,
- no key renaming of ACP payload fields in the stream.

## Local Journal Records

New segments begin with a non-JSON-RPC anchor:

```json
{
  "schema": "acpx.session.journal.v1",
  "type": "segment",
  "record_id": "019c...",
  "sequence": 40,
  "message_sequence": 35,
  "request_id": "queue-request"
}
```

`sequence` counts observable journal entries preceding this segment; anchors themselves do not consume a sequence. `message_sequence` counts preceding ACP messages and preserves the existing checkpoint `last_seq` meaning. `request_id` identifies the active acpx request, or is null between turns. Every raw ACP record and local turn record advances the watch sequence exactly once.

The turn owner writes these records around actual work:

```json
{"schema":"acpx.session.journal.v1","type":"turn_started","request_id":"queue-request"}
{"schema":"acpx.session.journal.v1","type":"turn_result","request_id":"queue-request","result":{"status":"completed","stopReason":"end_turn"}}
```

Results use `completed`, `cancelled`, or `failed`; failures carry an `error` object with a message and optional structured error fields. The owner records its settled result after finalization. An ACP prompt response alone does not prove that finalization succeeded. Abrupt owner death can leave a turn without a result; that outcome is unknown and must not be presented as completed or safely retryable.

ACP-only readers filter local records centrally. Portable archives continue to contain ACP history only, so importing creates a fresh watch history under the new local record ID. Pre-extension raw history remains available through ordinary history/export commands; watch replay begins at the first journal anchor. Missing historical request IDs and results are not invented.

## Stdout Contract (`--format json --json-strict`)

For commands that communicate with an ACP adapter, stdout must contain only raw ACP JSON-RPC messages, one per line.

- no non-ACP JSON objects in this stream,
- no human text in stdout,
- no stderr noise when `--json-strict` is enabled.

If local command output is needed for non-ACP commands, that output is not part of the ACP stream contract.

## Session Checkpoint Schema (`acpx.session.v1`)

`session.json` contains the owner's saved conversation projection and local runtime state, with top-level conversation fields and an `acpx` object. Owners load this checkpoint and update it from live ACP activity and local operations.

```json
{
  "schema": "acpx.session.v1",
  "acpx_record_id": "019c....",
  "acp_session_id": "019c....",
  "agent_session_id": "019c....",

  "agent_command": "npx @zed-industries/codex-acp",
  "cwd": "/repo",
  "name": "my-session",

  "created_at": "2026-02-27T12:00:00.000Z",
  "last_used_at": "2026-02-27T12:10:00.000Z",
  "last_seq": 412,
  "last_request_id": "req_123",

  "event_log": {
    "active_path": "/home/user/.acpx/sessions/019c....stream.ndjson",
    "segment_count": 3,
    "max_segment_bytes": 67108864,
    "max_segments": 5,
    "last_write_at": "2026-02-27T12:10:00.000Z",
    "last_write_error": null
  },

  "title": null,
  "messages": [],
  "cumulative_token_usage": {},
  "request_token_usage": {},

  "acpx": {
    "current_mode_id": "code",
    "available_commands": ["session/set_mode", "session/set_config_option"]
  }
}
```

Rules:

- `session.json` is not a transport protocol.
- `session.json` may include local bookkeeping, but the stream may not.
- Retain `session.json`: a complete checkpoint is not guaranteed to be reconstructible from retained journal entries, because rotation can remove earlier history and some local state is never journaled.

## Local State Boundary

Local app state must stay out of the ACP stream.

Examples of state that remains outside the journal:

- queue owner pid and health,
- lock/lease metadata,
- process lifecycle snapshots,
- retry counters,
- local diagnostics.

This state belongs in checkpoint/state stores or status commands, never in ACP payloads. Journal anchors and turn lifecycle records are the explicit on-disk exception described above.

## Sequence and Single-Writer Rules

To preserve strict monotonic ordering:

1. Acquire `<acpx_record_id>.stream.lock`.
2. Recover the next watch and ACP sequence positions from the latest journal anchor and complete records, independently of a potentially stale checkpoint.
3. Serialize ACP and local lifecycle appends through the same writer.
4. Rotate within the existing retention window, writing a sequence anchor before entries in a new segment.
5. Update the session checkpoint atomically at its normal live/final checkpoint boundaries.
6. Release lock.

No writes are allowed without lock ownership. A trailing incomplete record left by a failed writer is preserved in its old segment; the next writer starts an anchored segment after the last complete record. Previously visible cursors are never reused.

## Passive Replay and Follow

The passive reader pins a consistent set of file identities before reading, follows appended bytes incrementally, and validates continuity between retained segment anchors. Replay pages contain approximately 1 MiB of encoded records, allowing one larger ACP record; events before a supplied cursor are not retained. Backlog pages drain immediately, and polling begins only at the live edge. It does not acquire a turn lock, write state, start an adapter, refresh activity, answer permissions, or cancel work. Aborting or closing an observer stops that reader only.

Each observed entry has an opaque cursor scoped to the local record and an acpx request ID (null for ACP traffic outside a turn). With no cursor, the reader replays retained anchored history before following new entries. With a cursor, it resumes strictly after that entry. Malformed, foreign, expired, and future cursors produce distinct errors. A slow observer whose unread history rotates out gets an expiration error rather than silently skipping output.

Following waits for future journal writes even when the session is idle or its owner restarts. Absence of a new record is not a terminal result. Callers control the observer lifetime with its abort signal or iterator closure.

## Checkpoint Loading and Journal Recovery

Normal session lookup and startup read the saved `<acpx_record_id>.json` checkpoint. Startup does not rebuild it by replaying all journal segments. Before appending, the event writer recovers watch and ACP sequence positions, the active request ID, and segment-tail state from retained journal anchors and complete records. Normal live and final checkpoint saves persist the owner's current projection and local state.

Journal replay exposes retained history; it does not reconstruct a missing or corrupt checkpoint. The original proposal described full checkpoint reconstruction, but no automatic reconstruction or repair path is implemented.

Corrupt line policy:

- trailing partial final line: withhold it until complete; a recovered writer can seal that incomplete suffix by rotating to a new anchored segment,
- invalid complete line in an anchored segment, invalid metadata, or a gap between retained anchored segments: fail passive replay,
- legacy ACP snapshot/export readers retain their existing tolerance for malformed lines.

## Validation and Guardrails

Required:

- distinct validators for actual JSON-RPC ACP messages and local journal records,
- no local journal schema accepted as ACP transport or strict stdout,
- checkpoint validator for `acpx.session.v1`,
- contract tests that assert `--format json --json-strict` emits ACP-only lines.

## Non-Goals

- rewriting or wrapping actual ACP messages,
- a second persisted event store,
- reconstructing unknown historical request IDs or terminal outcomes,
- coupling observer disconnects or backpressure to turn execution.
