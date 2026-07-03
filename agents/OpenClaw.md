# OpenClaw

- Built-in name: `openclaw`
- Default command: `openclaw acp`
- Upstream: https://github.com/openclaw/openclaw
- `acpx --model <id> openclaw ...` and `acpx openclaw set model <id>` apply models through OpenClaw's advertised ACP model control. ACPX does not install providers, validate provider credentials, or make unavailable OpenClaw models selectable.

## Model selection

Use model ids that the connected OpenClaw ACP bridge advertises. For example, when an OpenClaw install exposes an xAI coding model such as `xai/grok-build-0.1`, select it at session creation or switch an existing session:

```bash
acpx --model xai/grok-build-0.1 openclaw exec 'review the failing build'
acpx openclaw set model xai/grok-build-0.1
```

If OpenClaw rejects the model id, inspect the OpenClaw provider/model configuration first. Treat it as an ACPX issue only when OpenClaw advertised the id and ACPX failed to forward it.

## Repo-local OpenClaw checkouts

For repo-local OpenClaw checkouts, override the built-in command in `~/.acpx/config.json` so `acpx openclaw ...` spawns the ACP bridge directly without the `pnpm` wrapper:

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node scripts/run-node.mjs acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```
