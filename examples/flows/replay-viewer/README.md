# Flow Replay Viewer

This example app visualizes one saved flow run bundle at a time.

For the viewer semantics and UX/layout rules, see
[docs/2026-03-27-flow-replay-viewer.md](../../../docs/2026-03-27-flow-replay-viewer.md).
For the live viewer transport and state-sync model, see
[docs/2026-03-31-flow-replay-live-transport.md](../../../docs/2026-03-31-flow-replay-live-transport.md).

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
pnpm viewer
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The local viewer server always uses that fixed port. If another replay viewer is
already running there, the command reuses it instead of bouncing to a random
new port.

Useful helper commands:

```bash
pnpm viewer:open
pnpm viewer:status
pnpm viewer:stop
```

The main path is the built-in **Recent runs** list sourced from:

```text
~/.acpx/flows/runs/<run-id>/
```

If the viewer starts before any runs exist, it stays empty and waits for the
first real run instead of falling back to a demo bundle. New runs appear in the
left sidebar automatically, and the first recent run opens on its own.

When a recent run is still active, the sidebar and the selected run view update
live over the viewer WebSocket transport. The viewer keeps the accumulated
history locally, so you can still rewind while new steps continue to arrive.

## What it shows

- the flow graph, with replay progression over the saved step attempts
- selected step prompt, raw response, parsed output, and action receipts
- the ACP conversation slice for the selected ACP step
- the raw bundled ACP event slice for that step

The full flow definition remains the main graph. The run is shown as an overlay
on that graph rather than replacing it with an execution-only path.

## Included sample

The bundled sample under `public/sample-run/` still exists for development and
test fixtures. It comes from a real run of `examples/flows/two-turn.flow.ts`
against the repo's mock ACP agent, with the machine-specific paths sanitized
for readability.
