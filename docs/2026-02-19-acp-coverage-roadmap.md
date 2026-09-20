---
title: ACP Spec Coverage
author: Bob <bob@dutifulbob.com>
date: 2026-02-19
---

# ACP Spec Coverage

What acpx implements from the ACP spec today and what is not yet implemented.

## Supported Now

| ACP Method                   | acpx Feature                                     | Supported |
| ---------------------------- | ------------------------------------------------ | --------- |
| `initialize`                 | Handshake, capability negotiation                | yes       |
| `session/new`                | `sessions new`                                   | yes       |
| `session/load`               | Crash resume / reconnect                         | yes       |
| `session/list`               | Agent-side session listing when advertised       | yes       |
| `session/resume`             | Reconnect without history replay when advertised | yes       |
| `session/prompt`             | `prompt`, `exec`, implicit prompt                | yes       |
| `session/update`             | Streaming output (thinking, tools, text, diffs)  | yes       |
| `session/cancel`             | Graceful cancel + `acpx <agent> cancel`          | yes       |
| `session/request_permission` | `--approve-all`, `--approve-reads`, `--deny-all` | yes       |
| `session/set_mode`           | `acpx <agent> set-mode <mode>`                   | yes       |
| `session/set_config_option`  | `acpx <agent> set <key> <value>`                 | yes       |
| `session/set_model`          | Legacy advertised model fallback                 | yes       |
| `fs/read_text_file`          | ACP client file read handler                     | yes       |
| `fs/write_text_file`         | ACP client file write handler                    | yes       |
| `terminal/create`            | ACP client terminal spawn handler                | yes       |
| `terminal/output`            | ACP client terminal output handler               | yes       |
| `terminal/wait_for_exit`     | ACP client terminal wait handler                 | yes       |
| `terminal/kill`              | ACP client terminal kill handler                 | yes       |
| `terminal/release`           | ACP client terminal release handler              | yes       |
| `authenticate`               | Auth handshake handling                          | yes       |

### Supported Behavior Notes

#### Session listing and reconnect

- `sessions list` uses `session/list` when the adapter advertises `sessionCapabilities.list`. It supports adapter-side cwd filtering and cursor pagination; `--local` reads saved acpx records instead. When the capability is absent, unfiltered listing falls back to saved records.
- Reconnect prefers `session/resume` when the adapter advertises `sessionCapabilities.resume`; otherwise it uses advertised `session/load`. `session/resume` resumes the session without returning previous messages.

#### Session cancel and controls

- `acpx <agent> cancel` sends `session/cancel` through the queue path and keeps the session alive for follow-up prompts.
- This is intentionally different from process-level SIGINT behavior, which can tear down the running process.
- `session/set_mode` and `session/set_config_option` are exposed as `set-mode` and `set` commands and return agent-side validation errors when invalid.
- Model config options are preferred; `session/set_model` remains available only when an adapter explicitly advertises legacy `models` metadata.

#### Filesystem client methods

- acpx handles `fs/read_text_file` and `fs/write_text_file` as client-authority operations.
- Permission behavior follows selected mode (`--approve-all`, `--approve-reads`, `--deny-all`).
- Path sandboxing is applied to keep file operations scoped to cwd by default.

#### Terminal client methods

- acpx handles full terminal lifecycle: create, output, wait_for_exit, kill, release.
- The implementation includes process tracking, output buffering, and cleanup behavior for terminal IDs.

#### Authentication

- acpx handles `authenticate` when adapters request it.
- This keeps compatibility with adapters that rely on ACP auth handshake rather than out-of-band environment setup.

## Not Yet Supported

| ACP Method         | What it does                        | Spec status |
| ------------------ | ----------------------------------- | ----------- |
| `session/fork`     | Branch a session into two           | unstable    |
| `$/cancel_request` | Cancel any pending JSON-RPC request | unstable    |

### Not Yet Supported Notes

- `session/fork`: would allow branching one conversation into parallel alternatives.
- `$/cancel_request`: transport-level JSON-RPC cancellation beyond session-scoped cancel.

## ACP-Adjacent Feature Status

Additional acpx features and remaining gaps:

- [ ] **Permission policies** — Tool-kind/title policies now exist through `--permission-policy`; path/argument rules (`allow reads to src/`, `deny writes to .env`) are still not supported.
- [ ] **Multi-agent orchestration** — Agent A prompts Agent B through acpx.
      Session bridging.
- [ ] **Webhooks / callbacks** — Notify a URL when a prompt finishes. For CI/CD
      and automation pipelines.
- [x] **Session export/import** — Move sessions between machines.
- [ ] **Watch mode** — Re-run prompt on file changes.
- [x] **Cost/token reporting** — Session checkpoints retain supported adapter-reported token usage and cost from usage updates. In `quiet` mode, final prompt-result usage and cost are printed to stderr when supplied by the adapter.
