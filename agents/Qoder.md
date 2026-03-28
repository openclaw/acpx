# Qoder

- Built-in name: `qoder`
- Default command: `qodercli --acp`
- Upstream: https://docs.qoder.com/cli/acp

`acpx qoder` uses the same login state as Qoder CLI. For non-interactive runs, Qoder documents `QODER_PERSONAL_ACCESS_TOKEN` as the supported environment variable for authentication.

`acpx qoder` also forwards `--max-turns` and `--allowed-tools` into Qoder CLI startup flags when those session options are set. This makes those Qoder-native startup settings available without using a raw `--agent` override.
