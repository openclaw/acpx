# Pool

- Built-in name: `pool`
- Default command: `pool acp`
- Upstream: [Poolside](https://poolside.ai)

`acpx pool` launches the installed `pool` CLI through its ACP stdio entrypoint (`pool acp` starts the ACP server for Poolside's coding agent). Install `pool` and complete its normal authentication flow with `pool login` before using it through `acpx`; credentials are stored under `~/.config/poolside/`.

Examples:

```bash
acpx pool sessions new
acpx pool 'review this branch'
acpx pool exec 'summarize this repository'
```

If your Poolside install exposes ACP through a different command, override the built-in in `~/.acpx/config.json`:

```json
{
  "agents": {
    "pool": {
      "command": "pool acp"
    }
  }
}
```
