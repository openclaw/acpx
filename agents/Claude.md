# Claude

- Built-in name: `claude`
- Default command: `npx -y --package=@agentclientprotocol/claude-agent-acp -- claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- ACPX pins the built-in package range so fresh installs pick up Claude model and ACP adapter fixes without depending on a global adapter binary.
- Update ACPX to pick up changes to the supported adapter range in `src/agent-registry.ts`.
- An adapter installed alongside ACPX takes precedence over package fallback. Update that adapter and any explicitly selected native Claude executable separately; updating ACPX does not replace them.
- Sessions saved under an earlier ACPX-owned adapter range stay in the `claude` scope after an upgrade and resume on the current adapter. Records saved with a custom launcher keep it.
- Model switches can change the available effort controls. ACPX updates existing saved effort selections from the accepted response and removes selections whose controls disappear.
- Saved model and config selections are restored after reconnect, without replacing the conversation.

## Settings isolation

Built-in `acpx claude` sessions load Claude project and local settings, but not
user settings. The same isolation and saved session options apply on creation,
load, and resume. This prevents globally enabled channel and daemon plugins from
claiming singleton external resources in an ACP-spawned session.

Set `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` only when the spawned session needs
the user's global Claude settings and no such plugin conflict exists. Ambient
credentials and other environment variables are still inherited normally.

On Windows, native Claude executable discovery resolves relative `PATH` entries
from the selected session cwd. An explicit `CLAUDE_CODE_EXECUTABLE` still takes
precedence.

## Permission approval boundary

ACPX permission modes and per-tool policies govern the ACP permission requests
the adapter sends. `--deny-all` denies remaining requests after per-tool policy
evaluation; it does not intercept every native Claude tool call.

Claude evaluates native hooks, rules, modes, and automatic approvals before the
SDK's fallback `canUseTool` callback. Calls resolved earlier, including some
read-only operations, need no callback or ACP permission request. See the
[SDK permission evaluation order](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated).

Built-in Claude sessions retain project and local setting sources. The SDK
documents that project skills can pre-approve tools through
`allowed-tools`; such approvals can resolve a call before ACPX sees a request.
See [skill tool grants](https://code.claude.com/docs/en/agent-sdk/skills#pre-approve-tools-for-skills).

For built-in Claude sessions, `--allowed-tools` and embedded
`sessionOptions.allowedTools` are forwarded as native allow rules, not an
exclusive tool list. They can pre-approve calls before ACPX's policies or
permission mode are consulted.

For checks that must cover every native tool call, the SDK recommends a trusted
`PreToolUse` hook; a hook denial applies before automatic approvals. Configure
that in the native Claude environment. ACPX's typed session options do not
expose SDK hooks. Changing an ACPX permission mode alone does not establish that
boundary. See [SDK permission controls](https://code.claude.com/docs/en/agent-sdk/permissions#allow-and-deny-rules)
and [ACPX filesystem guardrails](../docs/permissions.md#working-directory-and-filesystem-guardrails).

## System prompt overrides

Choose the system prompt when creating a named session, then select that session for later prompts:

```bash
acpx --system-prompt "You are a code reviewer who challenges every implicit assumption." \
  claude sessions new --name review
acpx claude -s review 'review the current diff'
```

Use `--append-system-prompt` instead to append instructions to Claude's default system prompt. The override is saved with the session. `-s` selects an existing session; running `sessions new` again in the same scope closes the prior local record and creates a fresh session.

Both system-prompt flags also apply to `flow run`, including persistent and isolated ACP nodes using Claude.

Embedded callers can supply raw nonempty replacement or append text through `SessionAgentOptions.systemPrompt`. ACPX preserves that text exactly in saved options and `session/new`, `session/load`, and `session/resume` metadata, including whitespace-only text. CLI prompt flags trim surrounding whitespace and reject whitespace-only values.

## Embedded inspection

Embedded inspection resolves the installed `claude-agent-acp` adapter or its installed `@agentclientprotocol/claude-agent-acp` package. Configure the adapter’s authentication before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
