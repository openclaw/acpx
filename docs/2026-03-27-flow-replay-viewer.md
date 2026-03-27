# Flow Replay Viewer

This document specifies how the external flow replay viewer should present saved
run bundles from `acpx`.

It covers:

- graph semantics
- layout rules
- replay controls
- panel structure
- ACP conversation rendering

It does not change the run-bundle storage model. The viewer derives its display
semantics from the stored flow definition, trace, projections, and bundled
session data.

## Information density

The viewer exists to inspect dense technical state.

That means the default visual style should prefer:

- small typography
- tight spacing
- strong grouping
- less duplicated metadata

The viewer should not feel like a marketing dashboard or a spacious card UI.

### Typography

The default font size should be small enough to keep substantial technical
context visible at once.

Requirements:

- compact base text
- compact labels
- compact metadata chips
- no oversized headers inside the main viewing surface

The viewer should optimize for scanability over visual decoration.

### Metadata budget

There is too much state available to show all at once.

The default view should show only the metadata needed to answer:

- what run is this?
- where am I in replay?
- what node is selected?
- what happened here?

Everything else should be:

- collapsed
- secondary
- or moved into a detail view

## Viewer chrome

The viewer should not have a large changing top navbar.

The left sidebar already establishes:

- run selection
- app identity
- navigation

So the main viewing surface should avoid a second heavy navigation layer.

### Top-level chrome rules

- no large persistent top navbar
- no step-dependent global header that changes while replay advances
- replay controls and run outcome should live in the player section, not a
  separate app bar

If any top chrome remains, it should be minimal and stable.

### Playback stability

While replay is playing:

- the main chrome should not jump
- the header should not change size
- layout should not reflow because the selected step changes

Only the replay-specific surfaces should update:

- scrubber
- current-step indicator
- graph overlay
- inspector content

## Purpose

The viewer must make two things legible at the same time:

- the **flow definition**
- the **run that happened on top of that definition**

The graph should stay the full definition. The viewer must not collapse the
default graph into only the executed path.

The execution should instead appear as a strong overlay on top of the full
definition.

## Primary graph model

The primary graph is the full `FlowDefinitionSnapshot`.

The graph answers:

- where the run can start
- where it can branch
- which nodes are actions, ACP steps, compute steps, and checkpoints
- which nodes are terminal in the definition

The run overlay answers:

- which nodes were visited
- in what order
- which attempt is currently selected in replay
- where the run actually stopped or completed

## Derived graph semantics

These semantics should be derived in the viewer and should not be persisted as
additional fields in the run bundle.

### Start node

The definition start node is:

- `flow.startAt`

It must be rendered explicitly as the entry point.

### Terminal nodes

A definition-terminal node is any node with no outgoing edges.

That should be inferred by:

- collecting all `edge.from` values
- marking nodes that never appear as `edge.from`

Definition-terminal nodes must be visually distinct from normal nodes.

### Decision nodes

A definition-decision node is any node with more than one outgoing target.

That includes:

- switch edges with multiple cases
- multiple direct edges from the same source, if the flow representation ever
  permits that

Decision nodes must be visually distinct from ordinary action or ACP steps.

### Loop and back edges

A back edge is any edge that moves against the main top-to-bottom direction of
the graph.

That should be inferred after ranking nodes.

Back edges must not be routed through the middle of the graph. They should be
sent out to side rails when possible.

## Run semantics

The viewer must not confuse:

- replay position
- run outcome

Replay position means:

- which recorded attempt the scrubber is currently pointing at

Run outcome means:

- `completed`
- `failed`
- `timed_out`
- `waiting`
- `running`

The current replay position must never imply successful completion.

The run outcome should be derived from `run.status`, `run.error`,
`run.currentNode`, `live`, and the recorded steps.

## Graph presentation

### Required visual distinctions

The graph must clearly distinguish:

- start node
- definition-terminal node
- decision node
- ACP node
- action node
- compute node
- checkpoint node
- visited node
- selected replay attempt
- actual run stop/completion point

The current graph's small `nodeType` text tag is not sufficient.

### Node labeling

Each node should show:

- primary label: a human-readable name
- secondary label: the raw node id only if useful

The viewer should not use raw internal ids as the only or dominant label.

Short human labels may be derived by:

- using a node summary if present
- otherwise prettifying the node id

### Terminal rendering

Definition-terminal nodes should be visually obvious even before any replay is
considered.

Run-terminal state should be rendered separately:

- if the run completed, failed, timed out, or stopped at a specific node, that
  should be shown as an overlay attached to the actual reached node
