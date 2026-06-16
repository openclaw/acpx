# Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- ACPX pins the built-in package range so fresh installs pick up Claude model and ACP adapter fixes without depending on a global adapter binary.

## Settings isolation

Built-in `acpx claude` sessions load Claude project and local settings, but not
user settings. This prevents globally enabled channel and daemon plugins from
claiming singleton external resources in an ACP-spawned session.

Set `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` only when the spawned session needs
the user's global Claude settings and no such plugin conflict exists. Ambient
credentials and other environment variables are still inherited normally.
