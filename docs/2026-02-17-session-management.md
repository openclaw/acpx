---
title: acpx Session Management
description: How acpx resumes, names, stores, and closes sessions including pid tracking and subprocess lifecycle.
author: Bob <bob@dutifulbob.com>
date: 2026-02-17
---

## Session model

`acpx` is conversational by default.

Session lookup is scoped by:

- agent command
- cwd
- optional session name (`-s <name>`)

No `-s` means the default cwd session for that agent command.

## Auto-resume behavior

For prompt commands:

1. `findSession` searches stored records by `(agentCommand, cwd, name?)`.
2. If no record exists, `createSession` creates ACP session + record.
3. `sendSession` starts a fresh adapter process and tries `loadSession`.
4. If load is unsupported or fails with known not-found/invalid errors, it falls back to `newSession`.
5. After prompt completes, record metadata is updated and re-written.

## Named sessions

`-s backend` creates a parallel conversation stream for the same agent and cwd.

Example:

- default session: `acpx codex 'fix tests'`
- named session: `acpx codex -s backend 'fix API'`

Both can coexist because names are part of the scope key.

## Session files

Stored under `~/.acpx/sessions/` as JSON files.

Record fields include:

- `id`
- `sessionId`
- `agentCommand`
- `cwd`
- `name` (optional)
- `createdAt`, `lastUsedAt`
- `pid` (adapter process pid, optional)
- `protocolVersion`, `agentCapabilities` (optional)

Writes are done via temp file + rename for safer updates.

## loadSession protocol flow

Resume path in `sendSession`:

1. start ACP client process
2. initialize protocol
3. `loadSession(sessionId, cwd, mcpServers: [])`
4. suppress replayed updates during load
5. wait for session-update drain
6. send new prompt

If resume fails with a fallback-eligible error, `newSession` is used and stored `sessionId` is replaced.

## PID tracking and process lifecycle

`acpx` stores the adapter pid in each session record to help with cleanup and diagnostics.

Lifecycle behavior:

- each command launches a new adapter subprocess
- records track pid of the latest process used
- `closeSession` tries to terminate the stored pid if still alive and likely matches expected command
- process termination uses `SIGTERM` then `SIGKILL` fallback
- signal handling (`SIGINT`, `SIGTERM`) closes client resources before exit

This keeps session files and local processes in sync while remaining robust to stale pids.
