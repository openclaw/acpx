---
title: Sessions
description: Persistent multi-turn ACP sessions in acpx — scope rules, named sessions, soft-close, prune, queue ownership, and crash recovery.
---

`acpx` sessions are how multi-turn agent conversations survive between invocations. A session is a JSON record on disk plus, when active, a queue owner process that holds the live ACP connection.

## Scope key

Every session is keyed by a tuple:

```text
(agentCommand, absoluteCwd, optional name)
```

That is what makes `acpx codex` in `~/repos/api` and `acpx codex` in `~/repos/web` resume different conversations, and why `-s backend` and `-s docs` can run side by side in the same repo.

`agentCommand` comes from either the built-in registry, an unknown positional name (treated as a raw command), or `--agent <command>`. Two sessions with different commands are different sessions even if everything else matches.

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

1. Detect the nearest git root by walking up from the absolute `cwd`.
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

- Closed sessions stay on disk with their full record and history.
- Auto-resume by scope skips closed sessions.
- Closed sessions can still be loaded explicitly through embedding APIs.
- `sessions prune` is the explicit way to delete closed records.

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

- Owner generates a Unix socket at `~/.acpx/queues/<hash>.sock` (named pipe on Windows) and a `<hash>.lock` ownership file.
- Sockets and lock files are owner-only.
- After the queue drains, the owner stays alive for an idle TTL (default `300s`) so quick follow-ups do not pay the spawn cost.
- Override TTL with `--ttl <seconds>`. `--ttl 0` keeps it alive indefinitely (until idle shutdown is otherwise triggered).
- Owner generation IDs are cryptographically random so rapid restarts cannot reuse a stale generation token.

## --no-wait

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

Saved sessions track adapter PIDs. If a saved PID is dead on the next prompt:

1. `acpx` respawns the agent.
2. Attempts ACP `session/resume` with the saved provider session id when the agent advertises it, otherwise ACP `session/load`.
3. Falls back to `session/new` if reconnecting fails, transparently updating the saved record.

This makes long-running scripted sessions resilient to crashes, OS restarts, and adapter upgrades.

## Status

`acpx codex status` reports local process state:

| State        | Meaning                                                |
| ------------ | ------------------------------------------------------ |
| `running`    | Queue owner alive and processing a prompt              |
| `idle`       | Saved session resumable, no queue owner running        |
| `dead`       | Saved PID is gone; next prompt will respawn and reload |
| `no-session` | No saved record matches this scope                     |

Status checks are local (`kill(pid, 0)` semantics) — they do not touch the agent.

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

`sessions show` and the JSON form of `sessions new`/`sessions ensure` and `status` include identity fields:

| Field            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `acpxRecordId`   | Local record id printed in `text` and `quiet` output              |
| `acpxSessionId`  | acpx-side session id (always present)                             |
| `agentSessionId` | Provider-native session id, **only when** the adapter exposes one |

Do not pass an `acpx` session id to a native provider CLI unless `agentSessionId` is also present.

## See also

- [Prompting](prompting.md) — implicit prompt, `prompt`, `exec`, stdin, `--file`, `--no-wait`.
- [Session control](session-control.md) — `cancel`, `set-mode`, `set <key>`, `set model`.
- [Output formats](output-formats.md) — JSON envelope for sessions/status payloads.
- [CLI reference](CLI.md#sessions-subcommand) — long-form spec and exit codes.
