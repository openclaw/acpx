# Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: https://github.com/agentclientprotocol/codex-acp
- ACPX owns the built-in package range so fresh launches use the repository-selected stable adapter line without requiring a global install.
- Runtime controls exposed by current codex-acp releases include ACP modes plus separate `model` and `reasoning_effort` session config options.
- Use the advertised base model id with `acpx --model <id> codex ...` or `acpx codex set model <id>`, then set reasoning effort separately with `acpx codex set reasoning_effort <value>`.
- For a one-shot run, use `acpx --model <id> codex exec --config-option reasoning_effort=<value> 'prompt'`; the effort is applied after the model and before the prompt.
- Switching models can adjust reasoning effort. ACPX saves the accepted effort for an existing selection, or removes that selection if the new model has no effort control.
- Reconnecting restores the saved model and effort before prompting, even when the adapter resumes the conversation with different defaults.
- Legacy `models` metadata may encode both values in a combined id such as `gpt-5.6-sol[max]`; ACPX uses that form only when the adapter does not advertise the newer model config option.
- When the adapter returns `_meta.codex.turnConfiguration`, ACPX preserves the receipt in direct, queued, compare, and embedded-runtime results. Structured CLI output also retains the raw ACP prompt response.
