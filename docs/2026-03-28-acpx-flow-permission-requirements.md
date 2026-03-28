---
title: acpx Flow Permission Requirements
description: Explicit permission-grant model for powerful flows that need write-capable ACP sessions.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-03-28
---

# acpx Flow Permission Requirements

## Status

This document specifies the intended flow permission model.

It is a design target for `acpx` flows and should not be read as if every part
is already enforced in the current runtime.

## Why this exists

Some flows are meaningfully more powerful than ordinary `acpx` prompts.

Examples:

- flows that edit files
- flows that commit and push
- flows that approve CI workflows
- flows that close or comment on pull requests

Those flows should not depend on:

- a hidden global default
- a silently permissive config
- a runtime path that downgrades permissions later

The model should be explicit:

- the flow declares what it needs
- the operator grants it deliberately
- the runtime enforces that requirement before work starts

## Core position

Flows may declare required permission levels.

Powerful flows should be allowed to require an explicit operator grant before
the run begins.

That means:

- do not make `approve-all` the global default for all `acpx` usage
- do not let authored flows silently force `approve-all`
- do let a flow fail fast when it requires write-capable permissions and the
  operator did not explicitly grant them

## Flow-authored requirement model

Flows should be able to declare permission requirements in the flow definition.

Target shape:

```ts
export default defineFlow({
  name: "pr-triage",
  permissions: {
    requiredMode: "approve-all",
    requireExplicitGrant: true,
    reason:
      "This flow edits files, pushes commits, and may approve CI workflow runs.",
  },
  nodes: { ... },
  edges: [ ... ],
});
```

Fields:

- `requiredMode`
  - minimum permission mode needed for the flow to run correctly
- `requireExplicitGrant`
  - whether the operator must explicitly grant that mode instead of inheriting
    it accidentally from a broad default
- `reason`
  - short human-facing explanation shown in preflight failures

This should stay small.

Do not turn it into a large permission DSL.

## Resolution model

The runner should resolve the effective permission mode together with its
source.

Conceptually:

- CLI flag
- future per-flow config grant
- generic config default
- runtime default

The effective mode alone is not enough.

The runner must also know whether that mode was granted explicitly for this
flow.

## Explicit grant rule

When a flow declares:

- `requiredMode: "approve-all"`
- `requireExplicitGrant: true`

then a generic default should not satisfy that requirement by accident.

In particular:

- a plain global `defaultPermissions: "approve-all"` should not count as an
  explicit grant for a powerful flow
- a runtime fallback should never count as an explicit grant
- an explicit CLI flag such as `--approve-all` should count
- a future per-flow config grant should count

This keeps the operator intent clear.

## Preflight enforcement

The runner should validate permission requirements before the flow starts.

If the requirement is not satisfied, fail immediately and clearly.

Example:

```text
This flow requires an explicit approve-all grant.
Rerun with: acpx flow run examples/flows/pr-triage/pr-triage.flow.ts --approve-all
Reason: This flow edits files, pushes commits, and may approve CI workflow runs.
```

This is better than:

- silently downgrading the flow
- allowing a partial run to fail deep in an ACP step
- making the agent discover mid-run that writes are blocked

## Future config support

The model should leave room for future per-flow configuration.

Target direction:

- flow authors declare the requirement in the flow file
- operators may satisfy that requirement with an explicit per-flow grant

That future config should be keyed by a stable flow identity, not by a fragile
local path string.

Conceptually:

```json
{
  "flowPermissionGrants": {
    "openclaw/pr-triage": {
      "mode": "approve-all"
    }
  }
}
```

The exact config surface can still change later, but the design constraint is:

- explicit per-flow grant is allowed
- broad ambient default is not enough when explicit grant is required

## Runtime propagation rule

Once a flow has been granted a permission mode, the runtime must honor it
through the entire execution path.

That includes:

- direct ACP steps
- queue-owner paths
- session reuse
- reconnect/resume paths

The runtime must not silently downgrade a granted flow from:

- `approve-all`

to:

- `approve-reads`

inside an internal helper path.

If the effective mode is `approve-all`, every ACP client involved in the flow
should inherit that mode unless a node explicitly asks for something stricter.

## Product rule

The intended product rule is:

- ordinary `acpx` usage may stay conservative by default
- powerful flows may require write-capable permissions
- those powerful flows should fail fast unless the operator explicitly grants
  them

In short:

- flows declare requirements
- operators grant them explicitly
- the runtime enforces and propagates them faithfully
