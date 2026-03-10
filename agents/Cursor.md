# Cursor

- Built-in name: `cursor`
- Default command: `cursor-agent acp`
- Upstream: https://cursor.com/docs/cli/acp

If your Cursor install exposes ACP as `agent acp` instead of `cursor-agent acp`, override the built-in command in config:

```json
{
  "agents": {
    "cursor": {
      "command": "agent acp"
    }
  }
}
```
