# PR Triage Tuning Notes

This file records workflow tuning decisions that are easy to forget later.
Keep it short, concrete, and tied to the checked-in flow.

## 2026-03-28: Broaden `judge_refactor`

### What changed

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

### Why we changed it

The old wording was too narrow. It was good at catching code that looked like
it needed cleanup or a deeper rewrite, but it was weaker at catching small
extra behavior that should simply be removed before landing.

The concrete example was [#128](https://github.com/openclaw/acpx/pull/128).
That PR had a real bug fix, but it also added model-alias rewriting that was
not needed for the fix. The workflow noticed that as a mild concern, but it did
not push hard enough on the simpler question:

> should this extra behavior be removed before the PR continues?

That is the gap this wording change is meant to close.

### What we decided not to do

We did **not** add a new node.

Reason:

- this is a judgment/policy issue, not a new runtime capability
- the existing `judge_refactor` node already owns the right decision point
- adding a node would make the graph larger without making the workflow smarter

So the correct fix here was to sharpen the existing judgment, not add more flow
structure.

### What this should catch better now

This tuning is meant to catch cases like:

- a bug fix that also bundles extra convenience behavior that should be removed
- a feature PR that still needs one small missing piece added
- a mostly good solution that includes a minor wrong-shaped local addition
- a PR that is fine in direction but still needs a small simplification before
  review and CI

### References

- Flow prompt: [pr-triage.flow.ts](./pr-triage.flow.ts)
- Workflow policy: [README.md](./README.md)
- Regression test: [../../../test/pr-triage-example.test.ts](../../../test/pr-triage-example.test.ts)
- Example PR that motivated the change: [#128](https://github.com/openclaw/acpx/pull/128)
- PR that made this wording change: [#190](https://github.com/openclaw/acpx/pull/190)
