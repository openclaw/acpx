# Flow Examples

These are simple source-tree examples for `acpx flow run`.

- `echo.flow.ts`: one ACP step that returns a JSON reply
- `branch.flow.ts`: ACP classification followed by a deterministic branch into either `continue` or `checkpoint`
- `shell.flow.ts`: one native runtime-owned shell action that returns structured JSON
- `two-turn.flow.ts`: two ACP prompts in the same implicit main session

Run them from the repo root:

```bash
acpx flow run examples/flows/echo.flow.ts \
  --input-json '{"request":"Summarize this repository in one sentence."}'

acpx flow run examples/flows/branch.flow.ts \
  --input-json '{"task":"FIX: add a regression test for the reconnect bug"}'

acpx flow run examples/flows/shell.flow.ts \
  --input-json '{"text":"hello from shell"}'

acpx flow run examples/flows/two-turn.flow.ts \
  --input-json '{"topic":"How should we validate a new ACP adapter?"}'
```

These examples are generic. `acpx` does not ship workload-specific flows in core.
