---
title: Agents
description: Built-in agent registry — every friendly name acpx ships with, the ACP adapter it spawns, the upstream coding agent it wraps, and per-agent notes.
---

`acpx` ships with a registry of friendly agent names. Each one resolves to a specific ACP adapter command. Unknown names fall through as raw commands, and `--agent <command>` is the escape hatch for anything custom (see [Custom agents](custom-agents.md)).

The default agent for top-level commands like `acpx exec …` and `acpx prompt …` is `codex`.

## Built-in registry

| Agent      | Adapter command                                | Wraps                                                                                                           |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pi`       | `npx pi-acp`                                   | [Pi Coding Agent](https://github.com/mariozechner/pi)                                                           |
| `openclaw` | `openclaw acp`                                 | [OpenClaw ACP bridge](https://github.com/openclaw/openclaw)                                                     |
| `codex`    | `npx -y @agentclientprotocol/codex-acp`        | [Codex CLI](https://codex.openai.com)                                                                           |
| `claude`   | `npx -y @agentclientprotocol/claude-agent-acp` | [Claude Code](https://claude.ai/code)                                                                           |
| `gemini`   | `gemini --acp`                                 | [Gemini CLI](https://github.com/google/gemini-cli)                                                              |
| `cursor`   | `cursor-agent acp`                             | [Cursor CLI](https://cursor.com/docs/cli/acp)                                                                   |
| `copilot`  | `copilot --acp --stdio`                        | [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line) |
| `droid`    | `droid exec --output-format acp`               | [Factory Droid](https://www.factory.ai)                                                                         |
| `iflow`    | `iflow --experimental-acp`                     | [iFlow CLI](https://github.com/iflow-ai/iflow-cli)                                                              |
| `kilocode` | `npx -y @kilocode/cli acp`                     | [Kilocode](https://kilocode.ai)                                                                                 |
| `kimi`     | `kimi acp`                                     | [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)                                                              |
| `kiro`     | `kiro-cli-chat acp`                            | [Kiro CLI](https://kiro.dev)                                                                                    |
| `opencode` | `npx -y opencode-ai acp`                       | [OpenCode](https://opencode.ai)                                                                                 |
| `qoder`    | `qodercli --acp`                               | [Qoder CLI](https://docs.qoder.com/cli/acp)                                                                     |
| `qwen`     | `qwen --acp`                                   | [Qwen Code](https://github.com/QwenLM/qwen-code)                                                                |
| `trae`     | `traecli acp serve`                            | [Trae CLI](https://docs.trae.cn/cli)                                                                            |

`factory-droid` and `factorydroid` also resolve to the built-in `droid` adapter.

## Common shape

Every built-in agent supports the same command surface:

```bash
acpx <agent> [prompt_text...]                 # implicit prompt
acpx <agent> prompt [prompt_text...]          # explicit prompt
acpx <agent> exec [prompt_text...]            # one-shot, no saved session
acpx <agent> cancel [-s <name>]               # cooperative session/cancel
acpx <agent> set-mode <mode> [-s <name>]      # session/set_mode
acpx <agent> set <key> <value> [-s <name>]    # session/set_config_option
acpx <agent> status [-s <name>]
acpx <agent> sessions [list | new | ensure | close | show | history | prune]
```

See [Prompting](prompting.md), [Sessions](sessions.md), and [Session control](session-control.md) for the cross-agent semantics.

## Per-agent notes

Notes that override or extend the cross-agent behavior live below.

### Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)
- Runtime controls exposed by current `codex-acp` releases: ACP modes, advertised models, and `session/set_model`.
- `acpx --model <id> codex …` and `acpx codex set model <id>` apply the requested model through ACP model selection.

### Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
- The built-in package range is pinned by acpx so fresh installs pick up Claude model and ACP adapter fixes without depending on a globally installed adapter binary.
- On Windows, `acpx` resolves the `claude.exe` executable from `PATH` before spawning so launches do not depend on shell-specific command lookup.
- `--system-prompt` and `--append-system-prompt` forward through ACP `_meta.systemPrompt` on `session/new`, letting you replace or append to the Claude Code system prompt without leaving a persistent session. The value persists in `session_options.system_prompt` so ensure/reuse keeps the override. Other agents ignore the field.

### Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- Upstream: [mariozechner/pi](https://github.com/mariozechner/pi)

### OpenClaw

- Built-in name: `openclaw`
- Default command: `openclaw acp`
- Upstream: [openclaw/openclaw](https://github.com/openclaw/openclaw)

For repo-local OpenClaw checkouts, override the built-in command in `~/.acpx/config.json` so `acpx openclaw …` spawns the ACP bridge directly without the `pnpm` wrapper:

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node scripts/run-node.mjs acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```

