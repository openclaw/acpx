# Installation

## Prerequisites

- Node.js 20+ (for acpx and npm-based agents)
- npm or pnpm

## Install acpx

```bash
# Global install (recommended for session reuse)
npm i -g acpx

# Verify installation
acpx --version
```

> **Note:** Prefer global install over `npx acpx` for persistent session support.

## Agent-specific setup

### Codex (default agent)

Codex requires authentication with ChatGPT Pro subscription:

```bash
# Install codex-acp adapter
npm i -g @zed-industries/codex-acp

# Authenticate (opens browser)
codex auth login

# Verify
acpx codex status
```

**Auth location:** `~/.codex/auth.json`

**If auth expires:**
```bash
codex auth login
```

### Droid (Factory AI)

```bash
# Install droid CLI
npm i -g factory-ai

# Authenticate
droid auth login

# Verify
acpx droid status
```

**Auth location:** `~/.factory/auth.v2.file` + `~/.factory/auth.v2.key`

### OpenCode

Two options:

**Option A: Vanilla opencode (via acpx)**
```bash
npm i -g opencode-ai
acpx opencode "your prompt"
```

**Option B: oh-my-opencode (via oc-work)**

oh-my-opencode provides enhanced agents (Sisyphus, Atlas, Hephaestus, Prometheus) with ultrawork workflows. It uses its own session management instead of acpx.

```bash
# Install oh-my-opencode
git clone https://github.com/code-yeongyu/oh-my-opencode
cd oh-my-opencode
bun install
bun link

# Use via oc-work (not acpx)
oc-work start --topic my-task --message "implement X. ulw"
oc-work status
oc-work stop --topic my-task
```

See [opencode.md](opencode.md) for detailed oh-my-opencode usage.

### Other agents

```bash
# Claude
npm i -g @agentclientprotocol/claude-agent-acp
acpx claude "your prompt"

# Gemini
npm i -g gemini-cli
acpx gemini "your prompt"

# Cursor
npm i -g cursor-agent
acpx cursor "your prompt"
```

## Configuration

Create global config at `~/.acpx/config.json`:

```json
{
  "defaultAgent": "codex",
  "defaultPermissions": "approve-reads",
  "ttl": 300,
  "format": "text"
}
```

Create project config at `.acpxrc.json` in your repo:

```json
{
  "defaultAgent": "droid",
  "defaultPermissions": "approve-all"
}
```

Project config merges with and overrides global config.

## Verify setup

```bash
# Check acpx
acpx --version

# Check default agent (codex)
acpx status

# Test one-shot execution
acpx exec "echo hello world"
```

## Environment variables

Avoid setting these when using acpx (they may conflict with agent auth):

- `OPENAI_API_KEY` - acpx strips this automatically for codex
- `OPENAI_BASE_URL` - acpx strips this automatically for codex

If you need API proxies, configure them in agent-specific config files.
