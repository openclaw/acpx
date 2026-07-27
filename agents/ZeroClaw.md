# ZeroClaw

- Built-in name: `zeroclaw`
- Default command: `zeroclaw acp`
- Upstream: https://github.com/zeroclaw-labs/zeroclaw

`acpx zeroclaw` starts ZeroClaw's built-in ACP server (`zeroclaw acp`), a JSON-RPC 2.0
stdio server that implements Agent Client Protocol v1 (`protocolVersion: 1`, no auth
methods). The `channel-acp-server` feature it needs is included in ZeroClaw's default
build, so a standard `zeroclaw` install works out of the box; a binary compiled without
it exits, reporting that the `channel-acp-server` feature is required.

## Agent selection

acpx's `session/new` does not pass a ZeroClaw agent alias, so the server picks the
session's agent from your ZeroClaw config in this order:

1. `acp.default_agent`, when set.
2. The single `[agents.<alias>]` entry, when exactly one agent is configured.

Single-agent setups therefore need no extra configuration. Multi-agent configs must set
`acp.default_agent`, otherwise `session/new` fails, reporting that it requires an
`agentAlias`.

## Notes

- Text prompts only — the server advertises no image, audio, or embedded-context prompt
  capability.
- Session resume/close (acpx `ensure` and reuse) is advertised when ZeroClaw's ACP
  session store is available.
- MCP tools are opt-in per agent via `[agents.<alias>].acp_enable_mcp` (off by default);
  the `mcpServers` acpx sends on `session/new` are ignored.
- `zeroclaw acp --max-sessions <n>` and `--session-timeout <secs>` bound concurrency.
  Override the built-in command in acpx config to pass them.

## Connecting to a running gateway

To route acpx to an already-running ZeroClaw gateway/daemon instead of spawning a fresh
in-process server, override the built-in command to use `zeroclaw-acp-bridge`, which
bridges stdio to the gateway's ACP-over-WebSocket endpoint:

```json
{
  "agents": {
    "zeroclaw": {
      "command": "zeroclaw-acp-bridge"
    }
  }
}
```

The bridge is a separate Cargo binary target and is not included in ZeroClaw's normal
prebuilt archives or installer, so build/install `zeroclaw-acp-bridge` from the ZeroClaw
source tree before using this override. It reads the gateway URL from the local ZeroClaw
config. When gateway pairing is active, run `zeroclaw gateway get-paircode --new`, then
start the bridge once with `zeroclaw-acp-bridge --pair-code <code>` to cache a token; an
existing token can instead be supplied through `ZEROCLAW_ACP_BRIDGE_TOKEN`.
