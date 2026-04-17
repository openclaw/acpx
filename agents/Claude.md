# Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- Runtime config options exposed by current claude-agent-acp releases include `mode` and `model`.
- `acpx --model <id> claude ...` requests the target Claude model during session startup, and `acpx claude set model <id>` uses the adapter's advertised model-switching support when available.
