# Codex

OpenAI's Codex agent via the ACP adapter.

## Quick reference

- **Built-in name:** `codex`
- **Command:** `npx @zed-industries/codex-acp`
- **Default model:** gpt-5.4/high
- **Auth:** `~/.codex/auth.json` (ChatGPT Pro subscription required)
- **Upstream:** https://github.com/zed-industries/codex-acp

## Usage

```bash
# Basic prompt
acpx codex "fix the failing tests"

# codex is the default agent, so this also works
acpx "fix the failing tests"

# One-shot execution
acpx codex exec "summarize this repo in 3 lines"

# Named session
acpx codex -s refactor "start refactoring the auth module"
```

## Models

Available models (specify with `--model`):

| Model | Description |
|-------|-------------|
| `gpt-5.4/high` | Default, best reasoning |
| `gpt-5.4/xhigh` | Extended reasoning |
| `gpt-5.3-codex` | Legacy codex model |

```bash
acpx --model gpt-5.4/xhigh codex "complex refactoring task"
```

## Configuration options

Set via `acpx codex set`:

```bash
# Set reasoning effort (thought_level is an alias)
acpx codex set reasoning_effort high
acpx codex set thought_level high  # alias

# Set model mid-session
acpx codex set model gpt-5.4/xhigh

# Set mode
acpx codex set-mode auto
```

## Authentication

Codex requires a ChatGPT Pro subscription:

```bash
# Initial auth (opens browser)
codex auth login

# Check auth status
acpx codex status
```

**Auth file:** `~/.codex/auth.json`

When auth expires:
1. Run `codex auth login`
2. Complete browser authentication
3. Resume work with `acpx codex`

## Slash commands

Codex supports these in-session commands:

| Command | Description |
|---------|-------------|
| `/review` | Review current changes |
| `/compact` | Compact session history |
| `/planner` | Switch to planning mode |
| `/executor` | Switch to execution mode |
| `/verifier` | Switch to verification mode |

## Best practices

1. **Use English prompts** - Codex performs best with English
2. **Be specific** - Include file paths and expected behavior
3. **Use sessions** - Maintain context across related tasks
4. **Set reasoning level** - Use `xhigh` for complex tasks

## Environment notes

If `OPENAI_API_KEY` or `OPENAI_BASE_URL` are set in your environment, acpx automatically strips them to avoid conflicts with Codex's native auth.

## Troubleshooting

**"Auth expired" or "Unauthorized"**
```bash
codex auth login
```

**Session stuck**
```bash
acpx codex cancel
# or
acpx sessions close && acpx sessions new
```

**Wrong model being used**
```bash
acpx codex set model gpt-5.4/high
```
