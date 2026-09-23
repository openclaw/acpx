---
title: Sessions
description: Persistent multi-turn ACP sessions in acpx — scope rules, named sessions, soft-close, prune, queue ownership, and crash recovery.
---

`acpx` sessions are how multi-turn agent conversations survive between invocations. A session is a JSON record on disk plus, when active, a queue owner process that holds the live ACP connection.
The session record tracks the logical conversation; the queue owner lease is the source of truth for whether `acpx` currently expects a helper process to be alive.

## Scope key

Every session is keyed by a tuple:

```text
(agentCommand, absoluteCwd, optional name)
```

That is what makes `acpx codex` in `~/repos/api` and `acpx codex` in `~/repos/web` resume different conversations, and why `-s backend` and `-s docs` can run side by side in the same repo.

`agentCommand` comes from either the built-in registry, an unknown positional name (treated as a raw command), or `--agent <command>`. Two sessions with different commands are different sessions even if everything else matches.

Local discovery reads the saved session records and uses their current scope, closed state, IDs, and last-used times. A legacy `index.json` is ignored. In the local store, a record's filename must match its encoded local ID; mismatched copies are ignored. Lookup by an exact local record ID reads that file directly; other lookups scan the saved records. Concurrent writes are observed per record, rather than as one atomic snapshot of the entire store.

## Lifecycle commands

```bash
acpx codex sessions                  # list (alias for `sessions list`)
acpx codex sessions list             # list agent sessions via ACP when supported
acpx codex sessions list --filter-cwd . --cursor <cursor>
acpx codex sessions list --local     # list saved acpx records
acpx codex sessions new              # create a fresh cwd-scoped default session
acpx codex sessions new --name api   # create a fresh named session
acpx codex sessions ensure           # idempotent: existing or create
acpx codex sessions ensure --name api
acpx codex sessions show             # metadata for the cwd-scoped default
acpx codex sessions show api         # metadata for the named session
acpx codex sessions history          # last 20 turn previews
acpx codex sessions history --limit 50
acpx codex sessions export api --output api-session.json
acpx codex sessions import api-session.json --name api-restored
acpx codex sessions close            # soft-close cwd default
acpx codex sessions close api        # soft-close named session
acpx codex sessions prune --dry-run
acpx codex sessions prune --older-than 30
acpx codex sessions prune --before 2026-01-01 --include-history
```

Top-level `acpx sessions …` defaults to `codex`.

`sessions list` prefers the agent-side ACP `session/list` method when the
selected agent advertises `sessionCapabilities.list`. JSON output includes the
agent's `SessionInfo` fields, any `_meta` metadata, and `nextCursor` for manual
pagination. Use `--filter-cwd <dir>` to send the ACP cwd filter; relative paths
resolve against global `--cwd`. Use `--local` when you specifically want the
saved `~/.acpx/sessions` records.

## Auto-resume by directory walk

Prompt commands (`acpx codex 'fix tests'`, `acpx codex prompt …`) resume an existing session rather than create one. Lookup is a directory walk:

1. Detect the nearest git root by walking up from the absolute `cwd`. A `.git` directory or file marks the root, including worktrees and submodules.
2. If a git root exists, walk from `cwd` up to that root **inclusive**, checking each directory.
3. If no git root is found, only check `cwd` exactly — no parent walk.
4. At each directory, find the first **active** (non-closed) session matching `(agentCommand, dir, optionalName)`.
5. If a match is found, use it. Otherwise exit with code `4` and tell you to run `sessions new`.

This means most workflows feel like "I was talking to codex in this repo", regardless of whether you happen to be in `src/` or `docs/` when the next prompt fires.

```bash
cd ~/repos/api/src/auth
acpx codex 'remind me what we changed'   # resumes the session created at ~/repos/api
```

## Named sessions

`-s, --session <name>` adds the name into the scope key:

```bash
acpx codex sessions new --name backend
acpx codex sessions new --name docs
acpx codex -s backend 'fix the API pagination bug'
acpx codex -s docs    'rewrite the changelog'
```

Named sessions are independent. They do not share state, queue owners, or history.

## Sessions vs. ensure vs. new