- the lowest node in the graph must not be treated as the end state unless the
  run actually ended there

### Edge labeling

Branch labels must not appear as long raw route ids in floating pills in the
middle of the graph.

Edge labels should be:

- short
- human-readable
- attached near the branching source, not floating in arbitrary mid-edge
  positions

When labels would overlap or create noise, the viewer should prefer:

- abbreviated labels
- hover or selected-edge disclosure
- branch labels rendered near the source node

Raw route ids such as `comment_and_escalate_to_human` should not be shown
directly as edge labels in the default view.

## Layout rules

The graph should be laid out primarily top-to-bottom.

The layout engine must do more than simple breadth-first ranking.

### Goals

- start near the top
- definition-terminal nodes biased toward the bottom
- sibling branches grouped cleanly
- fewer edge crossings
- back edges routed away from the central reading path

### Rules

1. Rank nodes by distance from the start node.
2. Bias definition-terminal nodes toward the final rank.
3. Keep sibling branches horizontally grouped.
4. Route back edges on outer rails instead of through the center.
5. Avoid placing label-heavy branches directly over one another.

If the automatic layout cannot satisfy these rules well enough, the viewer
should add post-processing rather than accepting a tangled graph.

## Replay controls

The transport should behave like a media player.

### Required controls

- play
- pause
- jump to start
- jump to latest recorded attempt
- draggable scrubber

### Replay timeline

The scrubber represents:

- attempt index within the recorded run

It should not represent:

- success percentage
- completion percentage

The timeline should show:

- `Attempt N of M`
- current node
- current attempt id
- real run outcome separately

## Layout shell

The viewer should fit within the viewport.

The outer shell should not grow beyond the screen height.

Scrolling should happen inside sections, not on the page root.

### Required shell

- full-height left sidebar for run selection
- player area for replay controls and run outcome
- central graph pane
- side or lower pane for attempt/session inspection

### Sidebar

The run list should behave like a real left sidebar, similar to a chat or file
picker.

Requirements:

- full-height from top to bottom
- collapsible
- compact one-line rows
- not large card tiles
- not stretched vertically to fill space

The selected run should remain obvious, but the list should not dominate the
screen during normal viewing.

## Inspector panels

The ACP session should be the default panel and the primary reading surface.

The viewer should not dump raw JSON into the main reading path by default.

### Default tabs

- ACP session
- selected attempt details
- raw events

The ACP session tab should be selected by default on load and after run
switching.

The session panel should not feel secondary to attempt metadata. It should be
the main readable explanation of what happened at the selected point in replay.

### ACP session rendering

The default ACP session view should read like a conversation:

- user messages
- agent messages
- tool calls
- tool results

Tool noise should be collapsed or summarized by default.

The user should not have to read large raw payloads unless they intentionally
expand them.

Human-readable session text must not be truncated with ellipses in the default
conversation rendering.

Readable conversation text should:

- wrap
- remain selectable
- remain fully visible within the scrollable session panel

Only clearly secondary metadata may be truncated.

### Required behavior

- show human-readable user and agent text blocks by default
- summarize tool calls in one line
- summarize tool results in one line
- collapse raw payloads behind disclosure controls
- keep the selected ACP slice highlighted
- avoid truncating readable message text
- give the ACP session pane more visual priority than attempt metadata

Raw JSON is still important, but it belongs behind expansion controls or in a
raw-events view.

## Run browser behavior

The run list should not be part of the primary reading path while a run is
being inspected.

That means:

- the sidebar can stay collapsed
- selecting a run should not force the main graph or session panes to reflow in
  a disruptive way
- the run picker should feel like a browser sidebar, not a giant dashboard card

## What the viewer should answer quickly

At a glance, the viewer should answer:

- where does this flow start?
- what are the possible end states?
- what type of step is this node?
- which path did this run actually take?
- where did it stop?
- what ACP conversation corresponds to the selected step?

If the viewer cannot answer those questions quickly, the presentation is wrong
even if the underlying data is correct.

## Implementation guidance

The cleanest implementation split is:

- storage stays unchanged
- graph semantics are derived in the viewer view-model
- layout improvements happen in the viewer graph builder
- session readability improvements happen in the viewer inspector components

That means the likely implementation sites are:

- viewer view-model for start/terminal/decision inference
- graph layout builder for ranking and untangling
- node and edge renderers for semantics and labeling
- inspector components for ACP rendering

## Non-goals

- changing the run-bundle schema just to support presentation
- storing precomputed terminal-node flags in the bundle
- replacing the full definition graph with only the executed path in the default
  view
