# MCode

- Built-in name: `mcode`
- Default command: `mcode acp`
- Upstream: [MiniMax Code](https://www.npmjs.com/package/@minimax-ai/code)

`acpx mcode` launches MiniMax Code's native ACP v1 stdio server. Install and
authenticate the CLI first:

```bash
npm install -g @minimax-ai/code
mcode login
```

Then run a one-shot prompt:

```bash
acpx mcode exec 'summarize this repository'
```

MCode emits normal ACP agent messages, tool-call updates, and permission requests.
Choose the acpx permission policy that matches the task, for example
`--approve-reads` (the default), `--approve-all`, or `--deny-all`.

## Session lifecycle

Use `acpx mcode exec …` for independent one-shot prompts. Resuming a provider
conversation across CLI invocations requires the installed MCode server to advertise
ACP session reload; a saved acpx record alone does not provide that capability.
Older MCode builds did not advertise reload, so do not infer ACP continuity from
MCode's interactive session-management commands. See [Sessions](../docs/sessions.md)
for acpx's persistence and queue-owner behavior.

If `mcode` is installed outside `PATH`, override the built-in argv in
`~/.acpx/config.json`:

```json
{
  "agents": {
    "mcode": {
      "argv": ["/absolute/path/to/mcode", "acp"]
    }
  }
}
```
