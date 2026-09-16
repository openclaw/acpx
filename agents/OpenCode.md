# OpenCode

- Built-in name: `opencode`
- Default command: `npx -y opencode-ai acp`
- Upstream: https://opencode.ai

## Embedded inspection

Embedded inspection resolves the installed `opencode acp` entrypoint. An embedding host can pass the returned argv directly to its agent registry override. Install and configure OpenCode before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
