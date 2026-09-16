# Junie

- Built-in name: `junie`
- Default command: `junie --acp=true`
- Upstream: [JetBrains Junie](https://junie.jetbrains.com), [ACP Registry entry](https://github.com/agentclientprotocol/registry/blob/main/junie/agent.json)

Install Junie and configure its authentication before starting sessions. Junie owns its JetBrains account, API-key, or BYOK setup; follow its [CLI reference](https://junie.jetbrains.com/docs/parameters.html).

```bash
acpx junie exec 'summarize this repo'
```

The built-in uses the registry's exact `--acp=true` argument. Session controls and model selection follow the capabilities advertised by Junie.

Configured agent commands and raw `--agent` overrides replace the built-in command completely. For example, `acpx --agent 'junie --acp=true --skip-update-check' exec 'summarize this repo'` supplies explicit launch settings. A raw `--agent 'junie'` stays literal; acpx does not add the ACP flag to an override.
