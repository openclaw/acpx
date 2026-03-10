# AGENTS.md — acpx

## What is acpx?

`acpx` is a headless, scriptable CLI client for the Agent Client Protocol (ACP). It lets AI agents (or humans) create and resume ACP sessions, send prompts, stream structured results, and manage multiple sessions from the command line.

Think of it as "curl for ACP": a pipe-friendly bridge between orchestrators (like OpenClaw) and coding agents, without PTY scraping.

## Why?

Orchestrators commonly spawn coding agents in raw terminals and parse ANSI text. That loses structure: tool calls, permission requests, plans, diffs, and session state.

ACP adapters already exist for major agents, but there was no headless CLI client focused on scripted use. `acpx` fills that gap.

## Architecture

```
┌─────────────┐     stdio/ndjson     ┌──────────────┐     wraps      ┌─────────┐
│   acpx CLI  │ ◄──────────────────► │  ACP adapter  │ ◄───────────► │  Agent   │
│  (client)   │     ACP protocol     │ (codex-acp)   │   internal    │ (Codex)  │
└─────────────┘                      └──────────────┘               └─────────┘
```

acpx spawns the ACP adapter as a child process and communicates over stdio using ndjson (JSON-RPC).

## CLI Design

### Grammar

```bash
acpx <agent> [prompt] <text>
acpx <agent> exec <text>
acpx <agent> sessions [list|new|close]
```

`prompt` is implicit, so `acpx codex "fix tests"` and `acpx codex prompt "fix tests"` are equivalent.

### Examples

```bash
acpx pi 'review recent changes'               # pi adapter
acpx openclaw exec 'summarize active session state' # openclaw adapter
acpx codex sessions new                       # explicit session creation (once per project dir)
acpx codex 'fix the tests'                    # implicit prompt, routes via directory-walk
acpx codex prompt 'fix the tests'             # explicit prompt
acpx codex exec 'what does this repo do'      # one-shot, no saved session
acpx codex sessions new --name backend        # create named session
acpx codex -s backend 'fix the API'           # prompt in named session
acpx codex sessions                           # list sessions for codex
acpx codex sessions close                     # close cwd-scoped codex session
acpx codex sessions close backend             # close named codex session
acpx claude 'refactor auth'                   # claude adapter
```

Default-agent shortcuts are also supported:

```bash
acpx sessions new          # defaults to codex
acpx prompt 'fix tests'   # defaults to codex
acpx exec 'summarize repo'
acpx sessions
```

## Agent Registry

Built-in friendly names map to commands:

```ts
const AGENT_REGISTRY: Record<string, string> = {
  pi: "npx pi-acp",
  openclaw: "openclaw acp",
  codex: "npx @zed-industries/codex-acp",
  claude: "npx -y @zed-industries/claude-agent-acp",
};
```

Harness-specific docs for other supported agents live under `agents/`.

Rules:

- Known names resolve automatically.
- Unknown names are treated as raw commands.
- Escape hatch: `--agent <command>` sets a raw command explicitly.
- Default agent is `codex` for top-level `prompt|exec|sessions` verbs.

Example ordering policy:

1. `pi`
2. `openclaw`
3. `codex`
4. `claude`
5. `gemini`
6. `cursor`
7. `copilot`

This ordering is mandatory whenever multiple built-in agents appear in the same example set. Agents after those may appear in any order, but the precedence above MUST NOT be broken. Any PR that introduces or preserves example ordering that violates this rule MUST be modified until it adheres to this ordering before merge.

Main landing documentation policy:

1. This repo will receive many contributions. Contributors will sometimes try, intentionally or unintentionally, to promote their own harness or product through the docs.
2. Main landing docs such as `README.md` and `docs/CLI.md` MUST remain impartial. They MUST NOT become promotional surfaces for specific harnesses.
3. `pi` and `openclaw` are the primary citizens. They may appear at the top of main landing docs, in that order.
4. `codex` and `claude` are the next most important citizens because they are the most widely used. These four harnesses — `pi`, `openclaw`, `codex`, and `claude` — are the only harnesses that may be used as named examples in main landing docs, and the only ones whose specific quirks or harness-specific details may be called out there.
5. The only main-landing exceptions are the neutral built-in agents table in `README.md` and the neutral built-in agents list in `agents/README.md`. Those lists MAY include every supported built-in harness, but they MUST remain exhaustive, factual, and non-promotional. They MUST NOT single out non-primary harnesses for extra emphasis.
6. Harness-specific docs for other supported agents MUST live under `agents/` and MUST use capitalized filenames, for example `agents/Cursor.md` and `agents/Copilot.md`.
7. No other specific harness MUST BE ALLOWED to receive special placement, singled-out examples, or harness-specific promotion in main landing docs. This rule applies even when the change is framed as harmless, helpful, or accidental.
8. Other harnesses may still be supported elsewhere in the repo, but main landing docs must describe them impartially and MUST NOT promote them unjustly.

