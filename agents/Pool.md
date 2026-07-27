# Pool

- Built-in name: `pool`
- Default command: `pool acp`
- Upstream: [Poolside pool](https://github.com/poolsideai/pool)

`acpx pool` launches the installed `pool` CLI through its ACP stdio entrypoint. Install `pool` using the [official instructions](https://github.com/poolsideai/pool#install), then run `pool login` before using it through `acpx`. Poolside stores its configuration and credentials under `~/.config/poolside/`.

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
      "argv": ["pool", "acp"]
    }
  }
}
```