| Command           | If a matching session exists  | If not                                       |
| ----------------- | ----------------------------- | -------------------------------------------- |
| `sessions new`    | Soft-close it, create a fresh | Create a fresh one                           |
| `sessions ensure` | Return it                     | Create a fresh one                           |
| (prompt commands) | Resume it                     | Exit `4` with guidance to run `sessions new` |

`new` is the explicit "I want to start over" verb. `ensure` is the idempotent "give me a session" verb for scripts. Bare prompt is conservative: it never auto-creates so you do not accidentally fork a session by running from the wrong directory.

## Soft-close

`sessions close` does not delete anything. It marks the record `closed: true` with `closedAt`, asks any active queue owner to send ACP `session/close`, and tears down adapter processes.

Closing during a turn preserves its final cancellation output, usage and configuration updates in the closed record and history.

- Closed sessions stay on disk with their full record and history.
- Auto-resume by scope skips closed sessions.
- Closed sessions can still be loaded explicitly through embedding APIs.
- `sessions prune` is the explicit way to delete closed records.

## Export / import

`acpx` persists sessions per cwd in `~/.acpx/sessions/`. To move a session between machines or share one with a teammate:

```bash
# On the source machine:
acpx codex sessions export my-debug-session --output debug.json

# On the destination machine:
acpx codex sessions import debug.json --name debug-on-laptop
```

Export refuses to run if the session is locked by a live queue owner. Run `acpx codex sessions close my-debug-session` first.

Exports preserve event order across rotated and active segments, including segments containing hundreds of thousands of events.

Exports publish complete archives atomically. On POSIX systems, archives and
imported history use `0600` permissions. Exporting preserves the selected output
directory's permissions and follows existing or dangling output symlinks to their
targets. Existing non-regular output targets, such as named pipes, are rejected.
Live event segments also use `0600`; their append and rotation behavior
is unchanged. Event-log files must be regular files, not symlink or hardlink aliases.

The archive is plain JSON. Paths are stored relative to home, so an imported session lands at `~/<original-cwd-relative>` on the destination machine without embedding the source machine's absolute cwd. Override with `--cwd`.

Imports keep the archive's provider session id, reopen the copied session as an idle local record, and clear source-machine process metadata. Imported sessions must resume that provider session; if the destination agent cannot load it, prompts fail clearly instead of starting an empty conversation. If the destination already has an active session for the same `(agent, cwd, name)` scope, import fails; pass `--name` or `--cwd` to choose a different scope. If a local record already uses the same provider session id, prune or remove that record before importing.

An imported session becomes discoverable after its complete history has been written. If writing the history fails, the import leaves no local session that blocks retrying the archive.

## Prune

`sessions prune` removes closed records once you actually want them gone:

```bash
# Preview what would be deleted
acpx codex sessions prune --dry-run

# Delete closed sessions older than 30 days (by closeAt, falling back to lastUsedAt)
acpx codex sessions prune --older-than 30

# Delete closed sessions whose close time is before a date
acpx codex sessions prune --before 2026-01-01

# Also remove the per-session event-stream files
acpx codex sessions prune --include-history
```

Output:

- `text` — summary plus the pruned ids and close/last-used time
- `json` — `{ action, dryRun, count, bytesFreed, pruned }`
- `quiet` — one pruned session id per line

## Queue ownership

When a prompt is in flight, `acpx` becomes the **queue owner** for that session. Subsequent `acpx codex …` invocations submit through local IPC instead of starting a second adapter:

```bash
acpx codex 'run full test suite and triage failures'
# (still running)
acpx codex --no-wait 'after the suite, summarize root cause in 3 bullets'
acpx codex --no-wait 'and propose 1 follow-up fix'
```

Queue mechanics:

- Startup options pass directly to the detached owner through stdin; acpx does not create temporary bootstrap files containing credentials or session environment values.
- On Unix-like systems, the owner uses `/tmp/acpx-<home-hash>/<session-hash>.sock`; its lease is `~/.acpx/queues/<session-hash>.lock`. Windows uses a named pipe instead of a Unix socket.
- Sockets and lock files are owner-only.
- After the queue drains, the owner stays alive for an idle TTL (default `300s`) so quick follow-ups do not pay the spawn cost.
- Override TTL with `--ttl <seconds>`. `--ttl 0` keeps it alive indefinitely (until idle shutdown is otherwise triggered).
- Owner generation IDs are cryptographically random so rapid restarts cannot reuse a stale generation token.

