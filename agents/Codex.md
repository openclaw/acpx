# Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: https://github.com/agentclientprotocol/codex-acp
- ACPX owns the built-in package range so fresh launches use the repository-selected stable adapter line without requiring a global install.
- Runtime controls exposed by current codex-acp releases include ACP modes plus separate `model` and `reasoning_effort` session config options.
- Use the advertised base model id with `acpx --model <id> codex ...` or `acpx codex set model <id>`, then set reasoning effort separately with `acpx codex set reasoning_effort <value>`.
- Legacy `models` metadata may encode both values in a combined id such as `gpt-5.6-sol[max]`; ACPX uses that form only when the adapter does not advertise the newer model config option.
