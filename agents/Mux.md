# Mux

- Built-in name: `mux`
- Default command: `npx -y mux@^0.27.0 acp`
- Upstream: https://mux.coder.com/integrations/acp

`acpx mux` starts coder/mux through its ACP stdio bridge (`mux acp`). `mux acp` auto-starts an in-process mux server, so a separate `mux server` is not required.

Configure at least one model provider before prompting (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`); see https://mux.coder.com/config/providers. When using direct provider keys, make sure mux route priority includes `direct` before providers you have not authenticated. To target a remote mux server, override the command with `mux acp --server-url <url> --auth-token <token>` (or set `MUX_SERVER_URL` / `MUX_SERVER_AUTH_TOKEN`).
