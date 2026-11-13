# OpenClaw

- Built-in name: `openclaw`
- Default command: `openclaw acp`
- Upstream: [openclaw/openclaw](https://github.com/openclaw/openclaw)

The built-in launches the installed `openclaw` command through its ACP entrypoint.

```bash
acpx openclaw sessions new
acpx openclaw 'your prompt'
acpx openclaw exec 'your prompt'
```

See [Sessions](../docs/sessions.md) for persistent and one-shot behavior, and [Custom agents](../docs/custom-agents.md) for launch overrides.

## Resuming existing sessions

ACPX restores OpenClaw sessions through `session/resume`, including callers that
request `session/load`. Recovery requires advertised resume support and never
falls back to a fresh session when the target is missing. Update OpenClaw if it
only advertises load support; explicitly create a new session for fresh work.

Resume requests include `_meta.requireExisting: true` and `_meta.sessionKey`.
UUID ACP session IDs use OpenClaw's default `acp-bridge:<id>` gateway key; explicit
gateway keys remain unchanged. Explicit `--session` and `--session-label` launch
routing is preserved for UUIDs instead of replacing it with the default gateway
key. Detection uses the `openclaw acp` launch command
or the advertised `openclaw-acp` agent name, including custom launchers.