### Cursor

- Built-in name: `cursor`
- Default command: `cursor-agent acp`
- Upstream: [Cursor CLI](https://cursor.com/docs/cli/acp)

If your Cursor install exposes ACP as `agent acp` instead of `cursor-agent acp`, override:

```json
{ "agents": { "cursor": { "command": "agent acp" } } }
```

### Gemini

- Built-in name: `gemini`
- Default command: `gemini --acp`
- Upstream: [google/gemini-cli](https://github.com/google/gemini-cli)

### Copilot

- Built-in name: `copilot`
- Default command: `copilot --acp --stdio`
- Upstream: [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line)
- Requires a Copilot CLI release that supports ACP stdio mode. Older `copilot` binaries fail before ACP startup.

### Droid (Factory)

- Built-in names: `droid`, `factory-droid`, `factorydroid`
- Default command: `droid exec --output-format acp`
- Upstream: [factory.ai](https://www.factory.ai)

### Qoder

- Built-in name: `qoder`
- Default command: `qodercli --acp`
- Upstream: [Qoder CLI](https://docs.qoder.com/cli/acp)
- Reuses the Qoder CLI login state. For non-interactive runs, set `QODER_PERSONAL_ACCESS_TOKEN`.
- `acpx qoder` forwards `--max-turns` and `--allowed-tools` into Qoder CLI startup flags when those session options are set, so you do not need a raw `--agent` override for them.

### iFlow

- Built-in name: `iflow`
- Default command: `iflow --experimental-acp`
- Upstream: [iflow-ai/iflow-cli](https://github.com/iflow-ai/iflow-cli)

### Kilocode

- Built-in name: `kilocode`
- Default command: `npx -y @kilocode/cli acp`
- Upstream: [kilocode.ai](https://kilocode.ai)

### Kimi

- Built-in name: `kimi`
- Default command: `kimi acp`
- Upstream: [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)

### Kiro

- Built-in name: `kiro`
- Default command: `kiro-cli-chat acp`
- Upstream: [kiro.dev](https://kiro.dev)

### OpenCode

- Built-in name: `opencode`
- Default command: `npx -y opencode-ai acp`
- Upstream: [opencode.ai](https://opencode.ai)

### Qwen

- Built-in name: `qwen`
- Default command: `qwen --acp`
- Upstream: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)

### Trae

- Built-in name: `trae`
- Default command: `traecli acp serve`
- Upstream: [docs.trae.cn](https://docs.trae.cn/cli)

## Overriding a built-in

Any built-in can be replaced wholesale through config, including `args` for adapter sub-commands:

```json
{
  "agents": {
    "codex": {
      "command": "/usr/local/bin/codex-acp",
      "args": ["--profile", "ci"]
    }
  }
}
```

CLI flags still win over config. See [Config](config.md) for precedence rules.

## See also

- [Custom agents](custom-agents.md) — `--agent <command>` and unknown positional names.
- [Sessions](sessions.md) — how the agent command becomes part of the session scope key.
- [Authentication](config.md#authentication) — `ACPX_AUTH_*` env vars and config `auth` entries for ACP `authenticate` handshakes.
