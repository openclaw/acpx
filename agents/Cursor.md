# Cursor

- Built-in name: `cursor`
- Default command: `cursor-agent acp`
- Upstream: https://cursor.com/docs/cli/acp

Cursor can advertise model IDs with bracketed settings (for example,
`composer-2.5[fast=false]`). `acpx --model composer-2.5 cursor ...` accepts a bare
model name when Cursor advertises exactly one matching bracketed variant. An exact
advertised ID always wins. This Cursor-specific matching also applies to
`acpx cursor set model`, embedded `setModel`, and `setConfigOption` targeting the
advertised model option.

Model changes use the connected session's current catalog, including after
reconnect. If a session previously advertised only `composer-2.5[fast=false]` but
now also advertises `composer-2.5[fast=true]`, a request for `composer-2.5` is
rejected before sending the model change. Choose the full advertised ID to resolve
the ambiguity. Unknown model names are also rejected. Treat advertised IDs as
opaque, including any slashes or bracketed settings.

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
