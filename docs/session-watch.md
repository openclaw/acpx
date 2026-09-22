---
title: Watching sessions
description: Passively replay and follow a session through the CLI or shared runtime, with resumable cursors and settled turn results.
---

# Watching sessions

Watch a named session from another terminal:

```bash
acpx --format json pi sessions watch -s reviewer
```

Watching replays retained events and then follows new ones. Attaching, disconnecting, pressing Ctrl+C, or closing a watcher leaves the active turn running. Watching an idle session waits without starting an agent or extending the owner's idle TTL. A closed session finishes after replaying its retained events.

If the session closes while the consumer is handling an event, watching rereads
and drains retained history before finishing. An unfinished attempt still reports
an unknown outcome instead of becoming a successful end of the stream.

You can also select the session on the agent, as in `acpx pi -s reviewer sessions watch`. An explicit `watch -s` or `watch --name` takes precedence. Without either selector, watch uses the cwd's default session.

Session discovery reads records without creating or repairing the index. A readable session store does not need to be writable to watch it.

Use `--cursor <cursor>` to resume after the last received event:

```bash
acpx --format json pi sessions watch -s reviewer --cursor "$LAST_CURSOR"
```

Cursors are opaque, ordered within a local session record, and exclusive on resume. Do not decode or compare their strings. A malformed, foreign, future, or expired cursor produces an explicit error. Omit the cursor to replay the currently retained window.

The watch cursor is independent of ACP session-list pagination: place it after `watch`. A `--cursor` on the parent `sessions` command does not become a journal cursor.

## Shared runtime

The [shared runtime](shared-sessions.md) exposes the same stream:

```ts
const controller = new AbortController();
for await (const event of runtime.watchSession({
  handle,
  cursor: savedCursor,
  signal: controller.signal,
})) {
  savedCursor = event.cursor;
  if (event.type === "turn_result") {
    console.log(event.requestId, event.result.status);
  }
}
```

Breaking out of the loop, calling the iterator's `return()`, aborting its signal, or shutting down this shared client stops observation. Use the explicit cancellation methods when you want to cancel work. Custom stores used by the in-process runtime do not automatically publish this CLI/shared journal.

## Event contract

JSON output is NDJSON with three event kinds:

| Type           | Fields                           | Meaning                                                                                                                                                             |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`      | `cursor`, `requestId`, `message` | An ACP JSON-RPC message, associated with its current prompt attempt. The request ID is null when no attempt owns that message.                                      |
| `turn_started` | `cursor`, `requestId`            | The owner has selected an attempt and is preparing or dispatching it. The turn's separate `promptStarted` promise indicates actual ACP prompt transport acceptance. |
| `turn_result`  | `cursor`, `requestId`, `result`  | The owner has finished normal cleanup and checkpoint attempts. The result is `completed`, `cancelled`, or `failed`.                                                 |

`requestId` is the submitting acpx request ID; it is independent of the ACP message's own JSON-RPC `id`. Use `turn_result` for settlement. A raw ACP response containing `stopReason` can arrive before local finalization finishes.

The stream covers attempts selected for execution. Requests cancelled while still queued receive their ordinary cancellation response without starting an agent attempt or transcript.

Text output renders agent content and lifecycle lines with request IDs and cursors. Quiet output prints agent text. `--suppress-reads` also applies to watching; on resume, unclassified result/tool content is suppressed conservatively when its original announcement is unavailable. This flag suppresses raw read output, not text the agent independently writes about it.

## Recovery and retained history

If an owner disappears before recording a settled result, watching fails with `WATCH_OUTCOME_UNKNOWN`. The prompt may have executed. Resume from the last cursor after recovery and inspect the result before considering another submission. A replacement owner records an unfinished earlier attempt as failed with an unknown-outcome detail before starting the next attempt.

Older running owners lack watch support and produce `WATCH_OWNER_UNSUPPORTED`. Let an idle owner expire, or explicitly close the session before ensuring it again. Observers do not restart owners.

History retention remains the existing rotating journal policy. Replay reads bounded pages, approximately 1 MiB plus one larger event. A slow observer whose unread history has been rotated away receives a cursor-expired error rather than silently skipping events.

Watching can replay only events recorded after watch support is enabled. Earlier history remains available through `sessions read` and export. Portable imports start a fresh watch history; historical request IDs and local results are not invented.

The existing journal now includes local segment and lifecycle records alongside unchanged ACP messages. Direct `.stream.ndjson` consumers must distinguish these local records from entries with `jsonrpc: "2.0"`. Built-in history readers, prompt JSON output, and portable archives continue to expose ACP data without local journal markers. See the [session model](https://github.com/openclaw/acpx/blob/main/docs/2026-02-27-acpx-session-model.md) for the storage contract.
