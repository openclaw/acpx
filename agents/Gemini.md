# Gemini

- Built-in name: `gemini`
- Default command: `gemini --acp`
- Upstream: https://github.com/google/gemini-cli

Version checks and startup diagnostics use the same working directory and child environment as the selected agent, including session environment and embedded runtime overrides. Setting a different child `PATH` therefore checks that Gemini installation before choosing its ACP startup flag.
