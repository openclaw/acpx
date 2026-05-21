# Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: https://github.com/agentclientprotocol/codex-acp
- Runtime controls exposed by current codex-acp releases include ACP modes, advertised models, and `session/set_model`.
- Reasoning effort is encoded in advertised Codex model ids such as `gpt-5.2[high]` when the adapter reports those variants.
- `acpx --model <id> codex ...` and `acpx codex set model <id>` apply the requested model through ACP model selection.
