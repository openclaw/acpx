# Grok Build

- Built-in name: `grok-build`
- Default command: `grok agent stdio`
- Upstream: [xAI Grok Build](https://docs.x.ai/build/overview)

`acpx grok-build` launches the installed `grok` CLI through its ACP stdio entrypoint. Install Grok Build and complete its normal authentication flow before using it through `acpx`.

When Grok advertises `cached_token`, `acpx` asks the Grok ACP server to authenticate with its agent-managed cached login. For non-browser and automation environments where Grok advertises `xai.api_key`, `acpx grok-build` also accepts `XAI_API_KEY`.

Embedding hosts can narrow the environment that agents inherit with `agentProcessEnvAllow` or `agentProcessEnvBlock` (see [runtime-environment.md](../docs/runtime-environment.md#limiting-inherited-variables)). Both are off by default and the CLI does not set them, so `XAI_API_KEY` works as described above. When either list is set, `acpx` selects `xai.api_key` from `XAI_API_KEY` only if the agent would inherit it: an allowlist without `XAI_API_KEY`, or a blocklist that names it, skips this authentication method even though the key exists in the host environment. To keep it, list `XAI_API_KEY` in the allowlist and keep it off the blocklist, or grant it explicitly as `ACPX_AUTH_XAI_API_KEY`, which passes through both lists.

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
