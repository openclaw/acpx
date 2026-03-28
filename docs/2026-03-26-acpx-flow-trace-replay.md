---
title: acpx Flow Trace And Replay
description: Trace bundle layout, event model, and replay data requirements for acpx flow runs.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-03-26
---

# acpx Flow Trace And Replay

## Why this document exists

Flow runs already persist useful state under `~/.acpx/flows/runs/`, but replay and
visualization need a clearer contract than "whatever files happened to be
written during execution."

This document specifies the trace and replay model for flow runs:

- one run corresponds to one run bundle
- the bundle is self-contained for replay
- the append-only trace is the source of truth
- snapshots are derived views for convenience
- ACP conversation data is linked to flow steps explicitly

This is a storage and replay spec. It is not a UI spec.

The source tree includes one example consumer of this bundle format under
`examples/flows/replay-viewer/`. That viewer is not part of the `acpx` CLI
surface, but it exercises the same bundle contract described here.

## Goals

- Make previous flow runs replayable without depending on live global state
- Support step-by-step visualization of the workflow graph
- Support ACP conversation inspection for each ACP step
- Preserve deterministic and ACP-driven work in one trace model
- Keep the storage format additive and versioned

## Non-goals

- No requirement that replay live inside `acpx` core CLI
- No requirement to standardize a specific web viewer
- No requirement to rebuild every derived file only from the viewer
- No requirement to copy every global cache or temp file into the bundle

## Core model

The replay model has three layers:

1. append-only trace events
2. derived projections
3. content artifacts

The source of truth is the trace log.

The projections exist so tools do not need to replay the full trace just to show
basic state such as:

- current status
- latest node results
- step list
- live liveness data

Artifacts hold bulky or structured payloads such as:

- prompt text
- raw ACP output
- shell stdout/stderr
- fetched GitHub payloads
- rendered comments

## Run bundle

Each flow run lives in:

```text
~/.acpx/flows/runs/<run-id>/
```

That directory is the run bundle.

The bundle should be replayable on its own. A replay consumer must not require
access to `~/.acpx/sessions/*.json` outside the bundle.

### Required layout

```text
<run-dir>/
  manifest.json
  flow.json
  trace.ndjson
  projections/
    run.json
    live.json
    steps.json
  sessions/
    <session-bundle-id>/
      binding.json
      record.json
      events.ndjson
  artifacts/
    sha256-<digest>.<ext>
```

### File roles

- `manifest.json`: versioned bundle index and file map
- `flow.json`: structural snapshot of the resolved flow definition that ran
- `trace.ndjson`: append-only event log for the run
- `projections/run.json`: latest full run snapshot
- `projections/live.json`: latest liveness snapshot
- `projections/steps.json`: ordered node-attempt receipts
- `sessions/*/binding.json`: session binding metadata for the run
- `sessions/*/record.json`: normalized session record snapshot for replay
- `sessions/*/events.ndjson`: raw ACP event stream for that bound session
- `artifacts/*`: referenced payloads too large or awkward to inline

## Manifest

`manifest.json` is the stable entrypoint for replay readers.

### Shape

```json
{
  "schema": "acpx.flow-run-bundle.v1",
  "runId": "2026-03-26T185607297Z-pr-triage-f851b3af",
  "flowName": "pr-triage",
  "flowPath": "/abs/path/examples/flows/pr-triage/pr-triage.flow.ts",
  "startedAt": "2026-03-26T18:56:07.299Z",
  "finishedAt": "2026-03-26T19:01:12.000Z",
  "status": "completed",
  "traceSchema": "acpx.flow-trace-event.v1",
  "paths": {
    "flow": "flow.json",
    "trace": "trace.ndjson",
    "runProjection": "projections/run.json",
    "liveProjection": "projections/live.json",
    "stepsProjection": "projections/steps.json",
    "sessionsDir": "sessions",
    "artifactsDir": "artifacts"
  },
  "sessions": [
    {
      "id": "main-8c7c0d6d",
      "handle": "main",
      "bindingPath": "sessions/main-8c7c0d6d/binding.json",
      "recordPath": "sessions/main-8c7c0d6d/record.json",
      "eventsPath": "sessions/main-8c7c0d6d/events.ndjson"
    }
  ]
}
```

