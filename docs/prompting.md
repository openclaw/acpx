---
title: Prompting
description: How acpx submits prompts — implicit vs explicit, persistent vs one-shot, stdin and --file input, queue submission with --no-wait, and timeouts.
---

`acpx` has one core operation: send a prompt to an ACP agent and stream the response. Everything else (sessions, queueing, cancel, mode) wraps that.

## Forms

The CLI accepts a prompt in five interchangeable ways:

```bash
# 1. Implicit, positional text. Defaults to codex when no agent is given.
acpx codex 'fix the failing tests'
acpx 'summarize this branch'

# 2. Explicit `prompt` subcommand.
acpx codex prompt 'fix the failing tests'
acpx prompt 'summarize this branch'

# 3. From stdin (piped).
echo 'review changed files' | acpx codex
git diff | acpx codex prompt

# 4. From a file.
acpx codex --file ./brief.md
acpx codex prompt -f ./brief.md

# 5. From stdin, with extra context appended.
git diff | acpx codex --file - 'and call out anything risky'
```

The `--file -` form is particularly handy for piping a long prompt from another tool while still tacking on a short instruction at the end.

## Persistent vs. one-shot

| Command  | Reuses saved session?  | Writes saved session? | Queue-aware? |
| -------- | ---------------------- | --------------------- | ------------ |
| `prompt` | Yes — resumes by scope | Updates history       | Yes          |
| (bare)   | Same as `prompt`       | Same as `prompt`      | Yes          |
| `exec`   | No — temporary session | No                    | No           |

`exec` is the right choice when:

- you want a stateless answer in a script (`SUMMARY=$(acpx --format quiet codex exec '…')`)
- you do not want to fork a session by accident
- you need machine-readable JSON output without later turns appended

`prompt` (or bare) is the right choice when:

- the conversation should remember earlier turns
- you want queue-aware submission with `--no-wait`
- you want `cancel` / `set-mode` / `set` to apply to the same session

## Implicit defaults

Top-level `acpx prompt …`, `acpx exec …`, `acpx cancel`, `acpx set-mode …`, `acpx set …`, and `acpx sessions …` all default to the `codex` agent. You can change the default for your environment by setting `defaultAgent` in [config](config.md):

```json
{ "defaultAgent": "claude" }
```

CLI flags still win, so `acpx codex …` always runs codex even if `defaultAgent` is `claude`.

## Prompt options

Available on `prompt`, the bare implicit form, and `exec`:

| Option          | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `-s, --session` | Use a named session within the current cwd scope                           |
| `--no-wait`     | Enqueue and return immediately if a prompt is already running              |
| `-f, --file`    | Read prompt text from a file (`-` reads stdin and still allows extra args) |

`--no-wait` is per-prompt; the next call without `--no-wait` will block normally.

## Queue submission

When a turn is already in flight for the target session, `acpx` does not spawn a second adapter. It submits to the running queue owner over local IPC. The submitter then either:

- **blocks** until the queued prompt completes (default), streaming events as they happen, or
- **returns** as soon as the owner acknowledges (`--no-wait`).

Queued prompts drain in submission order. After the queue empties, the owner stays alive for an idle TTL (`--ttl <seconds>`, default `300`).

```bash
# Long-running turn
acpx codex 'run the full test suite and triage failures'

# Queue follow-ups without waiting
acpx codex --no-wait 'after that, summarize root cause in 3 bullets'
acpx codex --no-wait 'and propose 1 minimal fix'
```

`Ctrl+C` while waiting on a queued or running prompt sends ACP `session/cancel` first, waits briefly for the cancelled completion, and falls back to a force-kill only if the agent does not respond. See [Session control](session-control.md) for the explicit `cancel` command.

## Timeouts

`--timeout <seconds>` caps how long `acpx` will wait for an agent response. It applies to:

- the active prompt turn
- the per-step default for [flows](flows.md) `acp` and `action` nodes (15 minutes when `--timeout` is omitted)

```bash
acpx --timeout 90 codex 'investigate the intermittent test timeout'
```

Decimal seconds are allowed. Negative or zero is rejected as a usage error.

If the timeout fires, `acpx` exits with code `3` and the agent process is cancelled cooperatively first.

## Models

`--model <id>` requests a specific model:

```bash
acpx --model claude-sonnet-4-6 claude 'do the thing'
acpx --model gpt-5.4 codex exec 'one-shot summary'
```

Behavior varies by adapter:

- **Claude** consumes the value as session-creation metadata.
- Other agents must advertise ACP models and support `session/set_model`. If they do not, `acpx` fails clearly instead of silently falling back to the adapter's default.
- Model ids must appear in the adapter's advertised `availableModels`. Unknown ids are rejected.

For mid-session model switches, use `set model <id>` instead. See [Session control](session-control.md#set-key-value).

## Permissions inside a prompt

Prompts can trigger permission requests for tool calls. The default policy auto-approves reads and prompts for writes; non-interactive runs default to deny. See [Permissions](permissions.md).

```bash
acpx --approve-all codex 'apply the patch and run tests'
acpx --deny-all    codex 'analyze without using any tools'
```

## Reading prompt text

Whichever way you supply prompt text, `acpx` concatenates the file (or stdin) with positional args, separated by a blank line. That is what makes `--file -` plus appended args work.

If neither stdin is piped nor `--file` is provided and there are no positional args, `acpx` prints help and exits.

## Examples

```bash
# Implicit, codex default
acpx 'review the latest commit'

# Explicit agent and explicit verb
acpx claude prompt 'refactor src/auth into clearer modules'

# Stdin + appended ask
git log --oneline -n 20 | acpx codex --file - 'pick the 3 most important changes'

# One-shot JSON for automation
acpx --format json codex exec 'list TODO comments by file' \
  | jq -r 'select(.method=="session/update")'

# Named session + fire-and-forget follow-up
acpx codex sessions new --name release
acpx codex -s release 'collect changes since v0.6.0'
acpx codex -s release --no-wait 'then draft release notes'
```

## See also

- [Sessions](sessions.md) — scope rules, queueing, and crash recovery in depth.
- [Session control](session-control.md) — `cancel`, `set-mode`, `set`.
- [Output formats](output-formats.md) — what gets emitted per format and `--suppress-reads`.
- [CLI reference](CLI.md#prompt-subcommand-explicit) — formal grammar.