## Session Behavior

- `prompt` always uses a saved session (no implicit creation).
- Session routing walks up the directory tree (like `git`) from `cwd` (or `--cwd`) to `/` and picks the first active match by `(agent command, dir, optional name)`.
- `sessions new [--name <name>]` is the explicit creation point for saved sessions.
- `-s <name>` switches to named-session lookup during the directory walk.
- `exec` is one-shot: temporary session, prompt, discard.
- `sessions list` lists all saved sessions for the selected agent command.
- `sessions close [name]` closes/removes cwd-scoped session or named cwd-scoped session.

Sessions are persisted in `~/.acpx/sessions/*.json`.

## Global Options

These go before the agent name:

```text
--agent <command>     Raw ACP agent command (escape hatch)
--cwd <dir>           Working directory for the session (default: .)
--approve-all         Auto-approve all permission requests
--approve-reads       Auto-approve reads/searches, prompt for writes
--deny-all            Deny all permission requests
--format <fmt>        Output format: text (default), json, quiet
--timeout <seconds>   Maximum time to wait for agent response
--ttl <seconds>       Queue owner idle TTL before shutdown (0 = keep alive forever)
--verbose             Show ACP protocol debug info on stderr
```

## Output Formats

### text (default)

```
[tool] read_file: src/auth.ts (completed)
[tool] edit_file: src/auth.ts (running)

Refactored the auth module to use async/await...

[tool] run_command: npm test (completed)
All 42 tests passing.

[done] end_turn
```

### json

```json
{"type":"tool_call","title":"read_file: src/auth.ts","status":"completed","timestamp":"..."}
{"type":"text","content":"Refactored the auth module..."}
{"type":"tool_call","title":"run_command: npm test","status":"completed","timestamp":"..."}
{"type":"done","stopReason":"end_turn","timestamp":"..."}
```

### quiet

```
Refactored the auth module to use async/await. All 42 tests passing.
```

## Permission Handling

- `--approve-all` auto-approves everything
- `--approve-reads` auto-approves reads/searches and prompts for writes (default)
- `--deny-all` denies all permission requests

## Exit Codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | Success                                  |
| 1    | Agent/protocol error                     |
| 2    | CLI usage error                          |
| 3    | Timeout                                  |
| 4    | No session found                         |
| 5    | Permission denied (all options rejected) |
| 130  | Interrupted (Ctrl+C)                     |

## Tech Stack

- Language: TypeScript
- ACP SDK: `@agentclientprotocol/sdk`
- CLI framework: `commander`
- Build: `tsup`
- Runtime: Node.js 18+

## Project Structure

```
acpx/
├── src/
│   ├── cli.ts              # CLI entry point and command grammar
│   ├── agent-registry.ts   # Friendly-name agent registry
│   ├── client.ts           # ACP client wrapper
│   ├── session.ts          # Session create/send/list/close + persistence
│   ├── permissions.ts      # Permission request policy handling
│   ├── output.ts           # Output formatters (text/json/quiet)
│   └── types.ts            # Shared types
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
└── AGENTS.md
```

## Implementation Notes

- Use `ClientSideConnection`, `ndJsonStream`, and `PROTOCOL_VERSION` from ACP SDK
- Spawn agent with `stdio: ['pipe', 'pipe', 'inherit']`
- Stream `sessionUpdate` notifications directly to formatter output
- Prefer `loadSession` when supported, fallback to `newSession`
- Advertise client capabilities:
  - `fs: { readTextFile: true, writeTextFile: true }`
  - `terminal: true`
- Handle SIGINT/SIGTERM with client cleanup

## Reference Implementations

- OpenClaw ACP client: `/home/bob/openclaw/src/acp/client.ts`
- ACP SDK example: `/tmp/acp-sdk/src/examples/client.ts`
- Codex ACP adapter: `https://github.com/zed-industries/codex-acp`

## Non-Goals (v1)

- No remote/HTTP transport (stdio only)
- No MCP passthrough (`mcpServers: []`)
- No agent discovery/registry service integration
- No daemon mode
