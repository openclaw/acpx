# Droid

Factory AI's Droid agent for fast, plan-oriented coding.

## Quick reference

- **Built-in name:** `droid`
- **Aliases:** `factory-droid`, `factorydroid`
- **Command:** `droid exec --output-format acp`
- **Default model:** Kimi-K2.5-Turbo
- **Auth:** `~/.factory/auth.v2.file` + `~/.factory/auth.v2.key`
- **Upstream:** https://www.factory.ai

## Usage

```bash
# Basic prompt
acpx droid "implement pagination for the API"

# One-shot execution
acpx droid exec "add unit tests for auth module"

# Named session
acpx droid -s api "work on API improvements"

# Using aliases
acpx factory-droid "your prompt"
acpx factorydroid "your prompt"
```

## Droid-specific features

### Plan events

Droid uniquely emits `plan.updated` events during execution, providing visibility into its task planning:

```bash
# Watch plan updates in JSON format
acpx --format json droid "implement feature X" | grep plan
```

Plan events include:
- Task entries with priority and status
- Estimated effort
- Dependencies between tasks

### Fast iteration

Droid is optimized for quick iterations:
- Faster response times than Codex
- Good for straightforward implementation tasks
- Plan-oriented approach shows work breakdown

## Authentication

```bash
# Initial auth
droid auth login

# Check status
acpx droid status
```

**Auth files:**
- `~/.factory/auth.v2.file`
- `~/.factory/auth.v2.key`

When auth expires:
```bash
droid auth login
```

## Best practices

1. **Use for implementation** - Droid excels at clear implementation tasks
2. **English prompts** - Required for best results
3. **Watch the plan** - Use JSON format to see task breakdown
4. **Quick iterations** - Good for "try this, then this" workflows

## Comparison with Codex

| Aspect | Droid | Codex |
|--------|-------|-------|
| Speed | Faster | More thorough |
| Planning | Visible plan events | Internal reasoning |
| Model | Kimi-K2.5-Turbo | GPT-5.4 |
| Best for | Quick implementations | Complex reasoning |

## Troubleshooting

**"Auth expired"**
```bash
droid auth login
```

**"Command not found: droid"**
```bash
npm i -g factory-ai
```

**Session issues**
```bash
acpx droid cancel
acpx sessions close
```
