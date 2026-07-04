# Grok Build

- Built-in name: `grok-build`
- Default command: `grok agent stdio`
- Upstream: [xAI Grok Build](https://docs.x.ai/build/overview)

`acpx grok-build` launches the installed `grok` CLI through its ACP stdio entrypoint. Install Grok Build and complete its normal authentication flow before using it through `acpx`.

When Grok advertises `cached_token`, `acpx` asks the Grok ACP server to authenticate with its agent-managed cached login. For non-browser and automation environments where Grok advertises `xai.api_key`, `acpx grok-build` also accepts `XAI_API_KEY`.

Examples:

```bash
acpx grok-build sessions new
acpx grok-build 'review this branch'
acpx grok-build exec 'summarize this repository'
```

If your Grok Build install exposes ACP through a different command, override the built-in in `~/.acpx/config.json`:

```json
{
  "agents": {
    "grok-build": {
      "command": "grok agent stdio"
    }
  }
}
```
