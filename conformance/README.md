# ACP Conformance Suite (Draft)

This directory defines a protocol-level conformance suite for ACP adapters and
clients.

The initial goal is to lock down stable, high-value protocol behavior for core
session lifecycle flows.

## Scope (v1)

- `initialize`
- `session/new`
- `session/prompt`
- `session/update`
- `session/cancel`
- baseline error semantics (`Invalid params`, unknown session)

Deterministic permission checks, cancellable delays, and late updates use the
bundled mock adapter's command semantics in a separate mock profile.

## Non-goals (v1)

- Adapter-specific UX behavior
- Harness-specific CLI flags
- Performance benchmarking
- Full coverage of unstable ACP methods

## Directory layout

- `spec/v1.md`: normative contract for the v1 conformance profile
- `cases/*.json`: data-driven case definitions consumed by the runner
- `profiles/*.json`: profile files that declare required case ids
- `runner/run.ts`: minimal executable draft runner

## Case naming

Case files are prefixed numerically to preserve stable execution ordering.

## Status

Draft contract and seed case corpus.

The default profile (`acp-core-v1`) includes 14 adapter-independent required cases.
The explicit `acpx-mock-v1` profile includes those cases and seven mock-specific
regressions, for 21 required cases in total.

## Run

Run the core profile against the default mock ACP adapter:

```bash
pnpm run conformance:run
```

Run all deterministic regressions with the bundled mock adapter:

```bash
pnpm run conformance:run -- --profile conformance/profiles/acpx-mock-v1.json
```

Run a single case:

```bash
pnpm run conformance:run -- --case acp.v1.initialize.handshake
```

Run against another adapter command:

```bash
pnpm run conformance:run -- \
  --agent-command "npx -y @agentclientprotocol/codex-acp"
```

Emit machine-readable JSON and write a report file:

```bash
pnpm run conformance:run -- \
  --format json \
  --report ./conformance-artifacts/report.json
```

## Notes

- The draft runner currently executes required case ids from the selected
  profile and prints a pass/fail matrix. `--case` narrows that selected profile's
  required cases; use the mock profile to select its permission or active-cancel
  cases.
- Case/profile parsing is pure Node JSON parsing (no Python dependency).
- The runner is data-driven: it executes structured case `steps` and `checks`
  from JSON instead of hard-coded `case id -> logic` switches.
- Core structured prompts use baseline `text` and `resource_link` content. Their
  synthetic URI identifies a content block; the case does not require a real
  file or prove a file read. Embedded `resource` transport and exact mock reply
  assertions are retained in runner tests against the bundled mock, which
  advertises `embeddedContext` support.
- Use `acpx-mock-v1` with the bundled mock adapter: its permission prompts,
  cancellable delays, and post-success updates depend on known mock commands.
- Filesystem callbacks resolve paths within the session cwd, including symlinks
  that stay inside it. Links that escape the cwd and writes to hardlinked files
  are rejected. Relative paths use the session cwd without changing the adapter
  command's working directory.
- Read callbacks honor the optional one-based `line` and maximum-line `limit`
  selectors, matching the production client. Even a zero-line read must pass
  permission and filesystem checks.
- Run write cases in a disposable workspace: existing files can be overwritten.
  Newly created files receive best-effort cleanup within the same filesystem
  root. These callback checks do not sandbox the adapter process itself.
- Each case retires its adapter, witnessed descendants, and transport before
  reporting its result. Cleanup has an eight-second budget and escalates from
  stdin EOF to TERM and KILL. If retirement cannot be verified, the case fails
  with a cleanup diagnostic and later cases are not launched; an original case
  error remains in the report too.
- SIGINT, SIGTERM, and SIGHUP stop new work and interrupt pending requests,
  sleeps, and settle waits. The runner completes owned cleanup and writes the
  partial report before exiting with the first signal (or its conventional
  numeric exit status on Windows). Repeated signals do not skip cleanup.
  Descendants that escape observation and abrupt, uncatchable termination are
  outside this cleanup guarantee.

## Data-Driven Model

Each case file can define:

- `permission_mode`: optional override per case (`approve-all` or `deny-all`)
- `steps`: ordered operations
  - `new_session`
  - `prompt`
  - `prompt_background`
  - `await_background`
  - `cancel`
  - `sleep`
- `checks`: assertions evaluated after step execution
  - `initialize_protocol_version_number`
  - `saved_non_empty_string`
  - `saved_error_present`
  - `saved_stop_reason_in`
  - `updates_count_at_least`
  - `updates_all_session`
  - `updates_text_includes`
  - `updates_session_update_includes`
  - `filesystem_operation`

`filesystem_operation` requires a completed local filesystem callback somewhere
in the case, before checks run after the optional settle wait. It matches
`method` (`read_text_file` or `write_text_file`), `session` (a literal ID or saved
reference), and the exact literal request `path`. Writes also require exact
`content`, including an empty string when that is the intended write.
`outcome` is either `{ "type": "success" }` or
`{ "type": "error", "code": -32001 }` with the expected numeric error code.
Successful reads may add `content_includes` inside `outcome` to match a
case-insensitive substring of the actual returned file content.

This check proves local callback completion, not prompt attribution, response
delivery or peer receipt. A completed callback during session creation or an
earlier prompt can satisfy it; an unfinished callback cannot. The mock
permission/read/write cases require these operation checks in addition to their
prompt completion expectations. Agent prose and a separate permission request
cannot substitute for the actual filesystem operation.

When a step declares `expect_error`, its operation must fail. Optional `codes`
and `message_any` fields filter the failure; `{}` accepts any operation error.
Runner interruption is never an expected operation error. A successful operation
always fails the case.

The runner validates the profile and every JSON file in the cases directory
before launching an adapter, including files outside a `--case` selection.
Unknown fields, actions or checks, malformed control values, duplicate case IDs
and duplicate required IDs are startup errors. Known descriptive metadata remains
optional; minimal cases and empty step/check arrays are supported.

Validation applies to runner instructions. Session cwd and session-ID payloads,
and the contents of prompt blocks, remain unchanged so negative protocol cases
can deliberately send invalid ACP inputs. Saved keys are literal names; inherited
JavaScript properties cannot satisfy a saved-value assertion.

## Nightly Workflow

- Workflow file: `.github/workflows/conformance-nightly.yml`
- `Conformance (Mock Full)` always runs the explicit `acpx-mock-v1` profile on the
  local mock adapter and uploads a JSON report artifact.
- `Conformance (Real Adapter Smoke)` runs only when repository variable
  `ACPX_CONFORMANCE_REAL=1`, using handshake smoke checks for selected
  real adapters.
- Manual (`workflow_dispatch`) runs can force real-adapter execution with
  `run_real_adapters=true`.
- Manual runs can enforce strict failures with
  `strict_real_adapters=true` (disables `continue-on-error` for the real-adapter
  matrix).