On Windows, forced queue-owner cleanup records observed descendants in the existing
lease before terminating the process tree. If cleanup fails, a later client can
retry it even after the owner exits. The lease remains pending until every recorded
process incarnation is gone; unavailable process information or an invalid cleanup
receipt leaves it intact and reports an error. Update all participating clients:
older versions can discard this receipt when they refresh or release the lease.
This recovery covers witnessed descendants. Abrupt death before observation still
requires host supervision.

Persistent turns from flows and CLI prompts share one owner for each saved session.
A waiting prompt reads history after the previous turn finishes its final checkpoint,
so both completions are retained. Waiting can be cancelled or timed out. A live
writer keeps ownership through its final checkpoint and cleanup. Competing processes
recovering a dead writer remain serialized, and cancellation stops a waiting
acquisition without releasing an admitted turn.

Turn ownership uses a private guard alongside the existing session marker. A guard
with a definitely dead owner can be recovered; live owners never expire by age.
Malformed guards and interrupted-reclamation residue fail closed and require
cleanup only after all competing acpx processes have stopped. Older running acpx
versions do not honor this guard, so the stronger exclusion applies when all
participants use the updated version.

## --no-wait

An independent client can follow retained and live prompt events with [`sessions watch`](session-watch.md), including turns submitted with `--no-wait`.

By default the submitter blocks until the queued prompt completes, streaming events back. `--no-wait` returns as soon as the running queue owner acknowledges the submission. Useful for scripted "queue up follow-ups" patterns.

```bash
acpx codex --no-wait 'after the current turn ends, write the release notes'
```

## Cancelling

`Ctrl+C` during an active turn sends ACP `session/cancel` first, waits briefly for `stopReason=cancelled`, and only force-kills if cancellation does not finish in time.

The `cancel` subcommand sends the same cooperative cancel without a terminal signal:

```bash
acpx codex cancel
acpx codex cancel -s backend
```

If nothing is running, `cancel` exits success with `nothing to cancel`.

See [Session control](session-control.md) for `set-mode`, `set <key> <value>`, and `set model`.

## Crash recovery

Saved sessions may include a cached adapter PID from the last connected helper process. That PID is a runtime hint, not proof that the logical session is closed or broken. If a cached PID is gone on the next prompt:

1. `acpx` respawns the agent.
2. Attempts ACP `session/resume` with the saved provider session id when the agent advertises it, otherwise ACP `session/load`.
3. Falls back to `session/new` if reconnecting fails, transparently updating the saved record.

This makes long-running scripted sessions resilient to crashes, OS restarts, and adapter upgrades. Metadata updates received while reconnecting, including available commands, remain available after saved settings are replayed.

## Status

`acpx codex status` reports local queue-owner health, not whether a prompt is currently active:

| Text/quiet state | JSON `status` | Meaning                                                                                |
| ---------------- | ------------- | -------------------------------------------------------------------------------------- |
| `running`        | `alive`       | Queue owner is healthy, including while it waits during its idle TTL.                  |
| `idle`           | `idle`        | Saved session is resumable and no queue owner is present.                              |
| `dead`           | `dead`        | A queue-owner lease remains but is unhealthy, or the recorded agent exit was abnormal. |
| `no-session`     | `no-session`  | No saved record matches this scope.                                                    |

Checks use local lease, process, and socket information without an ACP request to the agent. Use [Watching sessions](session-watch.md) for turn events and completion.
`closed` describes the logical session lifecycle. A helper process can exit while the session remains open and resumable. Status reports a PID only when a live queue-owner lease ties that process to the session; queue owner liveness comes from `~/.acpx/queues/*.lock` plus its heartbeat and process probe.

## CWD scoping

`--cwd <dir>` sets both:

- the starting point for the directory-walk lookup
- the exact `cwd` for new sessions created with `sessions new`

