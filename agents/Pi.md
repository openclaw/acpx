# Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- ACPX maintains the supported adapter package range in `src/agent-registry.ts`.
- Update ACPX to pick up changes to that range. The adapter starts through npm on demand.

Use `acpx pi sessions new` to create a persistent session, then send prompts with
`acpx pi 'your prompt'`. Use `acpx pi exec 'your prompt'` for a one-shot session.
