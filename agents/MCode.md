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

MCode currently implements `session/new` and `session/prompt`, but does not advertise
provider-session reload. `acpx mcode sessions new` closes the ACP client after saving
the local record, so a later CLI prompt starts with fresh MCode context instead of
continuing that provider conversation. Do not treat sequential CLI invocations as a
multi-turn session. Use `acpx mcode exec …` for predictable automation.

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