```bash
acpx --cwd ~/repos/shop codex sessions new --name pr-842
acpx --cwd ~/repos/shop codex -s pr-842 'review PR #842'
```

CWD is stored as an absolute path in the scope key.

## Session metadata fields

`sessions show` with `--format json` includes the stored normalized conversation,
including text, thoughts, and tool results keyed by the adapter's opaque tool IDs.
Retained text and thought chunks keep their whitespace. `sessions history` joins
and trims content for previews; the existing runtime retention limits still apply
to saved content.

`sessions show` and the JSON form of `sessions new`/`sessions ensure` and `status` include identity fields:

| Field            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `acpxRecordId`   | Local record id printed in `text` and `quiet` output              |
| `acpxSessionId`  | acpx-side session id (always present)                             |
| `agentSessionId` | Provider-native session id, **only when** the adapter exposes one |

Do not pass an `acpx` session id to a native provider CLI unless `agentSessionId` is also present.

## Embedded session lifecycle

Applications that need CLI processes to join the same live connection can use [`createSharedAcpRuntime()`](shared-sessions.md). The shared client uses the CLI's local session store and queue owner; the in-process runtime below retains caller-owned storage and callbacks.

Embedding hosts can call `findSession({ sessionKey, agent })` on `acpx/runtime`
to recover a persistent session handle after restart. It returns `undefined` when
the record is absent, and does not start an agent or change the record. Existing
closed records remain available. The handle uses the record's working directory
and session identities. `getStatus({ handle }).lastRequestId` reports the last
host request admitted to that session.

Compatible persistent `ensureSession()` calls can reuse a session during a turn;
they keep its original creation options and do not rewrite live conversation
state. Such reuse can also be awaited from host permission callbacks during a
control reconnect. Changing the working directory, adapter command/arguments, or
explicit resume identity requires the record's turns and controls to finish. An incompatible
ensure rejects with `ACP_SESSION_INIT_FAILED` while work is unfinished, without
cancelling or rerouting it. Wait for that work to finish, or use another session key.
An active close must also finish its turn before ensure can reopen that record.

Idle replacement waits for the old connection and pending saves to retire before
initializing its successor. Retirement failure rejects replacement and leaves
cleanup available for retry. Turns and controls on that same record wait for initialization;
other records, including distinct one-shot records, remain independent. A one-shot
ensure whose previously pending owner has closed creates a fresh record.

Pending one-shot reuse ignores undefined option fields and empty environment maps.
An explicit empty tool list still differs from omitted tools. Ensuring again after
a one-shot turn completes creates a fresh record.

For retained sessions, status and session operations retry pending checkpoint data
after storage recovers. Checkpoint retry saves current state without replaying the
agent request.

Call `shutdown()` when retiring a runtime. It cancels active prompts, closes owned
connections, and waits for admitted work and probes to finish. New sessions,
turns, controls and probes then reject. Stored sessions remain available for a
new runtime to resume. Hosts must still settle their own pending lifecycle
admission callbacks; shutdown cannot complete an external host operation.

Shutdown reports connection and checkpoint cleanup failures after all owned cleanup
has finished. A later cleanup save can recover data while an earlier failure in
that shutdown attempt still causes rejection. Earlier admitted operations keep
their own results; shutdown can recover a previously failed retirement in its
final cleanup pass. Repeated calls share the same shutdown result.

For temporary model inspection, use `ensureSession({ mode: "oneshot", ... })`,
`getStatus({ handle })`, and `close({ handle, discardPersistentState: true, ... })`.
Close requests ACP `session/close` and marks the host record closed for reset on
the next ensure. It does not delete that record or promise removal of an agent's
private session files.

## See also

- [Prompting](prompting.md) — implicit prompt, `prompt`, `exec`, stdin, `--file`, `--no-wait`.
- [Session control](session-control.md) — `cancel`, `set-mode`, `set <key>`, `set model`.
- [Output formats](output-formats.md) — JSON envelope for sessions/status payloads.
- [CLI reference](CLI.md#sessions-subcommand) — long-form spec and exit codes.

Embedding hosts can use optional [process lifecycle callbacks](runtime-process-lifecycle.md)
for launch admission and host-owned process tracking.
