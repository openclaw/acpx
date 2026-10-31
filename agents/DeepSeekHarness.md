# DeepSeek Harness

- Built-in name: `deepseek-harness`
- Default command: `dsh --profile acp`
- Upstream: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [CLI launcher](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md), [ACP contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)

This profile launches the DeepSeek Harness application over ACP stdio. It is
separate from DeepSeek's models: selecting a DeepSeek model in another agent
does not select this harness.

## Setup

Install the official `dsh` CLI and make it available on `PATH`. Configure provider
credentials in DeepSeek Harness, then set the ACP profile's provider route and
default model through its `@deepseek-ai/dsh-acp` configuration. Follow the
[upstream setup](https://github.com/deepseek-ai/deepseek-harness) and
[ACP configuration guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md#minimal-configuration).
Provider authentication belongs to dsh; acpx's ACP authentication settings do not
replace it. A successful ACP connection alone does not verify provider access.

```bash
acpx deepseek-harness exec 'summarize this repository'
acpx deepseek-harness sessions new
acpx deepseek-harness 'find the slowest test and explain why'
```

The launcher selects dsh's shipped `acp` profile under its Harness home
(`DSH_HOME` when set). Keep that home and its persisted sessions available across
restarts. `acpx --model <id> deepseek-harness …` selects an advertised ACP model
option; configure provider credentials and routes in dsh first.

## Session lifecycle

The official ACP server advertises `session/resume`, `session/list`, and
`session/close`. acpx prefers the advertised `session/resume` method when
reconnecting. dsh restores the persisted session for the model without replaying
earlier turns as `session/update` notifications. The official server does not
implement `session/load`; resume support does not imply transcript replay.

Resume requires an inactive persisted session and its matching workspace.
A saved acpx record alone does not prove that the installed dsh can reopen it.
See [Sessions](../docs/sessions.md) for acpx's owner lifetime and reconnect policy.

If `dsh` is installed outside `PATH`, replace the built-in argv in
`~/.acpx/config.json`:

```json
{
  "agents": {
    "deepseek-harness": {
      "argv": ["/absolute/path/to/dsh", "--profile", "acp"]
    }
  }
}
```
