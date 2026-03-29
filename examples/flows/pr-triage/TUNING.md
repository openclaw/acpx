# PR Triage Tuning Notes

This file records workflow tuning decisions that are easy to forget later.
Keep it short, concrete, and tied to the checked-in flow.

## Persistent session rule

The `main` ACP session in this workflow is shared reasoning state across
multiple judgment steps.

Do not treat a dead ACP transport as permission to start a fresh persistent
session.

Correct behavior:

- reconnect
- try to load the same underlying agent session
- fail the workflow if that resume fails
- implement that in one session-runtime helper, not in ad hoc flow logic

Incorrect behavior:

- silently create a fresh persistent session and keep going
- scatter dead-session checks across individual workflow nodes

Reason:

That would throw away the worker's accumulated understanding of the PR while
making the later steps look as if they still belonged to one continuous review.

## 2026-03-26: Add conflict gates

Change:

We added explicit conflict checks:

- before validation, so the flow does not keep reasoning over a stale head
- after review and CI, so the flow does not hand off a PR that became stale
  while the autonomous lane was working

We also separated the two human handoff meanings in the diagram:

- ready for landing
- needs judgment

Reason:

The original shape was too optimistic about base stability. A PR could look
clean early, then drift behind `main` while review or CI was running.

That made the workflow vulnerable to a bad final handoff:

- "this looks ready"
- but only against an older base state

The conflict gates fixed that by making the flow re-check mergeability at the
two points that actually matter:

- before spending time validating the work
- before declaring the PR ready for human landing

What we decided not to do:

We did **not** add a separate standalone CI loop node just for late conflicts.

Instead, the late conflict path routes back into the existing post-review lane,
because the problem is still "is this PR still valid against current base,"
not a fundamentally different workflow.

References:

