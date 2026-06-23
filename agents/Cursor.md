# Cursor

- Built-in name: `cursor`
- Default command: `cursor-agent acp`
- Upstream: https://cursor.com/docs/cli/acp

Cursor can advertise model ids with bracketed settings (for example,
`composer-2.5[fast=false]`). `acpx --model composer-2.5 cursor ...` accepts a bare
model name only when Cursor advertises exactly one matching bracketed variant; use
the full advertised id when multiple variants are available.

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
