# Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- ACPX maintains the supported adapter package range in `src/agent-registry.ts`.
- Update ACPX to pick up changes to that range. The adapter starts through npm on demand.

Use `acpx pi sessions new` to create a persistent session, then send prompts with
`acpx pi 'your prompt'`. Use `acpx pi exec 'your prompt'` for a one-shot session.

## Embedded inspection

Embedded inspection checks for the installed `pi-acp` adapter and the native `pi` command. The adapter package can also be resolved through the host’s package lookup. Both are required for the built-in installed launch. For a custom native launcher, configure pi-acp’s `PI_ACP_PI_COMMAND` and make the host’s executable lookup reflect that command.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