- Flow policy: [README.md](./README.md)
- Flow implementation: [pr-triage.flow.ts](./pr-triage.flow.ts)
- PR that made this change: [#180](https://github.com/openclaw/acpx/pull/180)

## 2026-03-28: Require explicit write-capable grants

Change:

This flow now requires an explicit `--approve-all` grant when run through
`acpx flow run`.

Reason:

The PR-triage flow does real write-capable work:

- it may edit files
- it may push to the PR branch
- it may approve GitHub Actions workflow runs

When that permission was missing or silently downgraded, the flow could get
deep into the autonomous lane and then fail in confusing ways.

We wanted the permission rule to be obvious at the start:

- if this flow is allowed to act, say so explicitly
- if not, fail before doing work

Related runtime lesson:

Local `codex review --base ...` can take a long time in this repo. Long review
time by itself is not evidence that the flow is stuck.

References:

- Flow policy: [README.md](./README.md)
- Flow implementation: [pr-triage.flow.ts](./pr-triage.flow.ts)
- PR that made this change: [#186](https://github.com/openclaw/acpx/pull/186)

## 2026-03-28: Let maintenance PRs use standard checks

Change:

We stopped treating "no bespoke local validation command" as a reason to
escalate routine maintenance PRs.

For maintenance-scope work such as tooling, docs, or lockfile churn, the flow
can accept standard repo checks as sufficient validation.

Reason:

The old behavior was too bureaucratic. A routine maintenance PR could get all
the normal signals:

- clear intent
- acceptable implementation
- green CI

and still escalate just because the flow could not name one special targeted
test command.

That was wrong for this class of PR. In these cases, the normal repo checks are
often the real validation.

What we decided not to do:

We did **not** add a new "maintenance validation" node.

This is still a judgment question inside the existing validation lane, not a
new runtime capability.

References:

- Flow policy: [README.md](./README.md)
- Flow implementation: [pr-triage.flow.ts](./pr-triage.flow.ts)
- PR that made this change: [#187](https://github.com/openclaw/acpx/pull/187)

## 2026-03-28: Let ACP choose validation plans

Change:

We removed the hardcoded JS test-plan logic from the bug and feature validation
lanes and moved validation planning back into ACP judgment.

Plainly:

- the model now decides what validation to run
- the runtime no longer mostly guesses from changed test files

Reason:

The old behavior was too dumb for real PRs. It was especially bad on bug-fix
PRs where the repro was already described in the PR text but no changed test
file pointed to an obvious command.

That led to bad escalations for the wrong reason:

- not because the PR looked wrong
- but because the deterministic helper did not know what command to run

The fix was to let ACP do the planning, because choosing a repro or validation
command is a judgment task, not a good place for rigid runtime rules.

What we decided not to do:

We did **not** add a new planning node.

We kept the same graph shape and changed the existing validation lanes instead.

References:

- Flow policy: [README.md](./README.md)
- Flow implementation: [pr-triage.flow.ts](./pr-triage.flow.ts)
- PR that made this change: [#189](https://github.com/openclaw/acpx/pull/189)

## 2026-03-28: Broaden `judge_refactor`

Change:

We changed the `judge_refactor` step so it no longer asks only about
"refactor depth."

It now asks a broader question:

- is the PR ready as-is?
- or should anything still be added, removed, simplified, or refactored before
  it continues?

We kept the same flow shape and the same categories:

- `none`
- `superficial`
- `fundamental`

This was a wording and judgment-policy change, not a graph change.

Reason:

The old wording was too narrow. It was good at catching code that looked like
it needed cleanup or a deeper rewrite, but it was weaker at catching small
extra behavior that should simply be removed before landing.

The concrete example was [#128](https://github.com/openclaw/acpx/pull/128).
That PR had a real bug fix, but it also added model-alias rewriting that was
not needed for the fix. The workflow noticed that as a mild concern, but it did
not push hard enough on the simpler question:

> should this extra behavior be removed before the PR continues?

That is the gap this wording change is meant to close.

What we decided not to do:

We did **not** add a new node.

Reason:

- this is a judgment/policy issue, not a new runtime capability
- the existing `judge_refactor` node already owns the right decision point
- adding a node would make the graph larger without making the workflow smarter

So the correct fix here was to sharpen the existing judgment, not add more flow
structure.

What this should catch better now:

This tuning is meant to catch cases like:

- a bug fix that also bundles extra convenience behavior that should be removed
- a feature PR that still needs one small missing piece added
- a mostly good solution that includes a minor wrong-shaped local addition
- a PR that is fine in direction but still needs a small simplification before
  review and CI

References:

- Flow prompt: [pr-triage.flow.ts](./pr-triage.flow.ts)
- Workflow policy: [README.md](./README.md)
- Regression test: [../../../test/pr-triage-example.test.ts](../../../test/pr-triage-example.test.ts)
- Example PR that motivated the change: [#128](https://github.com/openclaw/acpx/pull/128)
- PR that made this wording change: [#190](https://github.com/openclaw/acpx/pull/190)

## 2026-03-29: `#128` follow-up is only partially solved

Observation:

We reran the workflow on [#128](https://github.com/openclaw/acpx/pull/128)
after broadening `judge_refactor`.

That was only a partial success.

What improved:

- the workflow finally tipped toward `superficial`
- it entered `do_superficial_refactor`
- it no longer waved the PR through unchanged

What still went wrong:

- the model cleaned up the duplication
- but it did **not** delete the unnecessary model-alias rewriting itself
- we had to remove that extra behavior manually afterward

Reason:

The high-level refactor wording was strong enough to change the route, but not
strong enough to make the model consistently choose the exact cleanup we
wanted.

In this case, the workflow still treated the alias behavior as too close to the
"validated solution," so the model preferred centralizing it over deleting it.

What we are deciding here:

- stop tuning this blindly for now
- do **not** treat [#128](https://github.com/openclaw/acpx/pull/128) as fully
  solved from a workflow-policy point of view
- come back later, reproduce this PR again, and continue tuning from that fresh
  repro

What this suggests for future tuning:

We likely need finer-grained checks and finer-grained instructions for how the
workflow should modify PRs from external contributors.

In particular, future tuning should help the model distinguish:

- the core fix that must stay
- extra behavior that should be removed
- duplication that can be centralized
- small additions that should be added before landing
- small local changes that should be separated out instead of bundled together

Plainly:

We made the workflow better at noticing "something here should change," but not
yet good enough at deciding the exact shape of that change.

References:

- Example PR: [#128](https://github.com/openclaw/acpx/pull/128)
- Workflow policy: [README.md](./README.md)
- Flow prompt: [pr-triage.flow.ts](./pr-triage.flow.ts)
- Current tuning notes PR: [#190](https://github.com/openclaw/acpx/pull/190)
