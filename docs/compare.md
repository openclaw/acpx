# Compare Command

`acpx compare` runs the same one-shot prompt across multiple ACP-compatible
agents and summarizes the results side by side.

```bash
acpx compare pi openclaw codex 'summarize this checkout'
```

Each agent runs independently through the same temporary-session path as
`acpx <agent> exec`. Runs execute serially in the requested workspace so
write-capable prompts cannot mutate the same checkout concurrently.

## Usage

```bash
acpx compare <agent>... '<prompt>'
acpx compare <agent>... -- prompt words after the delimiter
acpx compare <agent>... --file ./prompt.md
acpx compare <agent>... -f ./prompt.md
acpx compare pi openclaw --file ./prompt.md -- 'Focus on cancellation behavior'
```

The final positional argument is treated as the prompt unless `--file` is
provided. When you use `--`, every token after the delimiter is joined into the
prompt.

With a prompt file, delimiter text is appended to the file's prompt blocks.
An empty delimiter preserves every preceding agent and reads the prompt from
the file or stdin.

## Options

`compare` honors the same global execution controls as `exec`, including:

| Option                                                                                   | Description                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--cwd <dir>`                                                                            | Target workspace. Defaults to the current working directory.                                                                |
| `--approve-all` / `--approve-reads` / `--deny-all`                                       | Permission mode.                                                                                                            |
| `--permission-policy <json-or-file>` / `--policy`                                        | Per-tool permission policy.                                                                                                 |
| `--timeout <sec>`                                                                        | Per-agent timeout in seconds.                                                                                               |
| `--non-interactive-permissions <policy>`                                                 | Non-TTY prompt behavior.                                                                                                    |
| `--auth-policy <policy>`                                                                 | ACP authentication behavior.                                                                                                |
| `--no-fs`                                                                                | Do not advertise filesystem support to agents.                                                                              |
| `--no-terminal`                                                                          | Do not advertise terminal support to agents.                                                                                |
| `--prompt-retries <count>`                                                               | Retry failed prompt turns before any side effects are observed.                                                             |
| `--model`, `--allowed-tools`, `--max-turns`, `--system-prompt`, `--append-system-prompt` | Session creation options forwarded to compatible agents.                                                                    |
| `--skills-dir`, `--additional-dir`                                                       | Extra workspace roots and skill folders via ACP `additionalDirectories`; requires the agent capability at session creation. |
| `--mcp-config <path>`                                                                    | External MCP config file for the invocation.                                                                                |
| `--format <text\|json\|quiet>`                                                           | Summary output format.                                                                                                      |

Command-local options:

| Option                 | Description                   |
| ---------------------- | ----------------------------- |
| `--json`               | Alias for `--format json`.    |
| `-f, --file <path>`    | Read prompt text from a file. |
| `--prompt-file <path>` | Alias for `--file`.           |

`--cwd` may appear before or after `compare`. An explicit command-local value
takes precedence over the top-level value. That workspace supplies the project
configuration, agent definitions and permission defaults, and anchors relative
prompt files, permission-policy files and top-level MCP configuration paths.

## Interruption

SIGINT, SIGTERM and SIGHUP during execution cancel the active run and wait for
its cleanup. Remaining agents are skipped, the summary contains only attempted
runs, and acpx exits with code `130`. Ordinary agent errors and per-agent
timeouts remain individual results and allow subsequent agents to run.

## Output

Text output includes one row per agent:

| Column          | Meaning                                                      |
| --------------- | ------------------------------------------------------------ |
| `agent`         | Agent name or raw command token.                             |
| `status`        | `ok`, `cancelled`, `permission_denied`, or `error`.          |
| `wall_ms`       | Wall-clock runtime in milliseconds.                          |
| `input`         | Input token count from the latest `usage_update`.            |
| `output`        | Output token count from the latest `usage_update`.           |
| `total`         | Total token count from the latest `usage_update`.            |
| `permissions`   | Denied-or-cancelled permission requests over total requests. |
| `stop_reason`   | ACP `session/prompt` stop reason, such as `end_turn`.        |
| `final_message` | First 200 characters of assistant text output.               |
| `error`         | Error preview for failed runs.                               |

`--format json` emits an array of rows:

```json
[
  {
    "agent": "codex",
    "status": "ok",
    "stop_reason": "end_turn",
    "wall_ms": 1240,
    "input_tokens": 1200,
    "output_tokens": 340,
    "total_tokens": 1540,
    "final_message": "The failing test is caused by...",
    "error": null,
    "permission_requests": 0,
    "permission_denied": 0
  }
]
```

`--format quiet` prints one tab-separated `<agent>\t<status>` row per agent.
