# Changelog

Repo: https://github.com/openclaw/acpx

## Unreleased

### Changes

- Sync the agent-registry documentation with the live built-in registry, including the current `claude`, `gemini`, and `opencode` commands plus the newer `copilot`, `kiro`, `kilocode`, and `qwen` entries. Thanks @gandli.
- Upgrade `@agentclientprotocol/sdk` to v0.15.0 and align the CLI with the latest ACP client surface.
- Add built-in agent support for Copilot, Kiro CLI, and kilocode.
- Reuse warm queue-owner ACP clients across prompt turns to avoid repeated adapter startup and session reload overhead.
- Lazy-load CLI startup modules and fast-path `--version` to reduce one-shot command startup cost.
- Improve runtime performance and queue coordination.
- Expand direct ACP client, prompt runner, permission, session runtime, and adapter coverage, and enforce coverage in CI.
- Add Dependabot configuration.
- Sync contributor guidance with OpenClaw and add the project vision doc.
- Add the contributor-facing adapter ordering rule.
- Speed up CI, move releases to Blacksmith, and skip heavy jobs for docs-only changes.

### Breaking

### Fixes

- Stabilize queue sockets and add an `openclaw` alias.
- Harden Gemini ACP startup and reconnect handling, including `session/load` fallback paths.
- Harden Claude ACP session creation stalls.
- Use `cross-spawn` for Windows compatibility and fix ACP client stdio typing.

## 2026.3.1 (v0.1.14-v0.1.15)

### Changes

- Land the ACP session model work and define the ACP-only JSON stream contract.
- Make the queue owner self-spawn through the `acpx` CLI entrypoint.
- Restore OpenClaw package metadata for trusted publishing and tighten the alpha notice.
- Stabilize queue-owner integration teardown with additional tests.

### Breaking

### Fixes

- Recognize Gemini CLI `Invalid session identifier` failures as session-not-found reconnect cases.
- Suppress replayed `loadSession` updates from user-facing output.
- Restore `--version` behavior and staged adapter shutdown.

## 2026.2.26 (v0.1.10-v0.1.13)

### Changes

- Detach the warm session owner from the prompt caller and add owner heartbeat lease state and status tracking.
- Split queue IPC, owner runtime, and CLI internal paths to simplify the session runtime.
- Run the opencode adapter in ACP mode and resolve `--version` dynamically at runtime.

### Breaking

### Fixes

- Harden adapter shutdown during session ensure flows.
- Fall back cleanly when a persisted ACP session is no longer found.
- Ignore foreign npm package-version environment values when resolving the CLI version.

## 2026.2.25 (v0.1.8-v0.1.9)

### Changes

- Align repository metadata and docs with `openclaw/acpx`.
- Canonicalize ACP session identity around `agentSessionId`, including `_meta.sessionId` mapping and CLI output.

### Breaking

### Fixes

## 2026.2.23 (v0.1.4-v0.1.7)

### Changes

- Require explicit saved sessions and route session lookup by directory walk bounded to the git root.
- Add `sessions new`, soft-close behavior, queue-owner TTL support, and the bundled `acpx` skill integration.
- Implement graceful cancel, config, status, and session inspection features.
- Complete stable ACP spec coverage and harden the CLI/runtime for OpenClaw ACP integration.
- Add structured error normalization, typed queue errors, and `json-strict` output mode.

### Breaking

### Fixes

- Move global config storage to `~/.acpx/config.json`.
- Allow `exec` and `prompt` `--file` flags through commander option passthrough.
- Skip auth cleanly when the underlying agent handles it internally.
- Honor parent `-s` session flags on subcommands.
- Fix output-format precedence, queued error propagation, duplicate JSON error events, stderr leaks, and no-session error mapping in strict JSON flows.
- Preserve interactive prompts while using prompt-scoped SDK stderr suppression.

## 2026.2.18 (v0.1.1-v0.1.3)

### Changes

- Scaffold the project and ship the first end-to-end ACP CLI client.
- Establish the agent-first `prompt` / `exec` / `sessions` command design.
- Add per-session async prompt queueing plus initial built-in support for `opencode` and `pi`.
- Set up npm-first docs, MIT licensing, CI, release automation, and pre-commit hooks.

### Breaking

### Fixes

- Fix `loadSession` replay sequencing and stored session PID reconnect metadata.
- Improve text formatter output and silence adapter stderr noise.
- Fix test discovery and CI portability issues, including quoted glob handling.
- Resolve global-install symlink entrypoint checks and correct `--ttl` help text units.
- Stabilize early release publishing and `skillflag` integration details.
