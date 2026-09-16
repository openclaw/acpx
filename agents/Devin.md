# Devin

- Built-in name: `devin`
- Default command: `devin acp`
- Upstream: [Devin CLI](https://docs.devin.ai/cli/index)

Install Devin CLI and complete its normal authentication flow first. The shortcut uses that installed CLI; acpx does not install Devin or manage its account.

```bash
acpx devin exec 'summarize this repo'
acpx --model <id> devin exec 'summarize this repo'
```

`--model` uses Devin's advertised ACP model config option. For Devin-specific launch flags, use the raw command override and put global flags before `acp`:

```bash
acpx --agent 'devin --model swe-2-high acp' exec 'summarize this repo'
```

## ACP compatibility contract

For a `devin` executable with `acp`, `--acp`, or `--experimental-acp`, acpx preserves a scoped Windsurf identity for compatibility with supported Devin versions:

- `clientInfo.name`: `windsurf`
- `clientInfo.version`: `ACPX_DEVIN_WINDSURF_VERSION`, defaulting to `1.110.1`
- Standard `fs.readTextFile`, `fs.writeTextFile`, and `terminal` capabilities according to their enabled settings
- Vendor capability `_meta["cognition.ai/requestDiagnostics"] = true`
- `_cognition.ai/request_diagnostics` responses: `{}`
- Vendor extension notifications are accepted without method-not-found errors

For example, `ACPX_DEVIN_WINDSURF_VERSION=1.120.0 acpx devin exec 'summarize this repo'` overrides the advertised version. Other agents retain standard acpx identity and capabilities.

Keep the compatibility scope narrow: additional Windsurf/Cognition capabilities need an implemented client operation or fresh Devin proof that initialization requires them.
