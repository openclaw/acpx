# Flow Examples

These are source-tree examples for `acpx flow run`.

They range from small primitives to one larger end-to-end example.

They intentionally use the public authoring surface:

- import flow helpers from `acpx/flows`
- export a flow via `defineFlow(...)`

- `echo.flow.ts`: one ACP step that returns a JSON reply
- `branch.flow.ts`: constrained-choice classification using `decision()` and `decisionEdge()`, followed by a deterministic branch into either `continue` or `checkpoint`
- `pr-triage/pr-triage.flow.ts`: a larger single-PR workflow example with a colocated written spec in `pr-triage/README.md`
- `replay-viewer/`: a browser app that visualizes saved flow run bundles with React Flow, a recent-runs picker, ACP session inspection, and a dedicated viewer spec in `docs/2026-03-27-flow-replay-viewer.md`
- `shell.flow.ts`: one native runtime-owned shell action that returns structured JSON
- `workdir.flow.ts`: native workspace prep followed by an ACP step that runs inside that isolated cwd
- `two-turn.flow.ts`: a longer same-session ACP example that inspects the workspace, uses tools, and refines a final answer across multiple steps

Run them from the repo root:

```bash
acpx flow run examples/flows/echo.flow.ts \
  --input-json '{"request":"Summarize this repository in one sentence."}'

acpx flow run examples/flows/branch.flow.ts \
  --input-json '{"task":"FIX: add a regression test for the reconnect bug"}'

acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'

acpx flow run examples/flows/shell.flow.ts \
  --input-json '{"text":"hello from shell"}'

acpx flow run examples/flows/workdir.flow.ts

acpx flow run examples/flows/two-turn.flow.ts \
  --input-json '{"topic":"How should we validate a new ACP adapter?"}'
```

Run the replay viewer from the repo root:

```bash
pnpm viewer
```

These examples are examples only. They do not define `acpx` core product
behavior.

The PR-triage example can comment on or close real GitHub PRs if you run it
against a live repository.

The PR-triage example declares an explicit `approve-all` requirement, so it
must be run with `--approve-all`.
