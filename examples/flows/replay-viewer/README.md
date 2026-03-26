# Flow Replay Viewer

This example app visualizes one saved flow run bundle at a time.

It is separate from the `acpx` CLI surface on purpose:

- `acpx` writes replayable run bundles under `~/.acpx/flows/runs/`
- this viewer reads those bundles and renders them in the browser

The viewer uses:

- the run bundle manifest and projections
- the trace log
- bundled ACP session snapshots and raw session events
- React Flow for the graph

## Run it

From the repo root:

```bash
pnpm run viewer:dev
```

Then open:

```text
http://127.0.0.1:4173
```

The app ships with a bundled ACP-backed sample run so it is immediately usable.

To inspect a real previous run, click **Open local run bundle** and pick a run
directory from:

```text
~/.acpx/flows/runs/<run-id>/
```

## What it shows

- the flow graph, with replay progression over the saved step attempts
- selected step prompt, raw response, parsed output, and action receipts
- the ACP conversation slice for the selected ACP step
- the raw bundled ACP event slice for that step

## Included sample

The bundled sample under `public/sample-run/` comes from a real run of
`examples/flows/two-turn.flow.ts` against the repo's mock ACP agent, with the
machine-specific paths sanitized for readability.
