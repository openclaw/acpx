# Ante

- Built-in name: `ante` (experimental)
- Default command: `ante acp`
- Upstream: [Ante](https://github.com/AntigmaLabs/ante), [ACP contract](https://github.com/AntigmaLabs/ante/blob/daa3e25e2ed328a2a693ff22e82dfefd6a585de8/ante-acp/README.md)

Install Ante 0.2.1 or newer and the separate `ante-acp` adapter on `PATH`.
Configure your provider and credentials in Ante before launching acpx.
`ante acp` dispatches to `ante-acp`, which drives an `ante serve --stdio`
child for each ACP session. The adapter checks the Ante version during
`initialize`; keep that check enabled. See the upstream ACP contract for
adapter build and installation instructions.

Start with an independent one-shot prompt:

```bash
acpx ante exec 'summarize this repository'
```

## Experimental scope

The upstream adapter is a work in progress. Use fresh sessions; conversation
context lasts only while the ACP connection remains alive. Reopening a session
is unsupported. An acpx session record does not make the Ante conversation
resumable after the agent or queue owner exits or restarts. Prefer `exec` for
independent work rather than relying on cross-invocation persistence.

The adapter exposes permission requests, session modes, and cancellation, but
leaves Ante's AskUser tool out of ACP sessions. The model proceeds without
asking the user to choose. MCP servers and additional directories supplied by
the client are ignored; do not rely on those fields to configure Ante.

This profile records the upstream launch contract. Compatibility with an
installed Ante/ante-acp pair has not yet been qualified.
