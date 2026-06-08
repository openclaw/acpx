# Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: https://github.com/agentclientprotocol/codex-acp
- Runtime controls exposed by current codex-acp releases include ACP modes and an advertised model session config option.
- Reasoning effort is encoded in advertised Codex model ids such as `gpt-5.2[high]` when the adapter reports those variants.
- `acpx --model <id> codex ...` and `acpx codex set model <id>` apply the requested model through the advertised config option; legacy adapters that advertise `models` use `session/set_model`.