### Manifest rules

- `schema` is required and versioned
- every path is bundle-relative
- replay readers should start from `manifest.json`, not by guessing files
- unknown fields must be ignored

## Trace events

`trace.ndjson` is append-only.

Each line is one JSON object.

### Event envelope

```json
{
  "seq": 42,
  "at": "2026-03-26T18:56:14.889Z",
  "scope": "node",
  "type": "node_started",
  "runId": "2026-03-26T185607297Z-pr-triage-f851b3af",
  "nodeId": "extract_intent",
  "attemptId": "extract_intent#1",
  "payload": {}
}
```

### Required fields

- `seq`: strictly increasing integer within the run bundle
- `at`: ISO timestamp
- `scope`: coarse event family
- `type`: event name within that family
- `runId`: owning run id
- `payload`: event-specific data object

### Optional cross-links

- `nodeId`: logical node name
- `attemptId`: unique node-attempt id
- `sessionId`: run-bundle session id such as `main-8c7c0d6d`
- `artifact`: artifact reference object

### Event scopes

- `run`
- `node`
- `acp`
- `action`
- `session`
- `artifact`

### Core event types

The bundle must preserve enough events to reconstruct:

- run start and completion
- each node attempt start and outcome
- node heartbeats
- ACP prompt/response linkage
- action command receipts
- artifact creation

At minimum, implementations must emit these event types:

- `run_started`
- `run_completed`
- `run_failed`
- `node_started`
- `node_heartbeat`
- `node_outcome`
- `session_bound`
- `artifact_written`

For ACP and action replay, these event types must also be present when relevant:

- `acp_prompt_prepared`
- `acp_response_parsed`
- `action_prepared`
- `action_completed`

Implementations may add more event types later. Readers must ignore unknown
types.

### Canonical event payloads

The event envelope should stay stable for a long time.

That means the set of required event types should be small, and each one should
have a narrow payload contract.

#### `run_started`

```json
{
  "flowName": "pr-triage",
  "flowPath": "/abs/path/examples/flows/pr-triage/pr-triage.flow.ts",
  "inputArtifact": {
    "path": "artifacts/sha256-....json",
    "mediaType": "application/json",
    "sha256": "..."
  }
}
```

#### `run_completed`

```json
{
  "status": "completed"
}
```

#### `run_failed`

```json
{
  "status": "failed",
  "error": "Timed out after 1800000ms"
}
```

#### `node_started`

```json
{
  "nodeType": "acp",
  "timeoutMs": 900000,
  "cwd": "/tmp/workdir",
  "statusDetail": "Extract the PR intent"
}
```

#### `node_heartbeat`

```json
{
  "statusDetail": "Still waiting for ACP response"
}
```

#### `node_outcome`

```json
{
  "nodeType": "acp",
  "outcome": "ok",
  "durationMs": 28764,
  "error": null,
  "outputArtifact": {
    "path": "artifacts/sha256-....json",
    "mediaType": "application/json",
    "sha256": "..."
  }
}
```

`node_outcome` is the canonical final receipt for a node attempt.

If the output is naturally small and scalar, it may also be stored inline:

```json
{
  "nodeType": "compute",
  "outcome": "ok",
  "durationMs": 2,
  "outputInline": {
    "route": "judge_refactor"
  }
}
```

Do not inline large or multi-line payloads.

#### `session_bound`

```json
{
  "sessionId": "main-8c7c0d6d",
  "handle": "main",
  "bindingArtifact": {
    "path": "sessions/main-8c7c0d6d/binding.json",
    "mediaType": "application/json",
    "sha256": "..."
  }
}
```

#### `artifact_written`

```json
{
  "artifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  }
}
```

#### `acp_prompt_prepared`

```json
{
  "sessionId": "main-8c7c0d6d",
  "promptArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  }
}
```

#### `acp_response_parsed`

```json
{
  "sessionId": "main-8c7c0d6d",
  "conversation": {
    "messageStart": 0,
    "messageEnd": 1,
    "eventStartSeq": 120,
    "eventEndSeq": 188
  },
  "rawResponseArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  }
}
```

#### `action_prepared`

