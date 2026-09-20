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
