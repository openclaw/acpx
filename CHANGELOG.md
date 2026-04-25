# Changelog

<!-- markdownlint-disable MD024 -->

Repo: https://github.com/openclaw/acpx

## Unreleased

### Changes

- CLI/claude: add `--system-prompt <text>` and `--append-system-prompt <text>` global flags that forward through ACP `_meta.systemPrompt` on `session/new`, letting callers replace or append to the Claude Code system prompt without dropping out of persistent acpx sessions. The value is persisted in `session_options.system_prompt` so ensure/reuse flows keep the override. Codex and other agents ignore the field. (#229) Thanks @Vercantez.
- CLI/sessions: add `sessions prune` with `--dry-run`, age filters, and `--include-history` so closed session records and optional event streams can be cleaned up explicitly. (#227) Thanks @coder999999999.
- Runtime/embedding: add `startTurn(...)` turn handles so embedders can observe live runtime events separately from terminal completion, cancel a turn, or close only the event stream while preserving `runTurn(...)` compatibility. (#262) Thanks @enki.

### Breaking

### Fixes

- CLI/prompt: honor `--model` when sending prompts to existing persistent sessions, including queued owner paths. (#211) Thanks @skywills.
- Claude/built-in: bump the owned `@agentclientprotocol/claude-agent-acp` package range to `^0.31.0` so fresh built-in launches include the Opus 4.7 adapter update and later ACP compatibility fixes. (#253) Thanks @flowforgelab.

## 2026.4.25 (v0.6.0)

### Changes

- Conformance/ACP: add a post-success drain case that catches late tool updates emitted after `session/prompt` resolves. (#252) Thanks @logofet85-ai.
- Dependencies/CI: update ACP SDK, TypeScript-native tooling, formatter/lint tooling, and the pnpm setup action.

### Breaking

### Fixes

- Runtime/persistent sessions: keep reusable persistent ACP clients warm across turns and close pooled clients during runtime close. (#265) Thanks @Sway-Chan.
- Runtime/ACP: drain late post-success session updates before closing prompt turns so adapters that resolve `session/prompt` before final updates do not drop assistant output. (#251) Thanks @logofet85-ai.
- CLI/queue: tighten persistent queue and IPC socket directories to owner-only permissions, including previously-created permissive directories. (#216) Thanks @garagon.
- CLI/queue: use cryptographically random owner generation IDs so rapid queue owner restarts cannot reuse a stale generation token. (#207) Thanks @Yuan-ManX.
- Config/agents: honor custom agent `args` arrays from config instead of silently dropping required adapter subcommands. (#199) Thanks @log-li.
- Output/errors: add text-mode remediation hints for auth-required, missing-session, and common ACP session failures while keeping JSON error payloads stable. (#256) Thanks @SJeffZhang.
- Client/auth: require explicit `ACPX_AUTH_*` env vars or config `auth` entries for ACP auth-method selection, so ambient provider env like `OPENAI_API_KEY` no longer triggers unintended login flows in adapters such as `codex-acp`.
- Replay viewer: protect run-bundle file reads from run-id boundary escapes.

## 2026.4.8 (v0.5.3)

### Changes

- Dependencies: upgrade Vite to 8.0.7. (#231) Thanks @hxy91819.

### Breaking

### Fixes

## 2026.4.7 (v0.5.2)

### Changes

### Breaking

### Fixes

- Sessions/reset: close the live backend session when discarding persistent state so reset flows start a fresh ACP session instead of silently reopening the old one. (#228) Thanks @dutifulbob.

## 2026.4.6 (v0.5.1)

### Changes

### Breaking

### Fixes

- Runtime/processes: own built-in adapter launches so child processes are managed consistently. (#226) Thanks @dutifulbob.

## 2026.4.6 (v0.5.0)

### Changes

- Flows: validate flow definitions and require `defineFlow`. (#219) Thanks @osolmaz.
- Runtime/embedding: add a supported `acpx/runtime` API for embedding ACPX session lifecycle, turn execution, status/control, and file-backed runtime storage. (#220) Thanks @osolmaz.
- Runtime/prompt turns: stabilize runtime prompt turn handling. (#222) Thanks @osolmaz.

### Breaking

### Fixes

## 2026.4.4 (v0.4.1)

### Changes

- Flows/replay viewer: keep recent runs and the active recent-run view live over a WebSocket snapshot/patch transport so in-progress runs update without manual refresh while rewind stays available. (#205) Thanks @osolmaz.
- Agents/built-ins: bump the default pinned `@zed-industries/codex-acp` and `@agentclientprotocol/claude-agent-acp` package ranges. (#215) Thanks @osolmaz.
- Dependencies: update ACP SDK, TypeScript, and TypeScript-native dev tooling. (#200, #202, #203)

### Breaking

### Fixes

## 2026.3.29 (v0.4.0)

### Changes

- Flows/workflows: add an initial `flow run` command, an `acpx/flows` runtime surface, and file-backed flow run state under `~/.acpx/flows/runs` for user-authored workflow modules. (#179) Thanks @osolmaz.
- Flows/replay: store flow runs as trace bundles with `manifest.json`, `flow.json`, `trace.ndjson`, projections, bundled session replay data, and per-attempt ACP/action receipts for later inspection. (#181) Thanks @osolmaz.
- Flows/replay viewer: add a React Flow-based replay viewer example that replays saved run bundles and shows the bundled ACP session beside the graph. (#183) Thanks @osolmaz.
- Flows/permissions: let flows declare explicit required permission modes, fail fast when a flow requires an explicit `--approve-all` grant, and preserve the granted mode through persistent ACP queue-owner paths. (#186) Thanks @osolmaz.
- Flows/workspaces: let ACP validation choose PR test plans and broaden PR-triage refactor judgment. (#189, #190) Thanks @osolmaz.
- Flows/titles: add a flow run title API. (#197) Thanks @osolmaz.
- Agents/trae: add built-in Trae agent support backed by `trae-cli`. (#171) Thanks @hqwuzhaoyi.
- Agents/qoder: add built-in Qoder CLI ACP support via `qoder -> qodercli --acp` and document Qoder-specific auth notes. (#178) Thanks @xinyuan0801.
- Agents/codex: support `--model` for Codex sessions. (#192) Thanks @osolmaz.
- Models: add generic model selection via ACP `session/set_model`. (#150) Thanks @ironerumi.
- Output: add `--suppress-reads` to mask raw file-read bodies in text and JSON output while keeping normal tool activity visible. (#193) Thanks @osolmaz.
- CLI/prompts: add `--prompt-retries` to retry transient prompt failures with exponential backoff while preserving strict JSON behavior and avoiding replay after prompt side effects. (#196) Thanks @osolmaz.
- Docs/PR triage: add conflict gates and standard check validation guidance for maintenance PRs. (#180, #187) Thanks @osolmaz.
- Dependencies: update ACP SDK, workflow actions, TypeScript-native tooling, and development dependencies. (#131, #133, #146, #154, #177)

### Breaking

### Fixes

- Sessions/load: fall back to a fresh ACP session when adapters reject `session/load` with JSON-RPC `-32601` or `-32602`, so persistent session reconnects do not crash on partial load support. (#174) Thanks @Bortlesboat.
- Flows/runtime: finalize interrupted `flow run` bundles as failed instead of leaving them stuck at `running` when the process receives `SIGHUP`, `SIGINT`, or `SIGTERM`. (#188) Thanks @osolmaz.
- Windows/process spawning: enable shell mode for terminal spawn on Windows. (#173) Thanks @Bortlesboat.
- Client/startup: add connection timeout and max buffer size limits. (#168) Thanks @Yuan-ManX.
- Client/auth: cache derived auth env key lists per auth method to avoid repeated allocations during credential lookup. (#167) Thanks @Yuan-ManX.
- Output/thinking: preserve line breaks in text-mode `[thinking]` output instead of flattening multi-line thought chunks into one line. (#194) Thanks @osolmaz.
- Agents/cursor: recognize Cursor's `Session "..." not found` `session/load` error format so reconnects fall back to `session/new` instead of failing. (#195) Thanks @osolmaz.
- Agents/kiro: use `kiro-cli-chat acp` for the built-in Kiro adapter command to avoid orphan child processes. (#129) Thanks @vokako.

## 2026.3.18 (v0.3.1)

### Changes

- Conformance/ACP: add a data-driven ACP core v1 conformance suite with CI smoke coverage, nightly coverage, and a hardened runner that reports startup failures cleanly and scopes filesystem checks to the session cwd. (#130) Thanks @lynnzc.
- Agents/droid: add `factory-droid` and `factorydroid` aliases for the built-in Factory Droid adapter and sync the built-in docs. (#156) Thanks @vincentkoc.

### Breaking

### Fixes

## 2026.3.12 (v0.3.0)

### Changes

- Agents/built-ins: add Factory Droid and iFlow as built-in ACP agents and document their built-in commands. (#112, #109) Thanks @ironerumi and @gandli.
- Dependencies: update TypeScript-native and tsdown development tooling. (#106, #107, #118, #125, #126)

### Breaking

### Fixes

- Codex/session config: treat `thought_level` as a compatibility alias for codex-acp `reasoning_effort` so `acpx codex set thought_level <value>` works on current codex-acp releases. (#127) Thanks @vincentkoc.
- Session control/errors: surface actionable `set-mode` and `set` error messages when adapters reject unsupported session control params, and preserve wrapped adapter metadata in those failures. (#123) Thanks @manthan787.
- Sessions/load fallback: suppress recoverable `session/load` error payloads during first-run prompt recovery and keep the session record rotated to the fresh ACP session. (#122) Thanks @lynnzc.
- Permissions/stats: track client permission denials in permission stats. (#120) Thanks @lynnzc.
- Agents/gemini: default to `--acp` for Gemini CLI and fall back to `--experimental-acp` for pre-0.33 releases. (#113) Thanks @imWildCat.
- Images/prompt validation: validate structured image prompt block MIME types and base64 payloads, emit human-readable CLI usage errors, and add an explicit non-CI live Cursor ACP smoke test path. (#110) Thanks @vincentkoc.
- Windows/process spawning: detect PATH-resolved batch wrappers such as `npx` on Windows and enable shell mode only for those commands. (#102) Thanks @lynnzc.

## 2026.3.10 (v0.2.0)

### Changes

- Docs/changelog: add missing changelog entries, align the changelog with OpenClaw style, and clean up duplicate ACP and queue helpers. (#104, #105, #108) Thanks @vincentkoc.

### Breaking

### Fixes

- ACP/prompt blocks: preserve structured ACP prompt blocks instead of flattening them during prompt handling to support images and non-text. (#103) Thanks @vincentkoc.

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
- Dependencies: batch pending dependency upgrades. (#83) Thanks @vincentkoc.

### Breaking

### Fixes

- Queue/runtime: stabilize queue sockets and related runtime coordination paths. (#73) Thanks @vincentkoc.
- Gemini/ACP startup: harden Gemini ACP startup and reconnect handling, then fix follow-on session reconnect regressions. (#70, #93) Thanks @vincentkoc and @Takhoffman.
- Claude/ACP startup: harden Claude ACP session creation stalls. (#71) Thanks @vincentkoc.
- Windows/process spawning: use `cross-spawn` for Windows compatibility. (#57) Thanks @sawyer0x110.
- Release/CI: restore the CI release bump flow and keep release jobs on GitHub-hosted runners. (#100, #101) Thanks @osolmaz.

## 2026.3.1 (v0.1.15)

### Changes

### Breaking

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

### Changes

### Breaking

### Fixes

- CLI/version env: ignore foreign `npm_package_version` values in `npx` contexts when resolving the CLI version. (#25) Thanks @dutifulbob.

## 2026.2.26 (v0.1.12)

### Changes

- CLI/version: add dynamic `--version` resolution at runtime. (#24) Thanks @dutifulbob.

### Breaking

### Fixes

## 2026.2.25 (v0.1.11)

### Changes

- Runtime/owners: detach warm session owners from prompt callers and run the `opencode` adapter in ACP mode. (#23) Thanks @dutifulbob.

### Breaking

### Fixes

## 2026.2.25 (v0.1.10)

### Changes

### Breaking

### Fixes

- ACP/reconnect: fall back cleanly when a persisted ACP session is no longer found. (#22) Thanks @dutifulbob.

## 2026.2.25 (v0.1.9)

### Changes

- Docs/session identity: clarify the ACP session identity model and current coverage status. (#21) Thanks @dutifulbob.

### Breaking

### Fixes

## 2026.2.24 (v0.1.8)

### Changes

- Docs/runtime: specify runtime session id passthrough from ACP metadata. (#18) Thanks @dutifulbob.
- Metadata/repo: update repository metadata for `openclaw/acpx`. (#19) Thanks @osolmaz.

### Breaking

### Fixes

## 2026.2.23 (v0.1.7)

### Changes

- Docs/install: restore global install instructions, badges, and skillflag guidance. (#14) Thanks @dutifulbob.
- Runtime/OpenClaw: add OpenClaw ACP integration runtime and CLI primitives. (#17) Thanks @dutifulbob.

### Breaking

### Fixes

## 2026.2.20 (v0.1.6)

### Changes

- Docs/readme: add banner, badges, skillflag 0.1.4 guidance, and simplified setup. (#12, #13) Thanks @dutifulbob.

### Breaking

### Fixes

## 2026.2.20 (v0.1.5)

### Changes

- Docs/install: clarify `npx` usage and use `@latest` in install commands. (#5, #6) Thanks @dutifulbob.
- Runtime/session UX: implement high-priority runtime, config, and session UX features. (#7) Thanks @dutifulbob.
- Tests/integration: add mock ACP agent and integration tests. (#9) Thanks @dutifulbob.

### Breaking

### Fixes

- Startup/cancel: cancel prompts during startup correctly. (#10) Thanks @dutifulbob.

## 2026.2.18 (v0.1.4)

### Changes

- Docs/setup: add quick-setup guidance for agent skill install. (#3) Thanks @dutifulbob.
- Sessions/prompts: require explicit sessions and route prompts by directory walk. (#4) Thanks @dutifulbob.

### Breaking

### Fixes

## 2026.2.18 (v0.1.3)

### Changes

- CI/tests: align CI and test setup with SimpleDoc and expand coverage. (#1) Thanks @dutifulbob.

### Breaking

### Fixes

- Release: align release workflow with the skillflag in-memory bump pattern. (#2) Thanks @dutifulbob.

## 2026.2.18 (v0.1.2)

### Changes

- Initial public release of the ACP CLI client, including npm-first docs, agent-first prompt/exec/session commands, async prompt queueing, the initial agent registry, CI, trusted publishing, and MIT licensing.

### Breaking

### Fixes
