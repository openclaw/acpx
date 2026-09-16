# fx

- Built-in name: `fx`
- Default command: `fx acp`
- Upstream: [fx](https://fx.sh), [source](https://github.com/vercel-labs/fx)

Install fx and authenticate a provider first. fx owns its credentials and provider configuration; see its [setup guide](https://fx.sh/docs).

```bash
acpx fx exec 'summarize this repo'
acpx --model <id> fx exec 'summarize this repo'
```

`--model` uses the advertised ACP model config option. Select the provider with `fx provider <gateway|codex|grok>` before launching acpx. For launch settings, use a raw command such as `--agent 'fx acp --model <id>'`.

The process working directory is fx's primary workspace. Start a separate server for each workspace. Session controls use the server's advertised capabilities; see the [upstream ACP guide](https://fx.sh/docs/using-fx/acp).
