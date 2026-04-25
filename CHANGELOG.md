# Changelog

Repo: https://github.com/openclaw/acpx

## Unreleased

### Changes

- Conformance/ACP: add a post-success drain case that catches late tool updates emitted after `session/prompt` resolves. (#252) Thanks @logofet85-ai.
- Conformance/ACP: add a data-driven ACP core v1 conformance suite with CI smoke coverage, nightly coverage, and a hardened runner that reports startup failures cleanly and scopes filesystem checks to the session cwd. (#130) Thanks @lynnzc.
- CLI/prompts: add `--prompt-retries` to retry transient prompt failures with exponential backoff while preserving strict JSON behavior and avoiding replay after prompt side effects. (#142) Thanks @lupuletic and @dutifulbob.
- Output: add `--suppress-reads` to mask raw file-read bodies in text and JSON output while keeping normal tool activity visible. (#136) Thanks @hayatosc.
- Agents/droid: add `factory-droid` and `factorydroid` aliases for the built-in Factory Droid adapter and sync the built-in docs. Thanks @vincentkoc.
- Agents/built-ins: bump the default pinned `@zed-industries/codex-acp` and `@agentclientprotocol/claude-agent-acp` package ranges to the latest published releases.
- Flows/workflows: add an initial `flow run` command, an `acpx/flows` runtime surface, and file-backed flow run state under `~/.acpx/flows/runs` for user-authored workflow modules. Thanks @osolmaz.
- Flows/workspaces: let `acp` nodes bind to an explicit per-step cwd, add a native isolated-workspace example, and default active flow steps to a 15 minute timeout unless overridden. Thanks @osolmaz.
- Flows/replay: store flow runs as trace bundles with `manifest.json`, `flow.json`, `trace.ndjson`, projections, bundled session replay data, and per-attempt ACP/action receipts for later inspection. Thanks @osolmaz.
- Flows/replay viewer: add a React Flow-based replay viewer example that replays saved run bundles and shows the bundled ACP session beside the graph. Thanks @osolmaz.
- Flows/replay viewer: keep recent runs and the active recent-run view live over a WebSocket snapshot/patch transport so in-progress runs update without manual refresh while rewind stays available.
- Flows/permissions: let flows declare explicit required permission modes, fail fast when a flow requires an explicit `--approve-all` grant, and preserve the granted mode through persistent ACP queue-owner paths. Thanks @osolmaz.
- Agents/qoder: add built-in Qoder CLI ACP support via `qoder -> qodercli --acp` and document Qoder-specific auth notes.
- Agents/qoder: forward `--allowed-tools` and `--max-turns` session options into Qoder CLI startup flags, including persisted session reuse, without requiring a raw `--agent` override.
- Runtime/embedding: add a supported `acpx/runtime` API for embedding ACPX session lifecycle, turn execution, status/control, and file-backed runtime storage. Thanks @osolmaz.

### Breaking

### Fixes

- Runtime/ACP: drain late post-success session updates before closing prompt turns so adapters that resolve `session/prompt` before final updates do not drop assistant output. (#251) Thanks @logofet85-ai.
- Sessions/reset: close the live backend session when discarding persistent state so reset flows start a fresh ACP session instead of silently reopening the old one.
- Agents/kiro: use `kiro-cli-chat acp` for the built-in Kiro adapter command to avoid orphan child processes. (#129) Thanks @vokako.
- Agents/cursor: recognize Cursor's `Session \"...\" not found` `session/load` error format so reconnects fall back to `session/new` instead of failing. (#162) Thanks @log-li.
- Output/thinking: preserve line breaks in text-mode `[thinking]` output instead of flattening multi-line thought chunks into one line. (#144) Thanks @Huarong.
- Sessions/load: fall back to a fresh ACP session when adapters reject `session/load` with JSON-RPC `-32601` or `-32602`, so persistent session reconnects do not crash on partial load support. (#174) Thanks @Bortlesboat.
- Flows/runtime: finalize interrupted `flow run` bundles as failed instead of leaving them stuck at `running` when the process receives `SIGHUP`, `SIGINT`, or `SIGTERM`.
- Client/auth: cache derived auth env key lists per auth method to avoid repeated allocations during credential lookup. (#167) Thanks @Yuan-ManX.

## 2026.3.12 (v0.3.0)

### Changes

- Agents/built-ins: add Factory Droid and iFlow as built-in ACP agents and document their built-in commands. (#112, #109) Thanks @ironerumi and @gandli.

### Breaking

### Fixes

- Codex/session config: treat `thought_level` as a compatibility alias for codex-acp `reasoning_effort` so `acpx codex set thought_level <value>` works on current codex-acp releases. Thanks @vincentkoc.
- Session control/errors: surface actionable `set-mode` and `set` error messages when adapters reject unsupported session control params, and preserve wrapped adapter metadata in those failures. (#123) Thanks @manthan787 and @vincentkoc.
- Sessions/load fallback: suppress recoverable `session/load` error payloads during first-run prompt recovery and keep the session record rotated to the fresh ACP session. (#122) Thanks @lynnzc and @vincentkoc.
- Permissions/stats: track client permission denials in permission stats. (#120) Thanks @lynnzc.
- Agents/gemini: default to `--acp` for Gemini CLI and fall back to `--experimental-acp` for pre-0.33 releases. (#113)
- ACP/prompt blocks: preserve structured ACP prompt blocks instead of flattening them during prompt handling to support images and non-text. (#103) Thanks @vincentkoc.
- Images/prompt validation: validate structured image prompt block MIME types and base64 payloads, emit human-readable CLI usage errors, and add an explicit non-CI live Cursor ACP smoke test path. Thanks @vincentkoc.
- Windows/process spawning: detect PATH-resolved batch wrappers such as `npx` on Windows and enable shell mode only for those commands. (#90) Thanks @lynnzc.

## 2026.3.10 (v0.1.16)

### Changes

- Tooling: align `acpx` tooling with the wider OpenClaw stack. (#43) Thanks @dutifulbob.
- Docs/contributors: sync contributor guidance with OpenClaw, add the vision doc, and refocus the agent contributor guide. (#68, #97) Thanks @onutc.
- ACP/set-mode: clarify that `set-mode` mode IDs are adapter-defined. (#27) Thanks @z-x-yang.
- Tests/coverage: expand CLI, adapter, and session-runtime coverage and keep the coverage lane on Node 22. (#69, #89) Thanks @vincentkoc and @frankekn.
- Agents/built-ins: add built-in agent support for Copilot, Cursor, Kimi CLI, Kiro CLI, kilocode, and qwen. (#72, #98, #56, #40, #62, #53) Thanks @vincentkoc, @osolmaz, @gandli, @vokako, and @kimptoc.
- Sessions/read: add a `sessions read` command. (#88) Thanks @frankekn.
- Config/exec: add a `disableExec` config option. (#91) Thanks @gandli.
- Claude/session options: add CLI passthrough flags for Claude session options. (#94) Thanks @frankekn.
- Sessions/resume: add `--resume-session` to attach to an existing agent session. (#95) Thanks @frankekn.
- ACP/config: pass `mcpServers` through ACP session setup. (#96) Thanks @frankekn.
- Docs/registry: sync the agent registry documentation with the live built-in registry. (#55) Thanks @gandli.
- Runtime/perf: improve runtime performance and queue coordination, tighten perf capture, reuse warm queue-owner ACP clients, and lazy-load CLI startup modules. (#73, #84, #87, #86) Thanks @vincentkoc.
- Repo/maintenance: add Dependabot configuration and pin ACP adapter package ranges. (#74, #99) Thanks @vincentkoc and @osolmaz.
- Docs/alpha: refresh code and adapter alpha docs. (#75) Thanks @vincentkoc.

### Breaking

### Fixes

- Queue/runtime: stabilize queue sockets and related runtime coordination paths. (#73) Thanks @vincentkoc.
- Gemini/ACP startup: harden Gemini ACP startup and reconnect handling, then fix follow-on session reconnect regressions. (#70, #93) Thanks @vincentkoc and @Takhoffman.
- Claude/ACP startup: harden Claude ACP session creation stalls. (#71) Thanks @vincentkoc.
- Windows/process spawning: use `cross-spawn` for Windows compatibility. (#57) Thanks @sawyer0x110.
- Release/CI: restore the CI release bump flow and keep release jobs on GitHub-hosted runners. (#100, #101) Thanks @osolmaz.

## 2026.3.1 (v0.1.15)

### Fixes

- CLI/version: restore `--version` behavior and staged adapter shutdown fallback. (#41) Thanks @dutifulbob.

## 2026.3.1 (v0.1.14)

### Changes

- ACP/session model: land the ACP session model work and define the ACP-only JSON stream contract. (#28, #34) Thanks @osolmaz and @dutifulbob.
- Queue/owner: make the queue owner self-spawn through the `acpx` CLI entrypoint. (#36) Thanks @dutifulbob.
- Metadata/release: restore OpenClaw package metadata for trusted publishing. (#39) Thanks @dutifulbob.
- Tests/queue owner: stabilize queue-owner integration teardown with additional tests. (#37) Thanks @dutifulbob.

### Breaking

### Fixes

- Gemini/session restore: recognize Gemini CLI `Invalid session identifier` failures as session-not-found reconnect cases. (#35) Thanks @louria.
- Sessions/output: suppress replayed `loadSession` updates from user-facing output. (#38) Thanks @dutifulbob.

## 2026.2.26 (v0.1.13)

### Fixes

- CLI/version env: ignore foreign `npm_package_version` values in `npx` contexts when resolving the CLI version. (#25) Thanks @dutifulbob.

## 2026.2.26 (v0.1.12)

### Changes

- CLI/version: add dynamic `--version` resolution at runtime. (#24) Thanks @dutifulbob.

## 2026.2.25 (v0.1.11)

### Changes

- Runtime/owners: detach warm session owners from prompt callers and run the `opencode` adapter in ACP mode. (#23) Thanks @dutifulbob.

## 2026.2.25 (v0.1.10)

### Fixes

- ACP/reconnect: fall back cleanly when a persisted ACP session is no longer found. (#22) Thanks @dutifulbob.

## 2026.2.25 (v0.1.9)

### Changes

- Docs/session identity: clarify the ACP session identity model and coverage status. (#21) Thanks @dutifulbob.

## 2026.2.24 (v0.1.8)

### Changes

- ACP/session identity: document runtime session ID passthrough from ACP metadata. (#18) Thanks @dutifulbob.
- Repo/metadata: align repository metadata with `openclaw/acpx`. (#19) Thanks @osolmaz.

## 2026.2.23 (v0.1.7)

### Changes

- Runtime/CLI: add the initial OpenClaw ACP integration runtime and CLI primitives. (#17) Thanks @dutifulbob.
- Docs/install: restore global install docs, badges, and `skillflag` setup guidance. (#14) Thanks @dutifulbob.

## 2026.2.20 (v0.1.6)

### Changes

- Docs/README: add the README banner, badges, and simplified setup guidance. (#12, #13) Thanks @dutifulbob.

## 2026.2.20 (v0.1.5)

### Changes

- Runtime/session UX: implement high-priority runtime, config, and session UX features. (#7) Thanks @dutifulbob.
- Tests/integration: add a mock ACP agent and integration tests. (#9) Thanks @dutifulbob.
- Docs/install: clarify `npx` usage and use `@latest` in install commands. (#5, #6) Thanks @dutifulbob.

### Breaking

### Fixes

- Prompt/cancel: cancel prompts cleanly during startup. (#10) Thanks @dutifulbob.

## 2026.2.18 (v0.1.4)

### Changes

- Sessions/routing: require explicit sessions and route prompts by directory walk. (#4) Thanks @dutifulbob.
- Docs/skills: add a quick-setup blurb for agent skill install. (#3) Thanks @dutifulbob.

## 2026.2.18 (v0.1.3)

### Changes

- CI/tests: align CI and test setup and expand coverage for the initial release line. (#1) Thanks @dutifulbob.

### Fixes

- Release/versioning: align release version bumping with the `skillflag` in-memory bump pattern. (#2) Thanks @dutifulbob.
