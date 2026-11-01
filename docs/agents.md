---
title: Agents
description: Built-in agent registry — every friendly name acpx ships with, the ACP adapter it spawns, the upstream coding agent it wraps, and per-agent notes.
---

`acpx` ships with a registry of friendly agent names. Each one resolves to a specific ACP adapter command. On Unix, unknown names fall through as raw commands, and `--agent <command>` supports custom launchers. On Windows, configure a named agent with structured `argv` instead (see [Custom agents](custom-agents.md)).

The default agent for top-level commands like `acpx exec …` and `acpx prompt …` is `codex`.

## Built-in registry

These 30 launch profiles identify supported ACP entry points. Follow each agent guide for installation, authentication, and capability limits. Ante is experimental and cannot reopen sessions after disconnect.

|                                                         | Agent                                                                                    | Profile            | Adapter command                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| ![Pi](assets/agents/pi.png)                             | [Pi](https://github.com/openclaw/acpx/blob/main/agents/Pi.md)                            | `pi`               | `npx --package=pi-acp -- pi-acp`                                             |
| ![OpenClaw](assets/agents/openclaw.png)                 | [OpenClaw](https://github.com/openclaw/acpx/blob/main/agents/OpenClaw.md)                | `openclaw`         | `openclaw acp`                                                               |
| ![Codex](assets/agents/codex.png)                       | [Codex](https://github.com/openclaw/acpx/blob/main/agents/Codex.md)                      | `codex`            | `npx -y --package=@agentclientprotocol/codex-acp -- codex-acp`               |
| ![Claude Code](assets/agents/claude.png)                | [Claude Code](https://github.com/openclaw/acpx/blob/main/agents/Claude.md)               | `claude`           | `npx -y --package=@agentclientprotocol/claude-agent-acp -- claude-agent-acp` |
| ![Gemini CLI](assets/agents/gemini.png)                 | [Gemini CLI](https://github.com/openclaw/acpx/blob/main/agents/Gemini.md)                | `gemini`           | `gemini --acp`                                                               |
| ![Cursor](assets/agents/cursor.png)                     | [Cursor](https://github.com/openclaw/acpx/blob/main/agents/Cursor.md)                    | `cursor`           | `cursor-agent acp`                                                           |
| ![GitHub Copilot](assets/agents/copilot.png)            | [GitHub Copilot](https://github.com/openclaw/acpx/blob/main/agents/Copilot.md)           | `copilot`          | `copilot --acp --stdio`                                                      |
| ![Ante](assets/agents/ante.png)                         | [Ante](https://github.com/openclaw/acpx/blob/main/agents/Ante.md)                        | `ante`             | `ante acp` (experimental)                                                    |
| ![Antigravity](assets/agents/antigravity.png)           | [Antigravity](https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md)          | `antigravity`      | `agy_acp_server.par` (platform arguments)                                    |
| ![DeepSeek Harness](assets/agents/deepseek-harness.png) | [DeepSeek Harness](https://github.com/openclaw/acpx/blob/main/agents/DeepSeekHarness.md) | `deepseek-harness` | `dsh --profile acp`                                                          |
| ![Devin](assets/agents/devin.png)                       | [Devin](https://github.com/openclaw/acpx/blob/main/agents/Devin.md)                      | `devin`            | `devin acp`                                                                  |
| ![Factory Droid](assets/agents/droid.png)               | [Factory Droid](https://github.com/openclaw/acpx/blob/main/agents/Droid.md)              | `droid`            | `droid exec --output-format acp`                                             |
| ![fast-agent](assets/agents/fast-agent.png)             | [fast-agent](https://github.com/openclaw/acpx/blob/main/agents/FastAgent.md)             | `fast-agent`       | `uvx fast-agent-mcp acp`                                                     |
| ![fx](assets/agents/fx.png)                             | [fx](https://github.com/openclaw/acpx/blob/main/agents/Fx.md)                            | `fx`               | `fx acp`                                                                     |
| ![Grok Build](assets/agents/grok-build.png)             | [Grok Build](https://github.com/openclaw/acpx/blob/main/agents/GrokBuild.md)             | `grok-build`       | `grok agent stdio`                                                           |
| ![Goose](assets/agents/goose.png)                       | [Goose](https://github.com/openclaw/acpx/blob/main/agents/Goose.md)                      | `goose`            | `goose acp`                                                                  |
| ![iFlow](assets/agents/iflow.png)                       | [iFlow](https://github.com/openclaw/acpx/blob/main/agents/Iflow.md)                      | `iflow`            | `iflow --experimental-acp`                                                   |
| ![Junie](assets/agents/junie.png)                       | [Junie](https://github.com/openclaw/acpx/blob/main/agents/Junie.md)                      | `junie`            | `junie --acp=true`                                                           |
| ![Kilocode](assets/agents/kilocode.png)                 | [Kilocode](https://github.com/openclaw/acpx/blob/main/agents/Kilocode.md)                | `kilocode`         | `npx -y --package=@kilocode/cli -- kilo acp`                                 |
| ![Kimi](assets/agents/kimi.png)                         | [Kimi](https://github.com/openclaw/acpx/blob/main/agents/Kimi.md)                        | `kimi`             | `kimi acp`                                                                   |
| ![Kiro](assets/agents/kiro.png)                         | [Kiro](https://github.com/openclaw/acpx/blob/main/agents/Kiro.md)                        | `kiro`             | `kiro-cli-chat acp`                                                          |
| ![MCode](assets/agents/mcode.png)                       | [MCode](https://github.com/openclaw/acpx/blob/main/agents/MCode.md)                      | `mcode`            | `mcode acp`                                                                  |
| ![Mux](assets/agents/mux.png)                           | [Mux](https://github.com/openclaw/acpx/blob/main/agents/Mux.md)                          | `mux`              | `npx -y --package=mux -- mux acp` via an ACPX-owned npm range                |
| ![Octomind](assets/agents/octomind.png)                 | [Octomind](https://github.com/openclaw/acpx/blob/main/agents/Octomind.md)                | `octomind`         | `octomind acp developer:general`                                             |
| ![OpenCode](assets/agents/opencode.png)                 | [OpenCode](https://github.com/openclaw/acpx/blob/main/agents/OpenCode.md)                | `opencode`         | `npx -y --package=opencode-ai -- opencode acp`                               |
| ![Poolside](assets/agents/pool.png)                     | [Poolside](https://github.com/openclaw/acpx/blob/main/agents/Pool.md)                    | `pool`             | `pool acp`                                                                   |
| ![Qoder](assets/agents/qoder.png)                       | [Qoder](https://github.com/openclaw/acpx/blob/main/agents/Qoder.md)                      | `qoder`            | `qodercli --acp`                                                             |
| ![Qwen Code](assets/agents/qwen.png)                    | [Qwen Code](https://github.com/openclaw/acpx/blob/main/agents/Qwen.md)                   | `qwen`             | `qwen --acp`                                                                 |
| ![Trae](assets/agents/trae.png)                         | [Trae](https://github.com/openclaw/acpx/blob/main/agents/Trae.md)                        | `trae`             | `traecli acp serve`                                                          |
| ![ZeroClaw](assets/agents/zeroclaw.png)                 | [ZeroClaw](https://github.com/openclaw/acpx/blob/main/agents/ZeroClaw.md)                | `zeroclaw`         | `zeroclaw acp`                                                               |

`factory-droid` and `factorydroid` also resolve to the built-in `droid` adapter.

## Common shape

Built-in profiles share this command surface. Available operations depend on the capabilities advertised by the adapter:

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
- Default command: `npx --package=pi-acp -- pi-acp`
- Upstream: [mariozechner/pi](https://github.com/mariozechner/pi)

### OpenClaw

- Built-in name: `openclaw`
- Default command: `openclaw acp`
- Upstream: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- Guide: [OpenClaw](https://github.com/openclaw/acpx/blob/main/agents/OpenClaw.md)

For source builds, see the [OpenClaw checkout override](custom-agents.md#openclaw-checkout).

### Codex

- Built-in name: `codex`
- Default command: `npx -y --package=@agentclientprotocol/codex-acp -- codex-acp`
- Upstream: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)
- Runtime controls exposed by current `codex-acp` releases: ACP modes and session config options, including the advertised model selector.
- `acpx --model <id> codex …` and `acpx codex set model <id>` apply the requested model through the advertised ACP config option. Legacy adapters that advertise `models` use `session/set_model`.

### Claude

- Built-in name: `claude`
- Default command: `npx -y --package=@agentclientprotocol/claude-agent-acp -- claude-agent-acp`
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
