# Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- Upstream: [mariozechner/pi](https://github.com/mariozechner/pi)
- Adapter: [svkozak/pi-acp](https://github.com/svkozak/pi-acp)
- ACPX owns the built-in package range so fresh launches use the repository-selected adapter line without depending on a globally installed adapter binary.
- When that range advances, sessions persisted under the superseded built-in command are mapped back to the current built-in launch argv on reuse, so older records do not keep launching the retired adapter line.

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
