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
- replay controls should live at the bottom edge of the graph surface, not in a
  separate app bar
- run outcome should live with the replay controls, not in a stacked summary
  card above the graph

If any top chrome remains, it should be minimal and stable.

### Delete the current redundant chrome

The following current surfaces should be removed rather than restyled:

- the large top navbar/header strip
- the duplicated run name, status, node, and source pills in that strip
- the separate run-outcome card when it duplicates the player state
- duplicated current-step metadata chips such as attempt, started-at, or run
  duration when that same information is already available in the player
- the large selected-step summary card above the graph when it only repeats the
  current replay position
- the long row of visited-node pills beneath the player
- the graph header legend pills such as `COMPLETED`, `SELECTED`, `QUEUED`, and
  `PROBLEM`
- redundant section titles when the surrounding layout already makes the section
  obvious

The viewer should not present the same state in multiple stacked boxes. It
should keep one canonical place for:

- current replay position
- run outcome
- selected node
- ACP conversation

It should not repeat the same replay-step metadata both above and below the
scrubber.

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

The viewer should not rely on hand-tuned explicit coordinates for real flows.
The graph should derive a readable layout automatically from the definition and
its inferred semantics.

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

### Preferred layout engine

The target implementation should use a real layered graph layout engine rather
than continuing to grow a custom heuristic ranker.

Preferred direction:

- `ELK layered` from Eclipse Layout Kernel

Acceptable transitional direction:

- `dagre`

But the long-term target is `ELK layered`, not a permanent in-house layout
algorithm.

### Why ELK layered

The replay viewer needs more than node ranking. It needs:

- crossing reduction
- branch grouping
- top-to-bottom layered flow layout
- port-aware edge routing
- bend points for orthogonal or near-orthogonal edges
- separation of forward edges from back edges

That is a real graph-layout problem. It should be handled by a graph-layout
engine instead of a growing pile of viewer-specific heuristics.

### Required graph-to-layout pipeline

The viewer should derive semantic structure first, then hand a layout graph to
the engine.

Required derived semantics:

- start node
- definition-terminal nodes
- decision nodes
- pre-terminal chains
- back edges / loop edges

The layout pipeline should then:

1. build a directed graph from the flow definition
2. separate back edges from the forward layered graph for layout purposes
3. insert dummy routing points for long edges that span multiple ranks when
   needed
4. assign layered layout constraints
5. route back edges on outer rails instead of through the central reading path
6. return node positions and routed edge geometry

The viewer should then render that returned geometry in React Flow.

### Required layout constraints

The layout engine should be configured so that:

- the graph direction is top-to-bottom
- definition-terminal nodes sink to the bottom ranks
- pre-terminal chains stay near terminal ranks
- sibling branches stay grouped
- decision nodes sit above their branch fan-out
- long forward edges do not cut straight through unrelated branches
- back edges are visibly distinct and routed outside the main flow

### Rendering contract

React Flow should be treated as the renderer, not the layout engine.

That means:

- node positions should come from the layout result
- edge bend points or routed segments should come from the layout result when
  available
- the viewer should not depend on default edge generation from rough node
  placement if the result causes avoidable crossings

### Long-term architecture

The durable architecture is:

- semantic graph inference
- ELK layered layout
- routed edges from the layout result
- run replay as an overlay on top of that static semantic map

This is the preferred "once and for all" direction for making large flow
definitions readable without hand-authoring coordinates.

## Replay controls

The transport should behave like a media player.

### Required controls

- play
- pause
- previous
- next
- jump to start
- jump to latest recorded attempt
- draggable scrubber
- compact icon buttons in the transport surface when space is tight
- footer placement at the bottom of the graph card

### Camera modes

The graph should support two viewing modes:

- `follow`
- `overview`

`follow` should be the default.

`follow` means:

- the camera tracks the currently active node
- the camera transition eases from node to node
- switching steps should not cause a hard jump

`overview` means:

- the full definition graph is visible
- the camera stops auto-following step changes
- switching into overview should ease into a fit-to-view state

The viewer should not require persisted coordinates or hand-authored camera
positions for this behavior.

### Replay timeline

The scrubber represents:

- attempt index within the recorded run

It should not represent:

- success percentage
- completion percentage

The timeline should show:

- `Attempt N of M`
- current node
- real run outcome separately

It should not show multiple secondary status boxes that repeat the same replay
state in different wordings.

### Continuous playback model

The replay viewer should keep the stored run data discrete while making playback
feel continuous.

That means:

- the run bundle remains step-based and attempt-based
- the viewer adds a transient continuous playhead
- pausing or releasing the scrubber snaps back to the nearest discrete attempt

The viewer should not add fractional or interpolated playback state to the
stored run bundle.

### Canonical vs transient state

The viewer should keep two layers of state:

1. canonical discrete replay state
2. transient playback state

Canonical discrete replay state answers:

- which attempt is selected
- which ACP slice is selected
- which node is selected when the viewer is paused

Transient playback state answers:

- where the playhead currently is while playing
- where the scrubber is while dragging
- how far the current ACP message reveal has progressed

The discrete state remains the source of truth when replay is paused.

### Time model

Continuous playback should be time-based, not percentage-based.

The viewer should derive playback from:

- attempt start time
- attempt finish time
- run start time
- run finish time when available

Within a step, local playback progress should be derived from elapsed time
between the step start and finish.

If a step has no meaningful duration, the viewer may use a small synthetic
minimum playback duration for presentation only.

That synthetic duration must remain viewer-local and must not be written back to
the bundle.

### ACP message reveal

When replay is actively playing, ACP text should reveal progressively rather
than appearing only at step boundaries.

Required behavior:

- user turns should appear as full turns, not type character by character
- user-turn appearance should still ease in smoothly instead of popping
- assistant text should reveal progressively
- tool calls and tool results may appear once the playhead reaches the relevant
  message threshold
- raw payload disclosures should stay closed by default during playback

When replay is paused or scrubbing ends:

- the ACP pane should snap to the nearest discrete step
- the selected step should render in its full discrete state
- the viewer should not remain stuck in a half-revealed message state

### Graph overlay during playback

The full definition graph should remain structurally discrete.

Continuous playback should affect only the overlay:

- edge highlight progression
- node emphasis
- selected-attempt indicator
- current-position glow or stroke

The viewer should not invent intermediate nodes or intermediate graph topology.

### Scrubber behavior

The scrubber should behave like a media player seek bar.

While dragging:

- the viewer may preview a continuous playhead position
- the viewer should not immediately commit a new discrete selection on every
  pointer movement

When the drag ends:

- snap to the nearest discrete attempt
- commit that attempt as the selected step
- render the canonical paused state for that attempt

### Paused state

When replay is paused:

- the graph overlay should reflect a single discrete attempt
- the inspector should reflect a single discrete ACP slice
- the playhead should not imply continuous progression

The paused viewer should always answer:

- which attempt is selected right now
- which node that attempt belongs to
- what the exact stored state of that attempt was

### Implementation boundary

This behavior belongs in the viewer playback model and view-model only.

It should not require:

- changes to the run bundle schema
- new persistence fields for interpolation
- synthetic progress values stored in run projections

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

The viewer should prefer the ACP session pane over extra attempt-summary boxes.
If space is tight, remove duplicate attempt summary surfaces before shrinking
the session view.

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
