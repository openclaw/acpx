---
title: Flow Replay Live Transport
description: Real-time viewer transport and state-sync model for in-progress flow runs.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-03-31
---

# Flow Replay Live Transport

## Why this document exists

The replay viewer currently loads one saved run bundle at a time as a static
snapshot.

That is no longer enough.

The viewer now needs to support:

- showing an already-open run as `running` while it is still in progress
- tracking that run live without a manual refresh
- rewinding through the already-recorded history while new steps continue to
  arrive
- serving as the future base for operator-console actions

This document specifies the real-time transport and state model for that
viewer.

## Core decision

The replay viewer should use a **single WebSocket connection** from browser to
viewer backend.

That connection should carry:

- an initial **full snapshot**
- then **JSON Patch+** updates against a single in-memory state object

The important boundary is:

- the browser patches **viewer state**
- it does **not** patch individual bundle files on disk

For the patch primitive itself, see
[docs/json-patch-plus.md](./json-patch-plus.md).

## Pinned decisions

These choices are fixed for the first implementation and should not be
re-decided during coding:

- Use **JSON Patch+ exactly as documented** in
  [docs/json-patch-plus.md](./json-patch-plus.md).
- Patch **one semantic viewer-state object** per subscription, not individual
  bundle files.
- Keep the subscription split:
  - `runs` for sidebar summaries
  - `run:<runId>` for the selected run's full live state
- Use **snapshot first, then patches** for every subscription.
- Every patch must carry `fromVersion` and `toVersion`.
- On version mismatch or patch-application failure, the client must request a
  fresh snapshot instead of attempting partial recovery.
- In v1, only the **selected run** receives full live conversation and trace
  growth. Other runs receive sidebar summary updates only.
- The server computes patches from **semantic viewer state**, not by patching
  storage files directly.
- The on-disk bundle format stays unchanged in this work.

## Goals

- Keep the existing replay viewer semantics and rewind model
- Show live `running` and `waiting` status in the sidebar without manual refresh
- Let the active run keep growing while the user can still scrub backward
- Keep the browser state close to the current loaded bundle shape
- Support future two-way operator actions on the same transport
- Keep the source layer replaceable when runner and viewer move to different
  servers

## Non-goals

- Do not replace the saved run-bundle format
- Do not turn the viewer protocol into "diffs of manifest.json/run.json/etc."
- Do not require browser filesystem access for live updates
- Do not make the browser re-fetch the whole bundle every second
- Do not define operator-control messages in this first transport spec beyond
  reserving space for them

## Why WebSocket

Polling is no longer the right default because the viewer is expected to become
an operator console, not only a passive monitor.

That means the transport should be ready for:

- live updates from server to browser
- future actions from browser to server

For that reason:

- WebSocket is the right baseline transport
- SSE would only be the better choice for a permanently read-only viewer

## Why not patch bundle files directly

This would be the wrong model:

- patch `manifest.json`
- patch `projections/run.json`
- patch `projections/live.json`
- patch `steps.json`
- patch `trace.ndjson`
- patch bundled session event files

That makes the transport too file-oriented and forces the browser to rebuild a
semantic view from storage-level fragments.

The browser should instead hold one semantic viewer state object and patch that
object directly.

## State model

The browser should keep one canonical state object per subscribed run.

That state should stay **close to the current `LoadedRunBundle` shape**, because
the existing viewer already knows how to render and replay that shape.

The transport should therefore introduce a new **wire format**, not a totally
different viewer model.

### Required property

The state object must contain enough accumulated history to support:

- rewinding while the run is still progressing
- rendering the existing graph overlay
- rendering ACP conversation/session slices for already-recorded steps

So the transport state cannot be only:

- current node
- current status
- latest step

It must carry the growing history.

## Canonical run state shape

The exact TypeScript interfaces may reuse or derive from existing viewer types,
but the browser should conceptually hold something like this:

```ts
type ViewerRunLiveState = {
  schema: "acpx.viewer-run-live.v1";
  runId: string;
  version: number;
  sourceType: "recent";
  sourceLabel: string;

  manifest: {
    runId: string;
    flowName: string;
    runTitle?: string;
    startedAt: string;
    finishedAt?: string;
  };

  flow: FlowDefinitionSnapshot;

  run: {
    runId: string;
    flowName: string;
    runTitle?: string;
    status: "running" | "waiting" | "completed" | "failed" | "timed_out";
    statusDetail?: string;
    currentNode?: string;
    startedAt: string;
    updatedAt: string;
    finishedAt?: string;
    error?: string;
  };

  steps: FlowStepRecord[];
  trace: FlowTraceEvent[];

  sessions: Record<
    string,
    {
      id: string;
      binding: FlowSessionBinding;
      record: SessionRecord;
      events: FlowBundledSessionEvent[];
    }
  >;
};
```

### Notes on this shape