```json
{
  "action": {
    "actionType": "shell",
    "command": "pnpm",
    "args": ["run", "check"],
    "cwd": "/tmp/workdir"
  }
}
```

#### `action_completed`

```json
{
  "action": {
    "actionType": "shell",
    "command": "pnpm",
    "args": ["run", "check"],
    "cwd": "/tmp/workdir",
    "exitCode": 0,
    "signal": null,
    "durationMs": 12834
  },
  "stdoutArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  },
  "stderrArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  }
}
```

## Trace writing rules

The trace log is the source of truth, so its write semantics should stay very
simple:

- `trace.ndjson` is append-only
- `seq` starts at `1` and increases by `1`
- events are never rewritten or deleted
- every node attempt must have exactly one `node_started`
- every node attempt must have exactly one terminal `node_outcome`
- `attemptId` must be unique within the run

When a run is still active, the bundle may be incomplete. Readers should use
the latest projections together with the current `trace.ndjson` tail.

## Node attempts

Replay should operate on node attempts, not only on node ids.

That matters because flows can:

- retry
- loop
- revisit the same node multiple times

### Node-attempt identity

Every execution of a node gets a stable `attemptId`, for example:

```text
review_loop#1
review_loop#2
```

All node-scoped events for that execution use the same `attemptId`.

## ACP replay linkage

ACP replay is only clean if each ACP node attempt points to the exact
conversation slice it produced.

That linkage must be explicit.

### Required ACP linkage in the node outcome payload

For ACP node attempts, `node_outcome.payload` must include:

```json
{
  "conversation": {
    "sessionId": "main-8c7c0d6d",
    "messageStart": 0,
    "messageEnd": 1,
    "eventStartSeq": 120,
    "eventEndSeq": 188
  },
  "promptArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  },
  "rawResponseArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  }
}
```

### Meaning

- `messageStart` / `messageEnd`: inclusive indexes into the bundled
  `sessions/<id>/record.json` normalized message list
- `eventStartSeq` / `eventEndSeq`: inclusive sequence numbers into the bundled
  `sessions/<id>/events.ndjson`
- `promptArtifact`: rendered prompt text or structured prompt payload
- `rawResponseArtifact`: raw final ACP text prior to parsing

Both message and event ranges are needed:

- normalized messages are best for readable replay
- raw ACP events are best for exact low-level inspection

The ACP linkage in `node_outcome` is the canonical bridge from the workflow
trace to the bundled session replay data. Viewers should not try to infer this
linkage heuristically.

## Action receipts

Action steps need stable receipts for replay.

For action node attempts, `node_outcome.payload` must include:

```json
{
  "action": {
    "actionType": "shell",
    "command": "pnpm",
    "args": ["run", "check"],
    "cwd": "/tmp/workdir",
    "exitCode": 0,
    "signal": null,
    "durationMs": 12834
  },
  "stdoutArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  },
  "stderrArtifact": {
    "path": "artifacts/sha256-....txt",
    "mediaType": "text/plain",
    "sha256": "..."
  }
}
```

Non-shell actions may omit command fields, but they must still include enough
structured receipt data to explain what happened.

## Projections

Projections are derived views. They are not the source of truth.

### `projections/run.json`

Full latest run state:

- run status
- outputs
- latest results
- ordered step attempts
- current error
- session bindings

Write policy:

- rewrite atomically after every terminal node outcome
- rewrite atomically when the overall run status changes
- it may lag behind active heartbeats, because `live.json` covers that case

### `projections/live.json`

Minimal liveness view:

- current node
- current node type
- current node started at
- last heartbeat
- waiting status
- current error

Write policy:

- rewrite atomically at run start
- rewrite atomically at every node start
- rewrite atomically at every heartbeat
- rewrite atomically at every terminal node outcome
- this is the only projection that should update during heartbeats

### `projections/steps.json`

Ordered node-attempt receipts, one entry per attempt, with:

- `attemptId`
- `nodeId`
- `nodeType`
- `outcome`
- `startedAt`
- `finishedAt`
- key references to ACP/action artifacts

This is the easiest projection for external viewers to read directly.

Write policy:

- rewrite atomically after every terminal node outcome
- entries are append-only in logical order
- each entry represents one node attempt
- once written, an earlier attempt entry must not be mutated

