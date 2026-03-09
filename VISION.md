# acpx Vision

`acpx` should be the smallest useful ACP client: a lightweight CLI that lets one
agent talk to another agent through the Agent Client Protocol without PTY
scraping or adapter-specific glue.

The goal is not to build a giant orchestration layer. The goal is to make ACP
practical, robust, and easy to compose in real workflows.

Project overview: [`README.md`](README.md)
Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Core Idea

`acpx` exists to make agent-to-agent communication over ACP reliable from the
command line.

It should work in two modes at the same time:

- as an agent-first CLI that humans can still drive directly when needed
- as a reusable backend for tools that do not want to reimplement session
  storage, queueing, lifecycle handling, or harness-specific behavior

If a tool wants ACP sessions, structured output, queueing, and persistence, it
should be able to delegate those concerns to `acpx` instead of rebuilding them.
The primary user is another agent, orchestrator, or harness. Human usability
still matters, but it is a secondary constraint.

## Principles

### 1. Interoperability first

`acpx` should maximize interoperability across ACP adapters, agent harnesses,
and automation tools.

The standard is ACP, not the quirks of a single agent. Where adapters differ,
`acpx` should smooth the rough edges in a robust way without hiding important
protocol semantics.

This means:

- keep the wire-level behavior close to ACP
- normalize common incompatibilities when it improves portability
- preserve structured data so downstream tools can make their own decisions
- avoid features that lock users into one agent or one harness

### 2. Keep the core small

`acpx` should not try to do too many things at once.

It should stay focused on the problems that are central to being a strong ACP
client:

- starting and talking to ACP agents
- managing persistent sessions
- queueing prompts safely
- handling permissions and lifecycle concerns
- rendering structured responses for humans and machines

If a feature does not make `acpx` a better ACP client or backend, it probably
does not belong in core.

### 3. Robust by default

`acpx` should be dependable in long-running, automated, and multi-turn
workflows.

That means the defaults should favor:

- session continuity
- safe queueing behavior
- clear failure modes
- recoverable lifecycle management
- machine-readable output and stable exit behavior

Robustness matters more than novelty. A boring feature that works everywhere is
better than a clever feature that only works in one harness.

### 4. Conventions are API surface

In `acpx`, data models, config keys, keywords, flags, output shapes, and naming
conventions are part of the product surface.

They should be scrutinized multiple times before being added or changed.
Convenience is not enough. Every new convention creates long-term compatibility
cost.

This applies even to choices that may look small. For example, when `acpx`
defines `claude` instead of `claude-code`, that should be an intentional
convention, not a casual shortcut.

People and tools will build workflows on top of `acpx`. Once a keyword, flag,
field, or convention becomes part of those workflows, changing it casually can
break users and create unnecessary cruft. The default stance should be to add
fewer conventions, make them clearer, and keep them stable.

### 5. Fully customizable

`acpx` should be easy to customize locally and per project.

Static config should cover the common cases well. When users need more than
static JSON, they should be able to define and extend their local `acpx`
configuration programmatically in a controlled way, similar in spirit to Pi.

The point of customization is not to make the core bigger. The point is to let
users adapt `acpx` to their environment without forking it.

### 6. Backend-friendly

`acpx` should be useful even for tools whose end users never type `acpx`
directly.

Many tools want the benefits of ACP, but they do not want to own:

- session persistence
- queue ownership
- prompt serialization
- adapter process management
- permission policy behavior
- harness-specific operational details

`acpx` should be able to serve as that backend layer cleanly and predictably.

## Configuration and Extension

Configuration should be a strength of `acpx`, not an afterthought.

Users should be able to define:

- default agents and agent commands
- project-local overrides
- permission policies
- output formats
- session behavior
- reusable local conventions

Over time, `acpx` should support a robust programmatic extension model for local
configuration when declarative config is not enough. That model should be
explicit, inspectable, and predictable.

## What acpx Should Enable

`acpx` should make it straightforward to:

- swap one ACP-capable agent for another without rewriting orchestration
- run persistent multi-turn sessions from shell scripts and CI-like tooling
- build higher-level tools on top of a stable session and queueing layer
- preserve structured agent output instead of scraping terminal text
- bridge differences between harnesses without hard-coding every harness into
  downstream tools

## What acpx Should Not Become

`acpx` should not become:

- a kitchen-sink automation framework
- a replacement for every agent harness
- a UI-heavy product with a thin CLI attached
- a pile of agent-specific special cases with no coherent core

The test for new features should be simple:

Does this make `acpx` more interoperable, more robust, or more useful as a
lightweight ACP backend?

If not, it should probably live outside the core.
