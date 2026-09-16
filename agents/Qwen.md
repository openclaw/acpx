# Qwen

- Built-in name: `qwen`
- Default command: `qwen --acp`
- Upstream: https://github.com/QwenLM/qwen-code

## Filesystem delegation

By default, acpx advertises ACP `fs/read_text_file` and `fs/write_text_file`, so
Qwen delegates its file tools to the acpx filesystem proxy. Use `--no-fs` when
Qwen must use its native filesystem service instead, such as when it needs to
read or write files in its own runtime temporary directories:

```bash
acpx --no-fs qwen exec 'inspect the runtime artifact and summarize it'
```

The flag advertises both filesystem capabilities as `false` for the new ACP
client connection. It is independent of `--no-terminal`; combine both flags
when Qwen should use neither acpx filesystem nor terminal delegation.

## Embedded inspection

Embedded inspection resolves the installed `qwen --acp` entrypoint. Install Qwen Code before inspection, then configure authentication through Qwen before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
