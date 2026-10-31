# Qwen Code

- Built-in name: `qwen`
- Default command: `qwen --acp`
- Upstream: https://github.com/QwenLM/qwen-code

This profile targets the Qwen Code CLI, not QwenWork.

## Filesystem delegation

By default, acpx advertises ACP `fs/read_text_file` and `fs/write_text_file`.
Qwen Code uses these callbacks for text reads and writes handled by its
filesystem service. File discovery (`findFiles`) remains native. Some reads
can also fall back to Qwen Code's native service for paths within its configured
local read roots after selected client path errors. The callbacks do not mediate
every filesystem operation.

Use `--no-fs` when Qwen Code should use its native text read/write service,
such as when a task needs to write files in its own runtime temporary directories:

```bash
acpx --no-fs qwen exec 'inspect the runtime artifact and summarize it'
```

The flag advertises both filesystem capabilities as `false` for the new ACP
client connection. It changes protocol delegation; it does not sandbox Qwen Code
or restrict its native filesystem access. `--no-terminal` separately disables
the ACP terminal capability.

## Embedded inspection

Embedded inspection resolves the installed `qwen --acp` entrypoint. Install Qwen Code before inspection, then configure authentication through Qwen before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
