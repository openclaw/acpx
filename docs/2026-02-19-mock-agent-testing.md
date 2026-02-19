---
title: Mock Agent Testing Framework
author: Bob <bob@dutifulbob.com>
date: 2026-02-19
---

# Mock Agent Testing Framework

`acpx` now includes a local ACP mock agent and integration tests that exercise the
CLI against real JSON-RPC traffic over stdio.

## What It Is

- `test/mock-agent.ts`: a standalone ACP agent implementation used only for tests.
- `test/integration.test.ts`: end-to-end tests that run `acpx` as a subprocess with
  `--agent "node <mock-agent>"`.

The mock agent supports:

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`

Prompt scenarios implemented:

- `echo <text>`
- `read <path>`
- `write <path> <content>`
- `terminal <command>`
- `kill-terminal <command>`

## How To Run

Build and run all tests:

```bash
npm run build
npm test
```

Integration tests compile to `dist-test/test/*.js`, and run the compiled
mock agent at `dist-test/test/mock-agent.js`.

## Architecture

The mock agent uses `AgentSideConnection` + `ndJsonStream` from
`@agentclientprotocol/sdk`:

1. `acpx` starts the mock agent process via `--agent`.
2. `acpx` sends ACP requests (`initialize`, `session/new`, `session/prompt`).
3. Mock agent sends ACP client-method requests back to `acpx`:
   - `fs/read_text_file`
   - `fs/write_text_file`
   - `terminal/create`
   - `terminal/output`
   - `terminal/wait_for_exit`
   - `terminal/kill`
   - `terminal/release`
4. Mock agent emits `session/update` chunks so `acpx` output formatters can render
   normal assistant text.

This validates both directions of ACP communication, not just command parsing.

## Adding New Scenarios

1. Add a new prompt branch in `test/mock-agent.ts` inside `handlePrompt(...)`.
2. Execute ACP client methods needed for that branch.
3. Return deterministic assistant text so tests can assert cleanly.
4. Add a new case to `test/integration.test.ts` that calls `acpx ... exec "<prompt>"`.
5. Assert:
   - process exit code
   - stdout/stderr behavior
   - side effects (files/process lifecycle) if relevant

## Current Coverage

- Baseline one-shot exec flow (`echo`)
- Filesystem read/write via ACP client methods
- CWD subtree enforcement for filesystem access
- Full terminal lifecycle (`create` + `output` + `wait_for_exit` + `release`)
- Terminal termination (`kill`) with orphan-process guard
