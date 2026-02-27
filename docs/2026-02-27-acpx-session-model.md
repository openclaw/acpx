# ACPX Session Model

Date: 2026-02-27
Status: Implemented

## Goal

Keep acpx session persistence as close as practical to Zed thread persistence semantics, while keeping acpx runtime envelope fields separate from thread content.

Reference model used for alignment:

- `crates/agent/src/db.rs` (`DbThread`)
- `crates/agent/src/thread.rs` (`Message`, `UserMessage`, `AgentMessage`, content/tool types)

## Design Rules

1. Thread payload is the canonical conversation format.
2. acpx runtime/session bookkeeping stays outside `thread`.
3. Prefer thread field names/semantics like `updated_at`, `thinking_enabled`, `thinking_effort`.
4. Put acpx-only state under `acpx.*`.
5. Persist all relevant ACP update/operator events in `acpx.audit_events`.
6. No legacy schema read path.

## Canonical Top-Level Shape

Persist one JSON file per acpx record:

```text
~/.acpx/sessions/<acpxRecordId>.json
```

Top-level schema:

```json
{
  "schema": "acpx.session.v1",
  "acpxRecordId": "...",
  "acpSessionId": "...",
  "agentSessionId": "...",
  "agentCommand": "npx @zed-industries/codex-acp",
  "cwd": "/repo",
  "name": "backend",
  "createdAt": "...",
  "lastUsedAt": "...",
  "closed": false,
  "closedAt": null,
  "pid": 1234,
  "agentStartedAt": "...",
  "lastPromptAt": "...",
  "lastAgentExitCode": null,
  "lastAgentExitSignal": null,
  "lastAgentExitAt": null,
  "lastAgentDisconnectReason": null,
  "protocolVersion": 1,
  "agentCapabilities": {},
  "thread": {},
  "acpx": {}
}
```

## `thread` Payload

```json
{
  "version": "0.3.0",
  "title": "...",
  "messages": [],
  "updated_at": "2026-02-27T12:00:00Z",
  "detailed_summary": null,
  "initial_project_snapshot": null,
  "cumulative_token_usage": {},
  "request_token_usage": {},
  "model": null,
  "profile": null,
  "imported": false,
  "subagent_context": null,
  "speed": null,
  "thinking_enabled": false,
  "thinking_effort": null
}
```

### Message Variants

User:

```json
{
  "User": {
    "id": "2f8f2028-df7d-4479-a0a0-9f10238986cd",
    "content": [{ "Text": "..." }]
  }
}
```

Agent:

```json
{
  "Agent": {
    "content": [
      { "Text": "..." },
      { "Thinking": { "text": "...", "signature": null } },
      {
        "ToolUse": {
          "id": "call_123",
          "name": "run_command",
          "raw_input": "{\"command\":\"ls\"}",
          "input": { "command": "ls" },
          "is_input_complete": true,
          "thought_signature": null
        }
      }
    ],
    "tool_results": {
      "call_123": {
        "tool_use_id": "call_123",
        "tool_name": "run_command",
        "is_error": false,
        "content": { "Text": "..." },
        "output": null
      }
    },
    "reasoning_details": null
  }
}
```

Resume marker:

```json
"Resume"
```

## ACP Update Mapping

- prompt send: create `User` message
- `agent_message_chunk`: append `Text` in current `Agent` message
- `agent_thought_chunk`: append `Thinking` in current `Agent` message
- `tool_call` / `tool_call_update`: upsert `ToolUse` and `tool_results`
- `usage_update`: only applied to `request_token_usage` / `cumulative_token_usage` when token-shaped metadata is available
- `session_info_update`: update `thread.title` and `thread.updated_at`
- `available_commands_update`: update `acpx.available_commands`
- `current_mode_update`: update `acpx.current_mode_id`
- `config_option_update`: update `acpx.config_options`
- all session updates and client operations: append to `acpx.audit_events`

## `acpx` Namespace

```json
{
  "current_mode_id": "code",
  "available_commands": ["create_plan"],
  "config_options": [],
  "audit_events": []
}
```

Notes:

- `acpx` is optional.
- `thread` remains clean and conversation-focused.
- Parser is strict to this shape; legacy `kind/type` message records are ignored.
