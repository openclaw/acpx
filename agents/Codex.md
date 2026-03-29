# Codex

- Built-in name: `codex`
- Default command: `npx @zed-industries/codex-acp`
- Upstream: https://github.com/zed-industries/codex-acp
- Runtime config options exposed by current codex-acp releases include `mode`, `model`, and `reasoning_effort`.
- `acpx --model <id> codex ...` applies the requested model after session creation via `session/set_config_option`.
- `acpx codex set thought_level <value>` is supported as a compatibility alias and is translated to codex-acp `reasoning_effort`.
