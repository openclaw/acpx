# Compare Command

`acpx compare` runs the same one-shot prompt across multiple ACP-compatible agents and summarizes the results side by side.

```bash
acpx compare pi codex claude 'fix the failing test in checkout.spec.ts'
```

Each agent runs independently. By default, compare uses `deny-all` permissions, which is best for review, planning, and read-only evaluation prompts.

## Usage

```bash
acpx compare <agent>... '<prompt>'
acpx compare <agent>... -- prompt words after the delimiter
acpx compare <agent>... --prompt-file ./prompt.md
acpx compare <agent>... -f ./prompt.md
```

The final positional argument is treated as the prompt unless `--prompt-file` is provided. When you use `--`, every token after the delimiter is joined into the prompt.

## Options

| Option                     | Description                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| `--cwd <dir>`              | Target workspace. Defaults to the current working directory.                  |
| `--deny-all`               | Deny all permission requests. This is the default compare permission mode.    |
| `--approve-reads`          | Auto-approve read/search requests and prompt for writes.                      |
| `--approve-all`            | Auto-approve all permission requests.                                         |
| `--timeout <sec>`          | Per-agent timeout in seconds. Defaults to `300`. Decimal seconds are allowed. |
| `--json`                   | Emit the full `CompareRow[]` payload instead of the text table.               |
| `--diff`                   | Run each agent in an isolated git worktree and include diff summaries.        |
| `-f, --prompt-file <path>` | Read prompt text from a file. Use `-` for stdin.                              |

## Table Output

Text output includes one row per agent:

| Column          | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `agent`         | Agent name or raw command token.                           |
| `status`        | `ok`, `cancelled`, or `error`.                             |
| `wall_ms`       | Wall-clock runtime in milliseconds.                        |
| `input`         | Input token count from the latest `usage_update`, if any.  |
| `output`        | Output token count from the latest `usage_update`, if any. |
| `context`       | Context usage from `usage_update.size` or `used`, if any.  |
| `stop_reason`   | ACP `session/prompt` stop reason, such as `end_turn`.      |
| `final_message` | First 200 characters of assistant text output.             |
| `transcript`    | NDJSON transcript path.                                    |
| `diff`          | Diff summary when `--diff` is set.                         |
| `error`         | Error preview for failed or timed-out runs.                |

Transcripts are persisted under:

```text
~/.acpx/compare/<run-id>/<agent>.ndjson
```

## JSON Output

`--json` emits an array of rows:

```json
[
  {
    "agent": "codex",
    "status": "ok",
    "stop_reason": "end_turn",
    "wall_ms": 1240,
    "input_tokens": 1200,
    "output_tokens": 340,
    "context_used": 1540,
    "final_message": "The failing test is caused by...",
    "transcript_path": "/Users/me/.acpx/compare/2026-05-16T12-00-00-000Z-a1b2c3/codex.ndjson",
    "error": null,
    "diff_stat": null,
    "diff_path": null
  }
]
```

## Diff Mode

When `--diff` is set, each agent runs in a separate detached git worktree created from the current repository `HEAD`. After the run completes, acpx writes the full diff to the compare transcript directory and includes `git diff --stat` in the table.

```bash
acpx compare codex claude --approve-all --diff 'implement the smallest fix'
```

Use diff mode for write-capable comparisons. Without `--diff`, all agents run in the same `--cwd`, which is appropriate for `deny-all` review-style prompts.