- `flow` is effectively static after the first snapshot
- `run` is the authoritative merged run state for the viewer
- `steps`, `trace`, and `sessions.*.events` grow over time
- the viewer should treat this as the canonical replayable state for a live run

## Sidebar state shape

The recent-runs sidebar should have its own subscribed state.

That avoids re-sending every active run's full history just to update one status
dot.

```ts
type ViewerRunsState = {
  schema: "acpx.viewer-runs.v2";
  version: number;
  order: string[];
  runsById: Record<
    string,
    {
      runId: string;
      flowName: string;
      runTitle?: string;
      status: "running" | "waiting" | "completed" | "failed" | "timed_out";
      statusDetail?: string;
      currentNode?: string;
      startedAt: string;
      updatedAt: string;
      finishedAt?: string;
    }
  >;
};
```

This state is intentionally keyed. The sidebar is a sorted, fast-changing list,
so object-keyed summaries plus a separate `order` array produce much more
stable live patches than index-based patching of an array of objects.

## Subscription model

One WebSocket connection may carry multiple subscriptions.

Required subscriptions:

- `runs`
- `run:<runId>`

That gives the browser:

- a live sidebar runs index
- a live detailed view for the selected run

Only the selected run subscription receives full live history growth. The
sidebar subscription remains summary-only.

For finished replay, the viewer may render session content from reconstructed
session records. The active live ACP turn is different. Tool calls, tool
updates, and streamed agent text arrive as lower-level session events first and
may not yet be fully folded into a settled `record.messages` shape. If the
viewer renders an active live turn only from reconstructed session records,
tool calls and tool results can appear late or inconsistently during the
in-progress turn.

The rule is:

- finished or scrubbed replay may render from reconstructed session records
- the active live ACP turn should render directly from live session events
- reconstructed session records remain the fallback once the turn is settled

## Message schema

### Client to server

```json
{ "type": "hello", "protocol": "acpx.replay.v1" }
{ "type": "subscribe_runs" }
{ "type": "unsubscribe_runs" }
{ "type": "subscribe_run", "runId": "2026-03-29T101604499Z-pr-triage-8fe34079" }
{ "type": "unsubscribe_run", "runId": "2026-03-29T101604499Z-pr-triage-8fe34079" }
{ "type": "resync_runs" }
{ "type": "resync_run", "runId": "2026-03-29T101604499Z-pr-triage-8fe34079" }
{ "type": "ping" }
```

### Server to client

```json
{ "type": "ready", "protocol": "acpx.replay.v1" }
{ "type": "pong" }

{ "type": "runs_snapshot", "version": 12, "state": { ... } }
{ "type": "runs_patch", "fromVersion": 12, "toVersion": 13, "ops": [ ... ] }

{
  "type": "run_snapshot",
  "runId": "2026-03-29T101604499Z-pr-triage-8fe34079",
  "version": 41,
  "state": { ... }
}
{
  "type": "run_patch",
  "runId": "2026-03-29T101604499Z-pr-triage-8fe34079",
  "fromVersion": 41,
  "toVersion": 42,
  "ops": [ ... ]
}

{ "type": "error", "code": "version_mismatch", "message": "..." }
```

## Patch rules

### Patch format

Use **JSON Patch+** as defined in
[docs/json-patch-plus.md](./json-patch-plus.md).

That means:

- all standard RFC 6902 JSON Patch operations remain valid
- the transport also allows `append`
- patch application failure triggers a resync

There are no extra transport-specific patch operations beyond JSON Patch+.

### Versioning

Each subscribed state stream has its own monotonically increasing version:

- `runs.version`
- `run.version`

Patch contract:

- client applies a patch only if `fromVersion === currentVersion`
- after successful apply, client updates to `toVersion`
- if the version does not match, client must request resync

### Snapshot fallback

The server may send a fresh snapshot instead of a patch when:

- the client resyncs
- the server restarted
- the state changed too much for a patch to be worth sending
- the diff algorithm cannot produce a clean patch

The client must not attempt best-effort recovery from partially applied
patches. Any patch failure is a hard resync boundary.

## Structural invariants

To keep live rewind simple, the transport must preserve these rules:

- `flow` does not change during a run
- `steps` are append-only in execution order
- `trace` is append-only in `seq` order
- `sessions.*.events` are append-only in event order
- a terminal run state does not return to `running`

The patch generator should preserve those invariants.

## V1 live streaming scope

The first implementation must stream enough information for the selected run to
feel truly live.

That includes:

- live `run` status and `currentNode`
- live `steps` growth and step state changes
- live `trace` growth for the selected run
- live `sessions.*.events` growth for the selected run, including streamed ACP
  text as it arrives

That does not include:

- full history payloads for every run in the sidebar
- operator-control messages yet
- any storage-format rewrite

## Server architecture

The viewer server should gain a transport-oriented source abstraction:

```ts
type ViewerRunSource = {
  getRunsSnapshot(): Promise<ViewerRunsState>;
  getRunSnapshot(runId: string): Promise<ViewerRunLiveState>;
  subscribeRuns(listener: (state: ViewerRunsState) => void): () => void;
  subscribeRun(runId: string, listener: (state: ViewerRunLiveState) => void): () => void;
};
```

### Why this abstraction matters

The runner and viewer may soon move to different servers.

So the browser must not depend on "server reads local files from the same
machine forever."

The browser should speak to a stable viewer API.

The server-side source may then be implemented as:

- local filesystem-backed source now
- remote HTTP or internal service source later
- shared durable-store source later

without changing the browser transport contract.

### Patch source rule

The viewer server may still read bundle files as inputs, but the websocket
transport must operate on semantic state:

1. load or update semantic viewer state on the server
2. compute JSON Patch+ against that state
3. emit snapshot or patch messages

Do not treat the websocket protocol as "live diffs of bundle files."

## Initial source implementation

The first server implementation may still read the existing run bundles from:

```text
~/.acpx/flows/runs/<run-id>/
```

But it should do so through the source abstraction above.

The local source should:

- build `ViewerRunsState` from manifest + live/run projections
- build `ViewerRunLiveState` from the same bundle data the viewer already reads
- detect changes and publish new snapshots to subscribers

The local change detector may use:

- `fs.watch`
- periodic polling
- or a hybrid of both

That choice is an implementation detail.

The important API rule is:

- browser sees WebSocket snapshot + patch messages
- not filesystem semantics

## Update coalescing

The server should coalesce bursty live updates briefly before emitting patches.

For v1, use a target coalescing window of about `50ms` per subscription.

That keeps streaming text responsive while avoiding one websocket frame per tiny
token or filesystem write.

## Client architecture

The browser should keep:

- one `runs` state
- zero or one subscribed `run` detail state

The browser flow should be:

1. open WebSocket
2. `hello`
3. `subscribe_runs`
4. render sidebar from `runs_snapshot`
5. when a run is selected, `subscribe_run`
6. render the existing replay UI from that state
7. apply incoming patches to the in-memory state

## Rewind behavior during live updates

This is a core product requirement.

The client must not throw away rewind position when new steps arrive.

Required behavior:

- if the user is following the live edge, new steps advance the visible end
- if the user has scrubbed backward, keep their selected replay position stable
- the timeline length may grow while selection stays where the user left it
- the viewer may expose "jump to live" if helpful, but it must not yank the
  user forward automatically once they have rewound manually

## Sidebar behavior

If the active run is still in progress when the viewer opens:

- it should immediately render as `running`
- the status dot and label should stay live
- the current node should update live

That sidebar state should come from the live `runs` stream, not from a static
load-time snapshot.

## Reconnections and resync

On reconnect:

1. reopen WebSocket
2. send `hello`
3. resubscribe to `runs`
4. resubscribe to the selected `run`, if any
5. accept fresh snapshots

If patch application fails:

- discard the broken local stream state
- request a fresh snapshot

The client should not try to recover by guessing missing patches.

Do not rely on replaying an unknown missed backlog after reconnect. Fresh
snapshots are the canonical recovery path.

## Future operator actions

This spec intentionally reserves the same WebSocket for future two-way actions,
such as:

- cancel run
- retry node
- approve external action
- toggle follow/live mode

Those actions are out of scope for this document, but this is why WebSocket is
the chosen transport rather than a read-only push channel.

## Implementation phases

### Phase 1

- add `ViewerRunSource`
- add `runs` and `run` snapshots on the server
- add WebSocket endpoint
- add JSON Patch generation and versioning
- make the browser subscribe and render live status

### Phase 2

- preserve scrub position while history grows
- add explicit jump-to-live UX
- optimize diff generation if large traces become expensive

### Phase 3

- add operator/control messages on the same socket
- allow a non-filesystem source without changing browser code

## Testing requirements

### Server tests

- snapshot generation for runs index
- snapshot generation for one run
- patch generation preserves append-only invariants
- version mismatch forces resync behavior

### Client tests

- runs snapshot + patch update sidebar status from `completed` to `running` and
  `running` to terminal
- run snapshot + patch extends steps/trace/session events without losing old
  history
- rewound selection remains stable when new steps arrive
- live-edge selection advances when the user is still following the newest step

### Integration tests

- simulated in-progress run appears as `running` in the viewer
- current node updates live without a manual refresh
- selected live run gains new steps while the user can still rewind
- reconnect triggers snapshot resubscribe and state recovery

## Decision summary

The viewer should move to:

- one WebSocket connection
- snapshot + JSON Patch+ updates
- patches against one semantic viewer state object
- state that stays close to the existing replay bundle shape
- full live history only for the selected run, with summary-only sidebar
  updates for the rest

It should not move to:

- file-by-file patch transport
- live status only without history
- full-bundle polling on every heartbeat
