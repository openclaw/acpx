---
title: Output formats
description: text, json, json-strict, and quiet modes — what each format emits, the JSON envelope, and how --suppress-reads affects payloads.
---

`acpx` streams agent activity in three output modes plus two modifiers. Pick the one that matches your consumer: a human terminal, an automation pipeline, or a script that only wants the final answer.

## `text` (default)

Human-readable stream:

- assistant text as it arrives
- `[thinking]` blocks for reasoning chunks
- `[tool] <title> (<status>)` blocks with output, diff previews, and plan updates
- `[done] <stopReason>` at the end

```bash
acpx codex 'review the auth module'
```

```text
[thinking] Reading src/auth and looking for token validation
[tool] Read src/auth/index.ts (completed)
[tool] Run grep -n 'verifyToken' src/auth (completed)
  output:
    src/auth/jwt.ts:42:export function verifyToken
The auth module is structured as …
[done] end_turn
```

`text` is best for interactive use. It is **not** stable for parsing — error messages, prompts, and progress updates can change between releases.

## `json`

NDJSON stream of raw ACP JSON-RPC messages on stdout:

```bash
acpx --format json codex exec 'review changed files' \
  | jq -r 'select(.method=="session/update")'
```

```json
{"jsonrpc":"2.0","id":"req-1","method":"session/prompt","params":{"sessionId":"019c…","prompt":"hi"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}
{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"}}
```

Hard rules for `json`:

- No acpx-specific event envelope wrapping ACP messages.
- No synthetic `type` / `stream` / `eventVersion` keys injected onto raw ACP traffic.
- No payload key renaming.

What you read on stdout is the same wire-level JSON that would have crossed the ACP transport, in submission order.

`compare` is the exception because it runs multiple one-shot sessions and emits a summarized `CompareRow[]` payload under `--format json` instead of interleaving raw ACP streams.

stderr can still contain prompts, progress, or warnings. If your script reads only stdout, that is fine. If you pipe both, see `--json-strict` below.

## `--format json --json-strict`

Strict JSON suppresses non-JSON output that would otherwise land on stderr:

```bash
acpx --format json --json-strict codex exec 'list TODO comments' > events.ndjson
```

`--json-strict` requires `--format json`. It guarantees:

- stdout is one ACP JSON-RPC message per line
- stderr stays quiet for non-error informational output

This is the right combination for "fully machine-consumed pipelines that should fail visibly on real errors."

## `quiet`

Final assistant text only — no tool blocks, no thinking, no `[done]`:

```bash
SUMMARY=$(acpx --format quiet codex exec 'one-line summary of this branch')
echo "$SUMMARY"
```

When the adapter includes final token usage and cost metadata in the prompt result, `acpx` emits that to **stderr** in `quiet` mode. stdout stays as the assistant text only.

If a quiet prompt fails, `acpx` exits non-zero and emits exactly one single-line diagnostic to stderr:

```text
[acpx] error: <CODE> [<DETAIL_CODE>] <message>
```

`DETAIL_CODE` is omitted when unavailable. Embedded line endings in the message are replaced with spaces. The diagnostic never goes to stdout; quiet stdout remains reserved for any assistant text the adapter produced. This stderr contract applies to direct and queued prompts; it does not change the `json` or `--json-strict` streams.

`quiet` is unaffected by `--suppress-reads` because it does not print tool call output to begin with.

## `--suppress-reads`

Replaces raw read-file payloads with a placeholder so logs stay readable when an agent reads a large file:

| Mode    | Effect of `--suppress-reads`                                                            |
| ------- | --------------------------------------------------------------------------------------- |
| `text`  | Read-like tool outputs render as `[read output suppressed]`.                            |
| `json`  | ACP `fs/read_text_file` responses and read-like tool-call outputs replace raw contents. |
| `quiet` | No effect (quiet mode prints assistant text only).                                      |

```bash
acpx --suppress-reads codex exec 'inspect repo and report tool usage'
```

The replacement preserves the surrounding ACP message shape so json consumers can still parse the stream — only the content payload is masked.

## Session-control command output

Session-control query commands emit summarized JSON shapes (not ACP wire traffic) under `--format json`:

| Command                 | `text`                             | `json`                                                                                                        | `quiet`                |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `sessions list`         | TSV: `id title cwd updatedAt meta` | `{ _meta, source, sessions, cursor, cwd, nextCursor }` for ACP list, or local records with `--local`/fallback | one id per line        |
| `sessions show`         | key/value lines                    | full session record object                                                                                    | record id              |
| `sessions history`      | TSV: `timestamp role textPreview`  | `{ entries: [...] }`                                                                                          | record id              |
| `sessions prune`        | summary + pruned ids and time      | `{ action, dryRun, count, bytesFreed, pruned }`                                                               | one pruned id per line |
| `sessions new`/`ensure` | record id                          | record + `acpxRecordId`/`acpxSessionId`/(`agentSessionId`)                                                    | record id              |
| `status`                | key/value lines                    | full status object                                                                                            | state token            |

Closed sessions are marked `[closed]` in `text` and `quiet`.

## Identity fields in JSON

Session-control JSON always includes:

| Field            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `acpxRecordId`   | Local record id (also what `text`/`quiet` print)                  |
| `acpxSessionId`  | Acpx-side session id                                              |
| `agentSessionId` | Provider-native id, **only present** when the adapter exposes one |

Do not assume the `acpxRecordId` can be passed to a native provider CLI. Use `agentSessionId` for that, when present.

## Picking a mode

| Use case                                  | Pick                                      |
| ----------------------------------------- | ----------------------------------------- |
| Interactive use, you are the reader       | `text` (default)                          |
| Save full transcript for later replay     | `json` (or `--format json --json-strict`) |
| Pipe into `jq` and parse events           | `--format json` or `--json-strict`        |
| Capture only the final answer in a script | `--format quiet`                          |
| Long agent runs that read large files     | add `--suppress-reads`                    |
| Anywhere stdout must be 100% JSON         | `--format json --json-strict`             |

## See also

- [Sessions](sessions.md) — what session-control commands return.
- [Permissions](permissions.md) — how denials surface in each format.
- [CLI reference](CLI.md#output-formats) — full per-mode behavior table.