## Projection stability

The projections exist for convenience, but they should still be stable enough
that simple tools can rely on them for years.

That means:

- keep projection filenames fixed
- keep field names additive
- never require viewers to scan temporary files
- never encode meaning in implicit array positions when an explicit id exists

## Session bundles

Every session used by the run must have a local replay copy under `sessions/`.

### `binding.json`

Stores the flow-session binding metadata:

- handle
- binding key
- agent name and command
- cwd
- acpx record id
- acp session id
- optional agent session id

### `record.json`

Stores the normalized session record snapshot used for replay:

- title
- normalized messages
- token usage
- mode/model state
- metadata needed for readable replay

### `events.ndjson`

Stores the raw ACP event stream for the bundled session.

Replay readers should prefer the bundled session event file over the global
session store.

### Session event envelope

The bundled session event stream is not just raw JSON-RPC lines. It needs a
small stable envelope so ACP ranges can be addressed precisely.

Each line in `sessions/<id>/events.ndjson` must look like:

```json
{
  "seq": 120,
  "at": "2026-03-26T18:56:16.102Z",
  "direction": "outbound",
  "message": {
    "jsonrpc": "2.0",
    "id": "1",
    "method": "prompt",
    "params": {}
  }
}
```

Required fields:

- `seq`: strictly increasing integer within that bundled session file
- `at`: ISO timestamp
- `direction`: `outbound` or `inbound`
- `message`: the raw ACP JSON-RPC payload

### Session bundle write policy

To keep replay deterministic and simple:

- create `sessions/<id>/binding.json` immediately when the session is first
  bound to the run
- create `sessions/<id>/record.json` immediately when the binding is created
- append to `sessions/<id>/events.ndjson` whenever ACP messages are observed for
  that session
- rewrite `sessions/<id>/record.json` atomically after every ACP node outcome
- rewrite `sessions/<id>/record.json` atomically again at run completion or
  failure

That gives external replay tools a stable normalized snapshot plus the exact ACP
event stream that produced it.

## Artifacts

Artifacts are immutable content-addressed files referenced by trace events or
projections.

### Artifact reference shape

```json
{
  "path": "artifacts/sha256-2b1f....txt",
  "mediaType": "text/plain",
  "bytes": 1842,
  "sha256": "2b1f..."
}
```

### Rules

- artifact paths are bundle-relative
- artifacts are immutable once written
- large or multi-line payloads should use artifact refs instead of bloating the
  trace log
- readers must tolerate unknown media types

Use artifacts for:

- prompt text
- raw ACP output
- parsed ACP output when large
- shell stdout/stderr
- fetched external JSON
- rendered comments

Do not use artifacts for tiny scalar fields that fit cleanly inline.

## Versioning and compatibility

- `manifest.json` owns the bundle schema version
- the trace envelope version is declared separately by `traceSchema`
- new fields must be additive
- new event types are allowed
- readers must ignore unknown fields and unknown event types
- removing or changing required semantics requires a new schema version

## Relationship to current storage

The current flow store already writes:

- `run.json`
- `live.json`
- `events.ndjson`

That should evolve into this bundle layout rather than being replaced outright.

The important shifts are:

- add `manifest.json`
- snapshot the structural `flow.json` that ran
- bundle session replay data inside the run
- add explicit ACP range linkage per ACP node attempt
- treat the append-only trace as the source of truth

## Implementation choices fixed by this spec

These choices are intentionally fixed here so implementation stays simple and
stable:

- `trace.ndjson` is the source of truth for the run bundle
- `projections/steps.json` is rewritten after each terminal node outcome, not
  only once at the end
- bundled session `record.json` is rewritten after each ACP node outcome
- bundled session `events.ndjson` uses a small envelope with its own `seq`
- ACP node outcomes link to both normalized message ranges and raw event ranges
- all large payloads are referenced through immutable artifacts

This should be enough to implement replay and visualization without inventing
new semantics during coding.

## External viewers

This spec is intentionally viewer-agnostic.

An external tool can:

1. open `manifest.json`
2. load `projections/steps.json` for the graph/timeline
3. follow ACP and action references into bundled sessions and artifacts
4. optionally replay the trace directly for a richer UI

That is the intended integration shape.
