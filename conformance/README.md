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
- baseline error semantics (`Invalid params`, permission denied, unknown session)

## Non-goals (v1)

- Adapter-specific UX behavior
- Harness-specific CLI flags
- Performance benchmarking
- Full coverage of unstable ACP methods

## Directory layout

- `spec/v1.md`: normative contract for the v1 conformance profile
- `cases/*.json`: data-driven case definitions consumed by a future runner
- `profiles/*.json`: profile files that declare required case ids
- `runner/run.ts`: minimal executable draft runner

## Case naming

Case files are prefixed numerically to preserve stable execution ordering.

## Status

Draft contract and seed case corpus.

Current profile (`acp-core-v1`) includes 20 required cases.

## Run

Run against the default mock ACP adapter:

```bash
pnpm run conformance:run
```

Run a single case:

```bash
pnpm run conformance:run -- --case acp.v1.initialize.handshake
```

Run against another adapter command:

```bash
pnpm run conformance:run -- \
  --agent-command "npx -y @zed-industries/codex-acp"
```

Emit machine-readable JSON and write a report file:

```bash
pnpm run conformance:run -- \
  --format json \
  --report ./conformance-artifacts/report.json
```

## Notes

- The draft runner currently executes required case ids from the selected
  profile and prints a pass/fail matrix.
- Case/profile parsing is pure Node JSON parsing (no Python dependency).
- The runner is data-driven: it executes structured case `steps` and `checks`
  from JSON instead of hard-coded `case id -> logic` switches.

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

## Nightly Workflow

- Workflow file: `.github/workflows/conformance-nightly.yml`
- `Conformance (Mock Full)` always runs the full profile on the local mock
  adapter and uploads a JSON report artifact.
- `Conformance (Real Adapter Smoke)` runs only when repository variable
  `ACPX_CONFORMANCE_REAL=1`, using handshake smoke checks for selected
  real adapters.
- Manual (`workflow_dispatch`) runs can force real-adapter execution with
  `run_real_adapters=true`.
- Manual runs can enforce strict failures with
  `strict_real_adapters=true` (disables `continue-on-error` for the real-adapter
  matrix).
