# Devin

- Built-in name: none
- Raw command: `devin acp`
- Upstream: https://www.devin.ai

## ACP compatibility contract

Devin requires Windsurf-compatible client metadata during ACP initialization. `acpx` satisfies this by detecting Devin ACP launches and advertising a narrow Windsurf identity shim.

### Detection

`acpx` detects Devin ACP launches when the raw command starts with `devin` and includes `acp`, `--acp`, or `--experimental-acp`.

```bash
acpx --agent 'devin acp' exec 'summarize this repo'
```

Pass Devin global flags such as `--model <model>` before `acp` when needed:

```bash
acpx --agent 'devin --model swe-1-6 acp' exec 'summarize this repo'
```

### Client identity

When Devin ACP is detected, `acpx` advertises:

- `clientInfo.name`: `windsurf` (instead of `acpx`)
- `clientInfo.version`: Controlled by `ACPX_DEVIN_WINDSURF_VERSION` env var (default: `1.110.1`)

### Capabilities

Devin receives the same standard ACP client capabilities as other adapters:

- `fs.readTextFile`
- `fs.writeTextFile`
- `terminal` when terminal support is enabled

The only Devin-specific capability flag is `_meta["cognition.ai/requestDiagnostics"] = true`, because `acpx` handles that Devin extension request.

### Extension handling

`acpx` handles Devin's vendor extension traffic:

- `_cognition.ai/request_diagnostics`: Returns an empty object `{}` to satisfy the request
- Vendor extension notifications: Silently ignored to prevent method-not-found noise

### Version override

Set `ACPX_DEVIN_WINDSURF_VERSION` to override the advertised Windsurf version:

```bash
ACPX_DEVIN_WINDSURF_VERSION=1.120.0 acpx --agent 'devin acp' exec 'fix the bug'
```

### Scope

This compatibility shim is active only for Devin ACP launches. Other agents receive standard `acpx` identity and capabilities.

### Compatibility boundary

Do not add broad Windsurf/Cognition capability flags unless `acpx` implements the corresponding client operation or fresh Devin proof shows the flag is required for initialization.
