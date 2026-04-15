---
name: coding
description: "Run coding agents (codex, droid, opencode, etc.) via acpx. Unified interface for agent-to-agent communication, session management, and structured output. Triggers on coding task, implement, fix bug, refactor, code review."
---

# coding

## When to use this skill

Use this skill when you need to delegate coding tasks to specialized AI agents. Choose the right agent based on your needs:

| Scenario | Agent | Why |
|----------|-------|-----|
| General coding, refactoring | **codex** | Strong reasoning, broad knowledge |
| Fast iteration, Kimi model | **droid** | Quick execution, plan-oriented |
| oh-my-opencode setup | **opencode** | Custom agent system, ulw workflows |

## Quick start

```bash
# Install acpx globally (required)
npm i -g acpx

# One-shot execution (no session state)
acpx exec "fix the failing test in src/auth.ts"

# Persistent session (remembers context)
acpx codex "review the changed files and suggest improvements"
acpx codex "apply the suggested fixes"

# Different agents
acpx droid "implement pagination for the API endpoints"
acpx opencode "explore the codebase and create a plan"
```

## Core commands

```bash
# Start a coding session
acpx <agent> "your prompt"

# One-shot (no session persistence)
acpx <agent> exec "your prompt"

# Named parallel sessions
acpx codex -s backend "fix API bug"
acpx codex -s frontend "update UI components"

# Session management
acpx sessions list          # show active sessions
acpx sessions new           # create fresh session
acpx sessions close         # close current session
acpx status                 # check agent status
```

## Supported agents

### codex (default)

```bash
acpx codex "implement retry logic for API calls"
acpx "fix the failing tests"  # codex is default
```

**Details:** See [references/codex.md](references/codex.md)

### droid

```bash
acpx droid "add unit tests for the auth module"
```

**Details:** See [references/droid.md](references/droid.md)

### opencode (oh-my-opencode)

> **Note:** For opencode with oh-my-opencode agents (Sisyphus, Atlas, etc.), use the dedicated `oc-work` toolchain instead of acpx. See [references/opencode.md](references/opencode.md) for both approaches.

```bash
# Via acpx (vanilla opencode)
acpx opencode "review the codebase structure"

# Via oc-work (oh-my-opencode with Sisyphus/Atlas/etc.)
oc-work start --topic my-task --message "implement feature X. ulw"
```

**Details:** See [references/opencode.md](references/opencode.md)

## Output formats

```bash
# Human-readable (default)
acpx codex "explain the bug"

# JSON stream (for automation)
acpx --format json codex exec "list all API endpoints" > output.ndjson

# Final text only
acpx --format quiet exec "summarize the repo" > summary.txt
```

## Permission modes

```bash
# Auto-approve reads only (default)
acpx codex "review code"

# Auto-approve everything
acpx --approve-all codex "fix and commit"

# Deny all (dry run)
acpx --deny-all codex "what would you change?"
```

## Best practices

1. **English prompts**: All agents work best with English prompts
2. **Be specific**: Include file paths, function names, expected behavior
3. **Use sessions**: For multi-step tasks, use persistent sessions to maintain context
4. **Named sessions**: Use `-s <name>` for parallel work streams
5. **Check status**: Run `acpx status` before starting if unsure about current state

## Installation

See [references/installation.md](references/installation.md) for detailed setup instructions.

## Troubleshooting

**"command not found: acpx"**
```bash
npm i -g acpx
```

**Agent auth expired**
- codex: Run `codex auth login`
- droid: Run `droid auth login`

**Session stuck**
```bash
acpx sessions close
acpx sessions new
```

## Full reference

- [Installation](references/installation.md) - Setup acpx and agent dependencies
- [Codex](references/codex.md) - OpenAI Codex agent details
- [Droid](references/droid.md) - Factory Droid agent details
- [OpenCode](references/opencode.md) - OpenCode and oh-my-opencode details
