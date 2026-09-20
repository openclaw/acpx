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
- When the adapter returns `_meta.codex.turnConfiguration`, ACPX preserves the opaque metadata in direct, queued, compare, and embedded-runtime results. Structured CLI output also retains the raw ACP prompt response.

## Skills and extra directories

`acpx --skills-dir <dir>` exposes a directory of skill folders (`<dir>/<name>/SKILL.md`) to the agent as `.claude/skills/` and `.agents/skills/` via ACP `additionalDirectories`; `--additional-dir <dir>` grants an extra workspace root without the synthetic wrapping. Both are repeatable, resolve from `--cwd`, persist on the session record for reconnects, and require the adapter to advertise `sessionCapabilities.additionalDirectories` at session creation — codex-acp does.

## Permission refusals

For the identified Codex ACP adapter, acpx prefers an offered `decline` or `reject_permissions` one-time refusal over cancellation. Permission kinds still determine approval and persistence behavior, and host callbacks receive the original request. If the selected refusal uses Codex cancellation, or no matching option exists, acpx keeps the safe cancellation and explains that it can end the turn. Text output shows a permission notice, quiet mode writes it to stderr, JSON retains it in the permission response's `_meta.acpx.permissionNotice`, and embedded runtimes emit a client-operation status. Explicit caller cancellation remains cancellation.

## Embedded inspection

Embedded inspection resolves the installed `codex-acp` adapter or its installed `@agentclientprotocol/codex-acp` package. The ACP adapter supplies the launch entrypoint. Configure the adapter’s authentication before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
