# Octomind

- Built-in name: `octomind`
- Default command: `octomind acp developer:general`
- Upstream: [Octomind](https://octomind.run), [source](https://github.com/muvon/octomind)

Install Octomind and give it model access first. `octomind login` signs in to Octomind Cloud; alternatively set a provider key (for example `OPENROUTER_API_KEY`) and choose that provider's model in Octomind's `config.toml`. Without either, sessions still open and slash commands still run, but the first prompt that would reach the hosted gateway fails: `session/prompt` returns `auth_required`, and the advertised `octomind-login` auth method runs the browser sign-in.

```bash
curl -fsSL https://raw.githubusercontent.com/muvon/octomind/master/install.sh | bash
octomind login
acpx octomind exec 'summarize this repo'
```

`developer:general` is the coding specialist from Octomind's default tap. The first launch fetches the tap and installs its tool dependencies, so it is slower than later launches. Octomind does not advertise an ACP model selector; to pick another specialist or pin a model, use a raw command such as `--agent 'octomind acp <tag> --model <provider:model>'`.

Octomind advertises `session/load`, so saved `acpx octomind` sessions resume with their context.
