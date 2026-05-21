---
title: Session control
description: cancel, set-mode, set, set model, and status — the verbs that adjust an in-flight or saved acpx session without restarting it.
---

These commands change live session state without restarting an adapter or losing history. They route through the queue owner when one is active, and reconnect directly otherwise.

## `cancel`

```bash
acpx codex cancel
acpx codex cancel -s backend
acpx cancel              # defaults to codex
```

Sends ACP `session/cancel` cooperatively:

- If a queue owner is running, the cancel is delivered through IPC.
- If a prompt is mid-turn, the agent receives `session/cancel`, completes any pending writes, and resolves with `stopReason=cancelled`.
- If nothing is running, `acpx` prints `nothing to cancel` and exits success.

This is the same semantics as `Ctrl+C` during a foreground turn, but available without a TTY signal — useful from scripts and other agents.

## `set-mode`

```bash
acpx codex set-mode auto
acpx codex set-mode plan -s backend
acpx set-mode auto       # defaults to codex
```

Calls ACP `session/set_mode`. The set of valid `<mode>` values is **adapter-defined** and not standardized across ACP. Common values seen in the wild:

| Adapter  | Modes                                          |
| -------- | ---------------------------------------------- |
| `codex`  | adapter-defined (see codex-acp release notes)  |
| `claude` | adapter-defined; `plan` and `auto` are typical |
| Others   | check upstream agent docs                      |

Unsupported mode ids are rejected by the adapter, often as `Invalid params`. `acpx` surfaces that error code unchanged.

`set-mode` routes through the queue owner when active and falls back to a fresh client connection otherwise.

## `set <key> <value>`

```bash
acpx claude set verbosity terse
acpx set model gpt-5.4         # defaults to codex
```

Calls ACP `session/set_config_option` with the literal `<key>` and `<value>`. Non-mode `set_config_option` values are persisted by `acpx` and replayed onto fresh adapter sessions when the adapter supports those config keys.

### `set model <id>`

`set model <id>` is a special-case interception. Some adapters expose model switching via ACP `session/set_model` rather than `session/set_config_option`. `acpx` always sends `session/set_model` for the `model` key so it works on every adapter that supports either method.

```bash
acpx codex set model 'gpt-5.2[high]'
acpx claude set model claude-sonnet-4-6
```

For setting the model at session creation instead, use the `--model` global flag. See [Prompting](prompting.md#models).

## `status`

```bash
acpx codex status
acpx codex status -s backend
acpx status              # defaults to codex
```

Reports local process status for the cwd-scoped session:

| State        | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `running`    | Queue owner alive and processing a prompt                      |
| `idle`       | Saved session resumable, no queue owner running                |
| `dead`       | Saved adapter PID is gone; next prompt will respawn and reload |
| `no-session` | No saved record matches this scope                             |

Plus, when applicable: session id, agent command, pid, uptime, last prompt timestamp, and last known exit code or signal for `dead`.

`status` is local — it uses `kill(pid, 0)` semantics and does not touch the agent. It is safe to run from automation that polls for queue readiness.

### Output

- `text`: key/value lines (default).
- `json`: full record with `acpxRecordId`, `acpxSessionId`, optional `agentSessionId`, plus state and timestamps.

`idle` is meaningful: it means the persistent session is saved and resumable, but no queue owner is currently running. The next prompt will start an owner and reconnect.

## Routing rules

All four commands (`cancel`, `set-mode`, `set`, `status`) try the queue owner first when one exists for the target session. If no owner is running:

- `cancel` short-circuits with `nothing to cancel`.
- `set-mode` and `set` reconnect to the saved adapter session and apply the change directly.
- `status` simply reports `idle` or `dead`.

This means it is always safe to call these from scripts without worrying about whether a queue owner happens to be running.

## See also

- [Prompting](prompting.md) — `--no-wait` and timeouts.
- [Sessions](sessions.md) — scope rules and queue ownership.
- [CLI reference](CLI.md#cancel-command) — formal command grammar.
