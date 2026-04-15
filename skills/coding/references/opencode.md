# OpenCode

Two approaches: vanilla opencode via acpx, or oh-my-opencode with enhanced agents.

## Option A: Vanilla OpenCode (via acpx)

- **Built-in name:** `opencode`
- **Command:** `npx -y opencode-ai acp`
- **Upstream:** https://opencode.ai

```bash
# Basic usage
acpx opencode "review the codebase structure"

# One-shot
acpx opencode exec "summarize the architecture"

# Session management
acpx opencode sessions list
```

## Option B: oh-my-opencode (recommended for advanced workflows)

oh-my-opencode provides specialized agents and ultrawork capabilities. It uses its own session management via `oc-work` instead of acpx.

### Agents

| Agent | Purpose | Best for |
|-------|---------|----------|
| **Sisyphus** | Ultraworker | End-to-end tasks with `ulw` |
| **Hephaestus** | Deep worker | Single-file focused work |
| **Atlas** | Orchestrator | Todo-based task coordination |
| **Prometheus** | Planner | Planning without code execution |

### Quick start

```bash
# Install oh-my-opencode
git clone https://github.com/code-yeongyu/oh-my-opencode
cd oh-my-opencode
bun install
bun link

# Start a task
oc-work start \
  --topic my-task \
  --discord $CHANNEL \
  --dir ~/project \
  --message "implement feature X. ulw"

# Check status
oc-work status

# Send additional prompt
oc-work send --topic my-task --message "also add tests"

# Stop session
oc-work stop --topic my-task
```

### The `ulw` keyword

Adding `ulw` (ultrawork) to your prompt triggers Sisyphus's maximum effort mode:

```bash
oc-work start --topic fix \
  --message "fix the failing tests. ulw"
```

This runs the full workflow:
1. **Explore** - Understand the codebase
2. **Plan** - Create actionable plan
3. **Work** - Execute with persistence

### Agent selection guide

```bash
# Clear direction + single focus → Hephaestus
oc-work start --topic impl \
  --message "implement the auth middleware" \
  --agent hephaestus

# Needs exploration + coordination → Sisyphus (default)
oc-work start --topic feature \
  --message "implement OAuth integration. ulw"

# Todo-based orchestration → Atlas
oc-work start --topic orchestrate \
  --message "coordinate the refactoring tasks" \
  --agent atlas

# Planning only (no code) → Prometheus
oc-work start --topic plan \
  --message "create implementation plan for v2 API" \
  --agent prometheus
```

### Multiple parallel sessions

```bash
# Different topics = different sessions
oc-work start --topic backend --message "fix API bug"
oc-work start --topic frontend --message "update components"

# Check all
oc-work status

# Stop all
oc-work stop --all
```

### Session recovery

If a session gets stuck:

```bash
# Recover with new message
oc-work recover --topic my-task --message "continue from where you left off"

# Or clean restart
oc-work stop --topic my-task
oc-work start --topic my-task --message "restart: ..."
```

## When to use which

| Scenario | Approach |
|----------|----------|
| Quick one-off task | `acpx opencode exec "..."` |
| Simple session | `acpx opencode "..."` |
| Complex multi-step work | `oc-work` with Sisyphus |
| Need ultrawork (`ulw`) | `oc-work` (required) |
| Custom agents (Atlas, etc.) | `oc-work` (required) |
| Integration with Agentika | `oc-work` (built-in bridge) |

## Troubleshooting

**For vanilla opencode:**
```bash
npm i -g opencode-ai
acpx opencode status
```

**For oh-my-opencode:**
```bash
# Check status
oc-work status

# Orphan sessions
oc-work stop --all

# PATH issues
export PATH=/opt/homebrew/bin:$PATH
```

## Related resources

- oh-my-opencode: https://github.com/code-yeongyu/oh-my-opencode
- OpenCode: https://opencode.ai
- Agentika (for oc-work bridge): https://github.com/code-yeongyu/agentika
