# Goose

- Built-in name: `goose`
- Default command: `goose acp`
- Upstream: [Goose](https://github.com/aaif-goose/goose)

Install the [Goose CLI](https://github.com/aaif-goose/goose) and configure its
model provider with `goose configure` before starting acpx. Goose owns provider
credentials and tool configuration. acpx uses the installed executable; it does
not download Goose or configure a provider.

```bash
acpx goose exec 'summarize this repo'
acpx goose sessions new --name review
acpx goose -s review 'review the latest changes'
```

The local `goose acp` process exchanges ACP messages over stdio. acpx handles
streaming updates, permission requests, and cancellation through the same
interfaces as other ACP agents. Model selection and session loading depend on
the capabilities advertised by the installed Goose version.

Goose's native tools run with the access configured in Goose; acpx's delegated
filesystem checks do not sandbox the native process. Configure its tools and
working directory for the intended task.

The separate `goose serve` HTTP/WebSocket interface is not used by this built-in
profile. See the [upstream ACP guide](https://github.com/aaif-goose/goose/blob/main/documentation/docs/gdk/acp/index.md).
