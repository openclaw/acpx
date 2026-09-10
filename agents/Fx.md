# fx

- Built-in name: `fx`
- Default command: `fx acp`
- Upstream: https://fx.sh — https://github.com/vercel-labs/fx

`acpx fx` runs the installed fx CLI ACP server. fx is Vercel's native coding-agent harness; install it first (see the upstream docs) and authenticate a model provider before starting ACP sessions.

## Auth and setup

`fx acp` uses fx's existing authentication and configuration. Sign in with `fx login vercel`, `fx login codex`, or `fx login grok` (or `fx setup` for a Vercel AI Gateway key), and pick the active provider with `fx provider <gateway|codex|grok>`. ACP initialization fails when no usable provider credential is available.

## Model selection

`acpx --model <id>` forwards to the `fx acp` startup `--model` flag:

```bash
acpx --model grok-4.5 fx exec 'summarize this repo'
```

The flag is persisted in `session_options.model`, so persistent-session reuse and reconnects keep the selection. An explicit `--model` on a raw `--agent` command wins over the forwarded flag.

## ACP surface

fx supports `session/new`, `session/load`, `session/resume`, `session/list`, `session/close`, `session/prompt`, `session/cancel`, `session/set_mode`, and `session/set_config_option` for model and mode changes. The client process working directory becomes the fx primary workspace; launch a separate server process per workspace.
