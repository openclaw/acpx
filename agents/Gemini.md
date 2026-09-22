# Gemini

- Built-in name: `gemini`
- Default command: `gemini --acp`
- Upstream: https://github.com/google/gemini-cli

Version checks and startup diagnostics use the same working directory and child environment as the selected agent, including session environment and embedded runtime overrides. Setting a different child `PATH` therefore checks that Gemini installation before choosing its ACP startup flag.

Embedding hosts receive lifecycle admission and events for each version check, diagnostic check, and ACP launch, with a distinct `launchId` per invocation. Denying an initial check prevents startup; denying a later diagnostic preserves the original startup error without version enrichment.
