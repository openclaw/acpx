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

Then run a one-shot prompt or create an in-process session:

```bash
acpx mcode exec 'summarize this repository'
acpx mcode sessions new
acpx mcode 'review the current branch'
```

MCode emits normal ACP agent messages, tool-call updates, and permission requests.
Choose the acpx permission policy that matches the task, for example
`--approve-reads` (the default), `--approve-all`, or `--deny-all`.

## Session lifecycle

MCode currently implements `session/new` and `session/prompt`, but does not advertise
`session/load`. A live acpx process can keep using its in-process session; after the
MCode process exits, start a new session rather than expecting a saved provider session
to resume. `acpx mcode exec …` avoids persisted-session expectations and is the most
predictable choice for automation.

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
