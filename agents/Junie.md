# Junie

- Built-in name: `junie`
- Default command: `junie --acp true`
- Upstream: [JetBrains Junie](https://www.jetbrains.com/junie/)

`acpx junie` launches the locally installed JetBrains Junie CLI in ACP stdio mode (`junie --acp true`). Junie must already be installed and authenticated; `acpx` never downloads or installs Junie for you. See the Junie CLI install and authentication docs for setup.

```bash
acpx junie exec "review the current changes"
acpx --cwd /path/to/project junie exec "analyze this project"
```

If `junie` is not installed or not on `PATH`, `acpx` fails with the standard `acpx` missing-command error. Install the Junie CLI from [JetBrains Junie](https://www.jetbrains.com/junie/) and authenticate before using it with `acpx`.
