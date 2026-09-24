# Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- ACPX pins the built-in package range so fresh installs pick up Claude model and ACP adapter fixes without depending on a global adapter binary.
- Update ACPX to pick up changes to the supported adapter range in `src/agent-registry.ts`.
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

## System prompt overrides

Choose the system prompt when creating a named session, then select that session for later prompts:

```bash
acpx --system-prompt "You are a code reviewer who challenges every implicit assumption." \
  claude sessions new --name review
acpx claude -s review 'review the current diff'
```

Use `--append-system-prompt` instead to append instructions to Claude's default system prompt. The override is saved with the session. `-s` selects an existing session; running `sessions new` again in the same scope closes the prior local record and creates a fresh session.

## Embedded inspection

Embedded inspection resolves the installed `claude-agent-acp` adapter or its installed `@agentclientprotocol/claude-agent-acp` package. Configure the adapter’s authentication before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
