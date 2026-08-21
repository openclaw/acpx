# Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- Upstream: [mariozechner/pi](https://github.com/mariozechner/pi)
- Adapter: [svkozak/pi-acp](https://github.com/svkozak/pi-acp)
- ACPX owns the built-in package range so fresh launches use the repository-selected adapter line without depending on a globally installed adapter binary.
- When that range advances, a session persisted under the superseded built-in command is mapped back to the current built-in launch argv on reuse, but only when the record carries no usable stored `agent_argv`. A record with usable stored argv intentionally keeps that launcher.

`acpx pi` starts the Pi coding agent through the `pi-acp` ACP adapter. The adapter
drives an installed Pi CLI, so install and authenticate Pi first; the adapter README
states the minimum supported Pi version.

If the adapter needs a different resolution path or extra startup arguments, override
the built-in argv in `~/.acpx/config.json`:

```json
{
  "agents": {
    "pi": {
      "argv": ["npx", "pi-acp"]
    }
  }
}
```
