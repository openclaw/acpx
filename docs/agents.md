---
title: Agents
description: Built-in agent registry — every friendly name acpx ships with, the ACP adapter it spawns, the upstream coding agent it wraps, and per-agent notes.
---

`acpx` ships with a registry of friendly agent names. Each one resolves to a specific ACP adapter command. On Unix, unknown names fall through as raw commands, and `--agent <command>` supports custom launchers. On Windows, configure a named agent with structured `argv` instead (see [Custom agents](custom-agents.md)).

The default agent for top-level commands like `acpx exec …` and `acpx prompt …` is `codex`.

## Built-in registry

| Agent         | Adapter command                                | Wraps                                                                                                           |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pi`          | `npx pi-acp`                                   | [Pi Coding Agent](https://github.com/mariozechner/pi)                                                           |
| `openclaw`    | `openclaw acp`                                 | [OpenClaw ACP bridge](https://github.com/openclaw/openclaw)                                                     |
| `codex`       | `npx -y @agentclientprotocol/codex-acp`        | [Codex CLI](https://codex.openai.com)                                                                           |
| `claude`      | `npx -y @agentclientprotocol/claude-agent-acp` | [Claude Code](https://claude.ai/code)                                                                           |
| `gemini`      | `gemini --acp`                                 | [Gemini CLI](https://github.com/google/gemini-cli)                                                              |
| `cursor`      | `cursor-agent acp`                             | [Cursor CLI](https://cursor.com/docs/cli/acp)                                                                   |
| `copilot`     | `copilot --acp --stdio`                        | [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line) |
| `antigravity` | `agy_acp_server.par` (platform arguments)      | [Google Antigravity ACP](https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md)                      |
| `devin`       | `devin acp`                                    | [Devin CLI](https://docs.devin.ai/cli/index)                                                                    |
| `droid`       | `droid exec --output-format acp`               | [Factory Droid](https://www.factory.ai)                                                                         |
| `fast-agent`  | `uvx fast-agent-mcp acp`                       | [fast-agent](https://fast-agent.ai/)                                                                            |
| `fx`          | `fx acp`                                       | [fx](https://fx.sh)                                                                                             |
| `grok-build`  | `grok agent stdio`                             | [Grok Build](https://docs.x.ai/build/overview)                                                                  |
| `iflow`       | `iflow --experimental-acp`                     | [iFlow CLI](https://github.com/iflow-ai/iflow-cli)                                                              |
| `junie`       | `junie --acp=true`                             | [JetBrains Junie](https://junie.jetbrains.com)                                                                  |
| `kilocode`    | `npx -y @kilocode/cli acp`                     | [Kilocode](https://kilocode.ai)                                                                                 |
| `kimi`        | `kimi acp`                                     | [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)                                                              |
| `kiro`        | `kiro-cli-chat acp`                            | [Kiro CLI](https://kiro.dev)                                                                                    |
| `mcode`       | `mcode acp`                                    | [MiniMax Code](https://www.npmjs.com/package/@minimax-ai/code)                                                  |
| `mux`         | `mux acp` via an ACPX-owned npm range          | [Mux](https://mux.coder.com)                                                                                    |
| `opencode`    | `npx -y opencode-ai acp`                       | [OpenCode](https://opencode.ai)                                                                                 |
| `pool`        | `pool acp`                                     | [Poolside](https://poolside.ai)                                                                                 |
| `qoder`       | `qodercli --acp`                               | [Qoder CLI](https://docs.qoder.com/cli/acp)                                                                     |
| `qwen`        | `qwen --acp`                                   | [Qwen Code](https://github.com/QwenLM/qwen-code)                                                                |
| `trae`        | `traecli acp serve`                            | [Trae CLI](https://docs.trae.cn/cli)                                                                            |
| `zeroclaw`    | `zeroclaw acp`                                 | [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)                                                           |

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

### Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- Upstream: [mariozechner/pi](https://github.com/mariozechner/pi)

### OpenClaw

- Built-in name: `openclaw`
- Default command: `openclaw acp`
- Upstream: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- Guide: [OpenClaw](https://github.com/openclaw/acpx/blob/main/agents/OpenClaw.md)

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

### Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)
- Runtime controls exposed by current `codex-acp` releases: ACP modes and session config options, including the advertised model selector.
- `acpx --model <id> codex …` and `acpx codex set model <id>` apply the requested model through the advertised ACP config option. Legacy adapters that advertise `models` use `session/set_model`.

### Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
- The built-in package range is pinned by acpx so fresh installs pick up Claude model and ACP adapter fixes without depending on a globally installed adapter binary.
- On Windows, `acpx` resolves the `claude.exe` executable from `PATH` before spawning so launches do not depend on shell-specific command lookup.
- `--system-prompt` and `--append-system-prompt` forward through ACP `_meta.systemPrompt` on `session/new`, letting you replace or append to the Claude Code system prompt without leaving a persistent session. The value persists in `session_options.system_prompt` so ensure/reuse keeps the override. Other agents ignore the field.

### Other built-in agents

Setup, authentication, launch overrides, and capability notes live in the [agent guides](https://github.com/openclaw/acpx/blob/main/agents/README.md).

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
