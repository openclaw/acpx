# Devin

- Built-in name: `devin`
- Default command: `devin <model> acp` (requires `--model` flag before `acp`)
- Upstream: https://www.devin.ai

## ACP compatibility contract

Devin requires Windsurf-compatible client metadata during ACP initialization. `acpx` satisfies this by detecting Devin ACP launches and advertising a Windsurf identity with Cognition/Windsurf capability flags.

### Detection

`acpx` detects Devin ACP launches when the command matches `devin <model> acp` (e.g., `devin --model swe-1-6 acp`).

### Client identity

When Devin ACP is detected, `acpx` advertises:

- `clientInfo.name`: `windsurf` (instead of `acpx`)
- `clientInfo.version`: Controlled by `ACPX_DEVIN_WINDSURF_VERSION` env var (default: `1.110.1`)

### Capability flags

The following Cognition/Windsurf-specific capability flags are advertised under `clientCapabilities._meta`:

- `cognition.ai/groupedSessionConfigOptions`
- `cognition.ai/lazyEditorFiles`
- `cognition.ai/mcp`
- `cognition.ai/messageGrouping`
- `cognition.ai/multiRootWorkspace`
- `cognition.ai/partialContent`
- `cognition.ai/requestDiagnostics`
- `cognition.ai/revert`
- `cognition.ai/subagentSupport`
- `cognition.ai/toolCallQuestions`
- `cognition.ai/windsurfConfigBridge`
- `terminal_output`

### Extension handling

`acpx` handles Devin's vendor extension methods:

- `_cognition.ai/request_diagnostics`: Returns an empty object `{}` to satisfy the request
- Other vendor extension notifications: Silently ignored to prevent method-not-found noise

### Version override

Set `ACPX_DEVIN_WINDSURF_VERSION` to override the advertised Windsurf version:

```bash
ACPX_DEVIN_WINDSURF_VERSION=1.120.0 acpx devin --model swe-1-6 acp 'fix the bug'
```

### Scope

This compatibility shim is active only for Devin ACP launches. Other agents receive standard `acpx` identity and capabilities.

### Minimum required capability set

The current implementation advertises the full Windsurf capability set observed in the wild. If Devin's requirements change, the minimum set should be narrowed to only what Devin actually requires to reduce compatibility risk.
