# Copilot

- Built-in name: `copilot`
- Default command: `copilot --acp --stdio`
- Upstream: https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line

`acpx copilot` requires a GitHub Copilot CLI release that supports ACP stdio mode. Older `copilot` binaries fail before ACP startup.

ACP support checks use the same working directory and child environment as the selected agent, including session environment and embedded runtime overrides. Setting a different child `PATH` therefore checks that Copilot installation.
