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
pnpm run viewer:preview
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The local viewer server always uses that fixed port. If another replay viewer is
already running there, the command reuses it instead of bouncing to a random
new port.

The app ships with a bundled ACP-backed sample run so it is immediately usable,
but the main path is the built-in **Recent runs** list sourced from:

```text
~/.acpx/flows/runs/<run-id>/
```

You can still use **Open local run bundle** as a fallback to inspect an arbitrary
bundle outside that default directory.

## What it shows

- the flow graph, with replay progression over the saved step attempts
- selected step prompt, raw response, parsed output, and action receipts
- the ACP conversation slice for the selected ACP step
- the raw bundled ACP event slice for that step

## Included sample

The bundled sample under `public/sample-run/` comes from a real run of
`examples/flows/two-turn.flow.ts` against the repo's mock ACP agent, with the
machine-specific paths sanitized for readability.
