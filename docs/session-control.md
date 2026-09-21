---
title: Session control
description: cancel, set-mode, set, set model, and status — the verbs that adjust an in-flight or saved acpx session without restarting it.
---

These commands change live session state without restarting an adapter or losing history. They route through the queue owner when one is active, and reconnect directly otherwise.

A warm owner applies settings on its retained adapter even when no prompt is
running. During a prompt, controls can finish before the prompt ends. The owner
saves accepted mode, model, and configuration changes before acknowledging them;
prompt completion and close wait for admitted controls to finish their state
updates.

If a control times out after it may have reached the adapter, treat its result as
uncertain. acpx does not repeat the setting automatically. Accepted replies still
finish saving their state, and unfinished connections are retired before another
prompt uses that context. Race-free persistence requires updated callers and an
updated owner. Already running v0.17.1 owners and older callers retain caller-side
whole-record writes, which can race other controls or owner checkpoints. Use
updated clients and let an older owner expire while idle before resuming work.

## `cancel`

```bash
acpx codex cancel
acpx codex cancel -s backend
acpx cancel              # defaults to codex
```

Sends ACP `session/cancel` cooperatively:

- If a queue owner is running, the cancel is delivered through IPC.
- If a native prompt is active, acpx asks the adapter to cancel it; the adapter's reply determines the final stop reason.
- If nothing is running, `acpx` prints `nothing to cancel` and exits success.

This is the same semantics as `Ctrl+C` during a foreground turn, but available without a TTY signal — useful from scripts and other agents.

Accepted cancellation stops remaining queued-turn attempts during retry backoff
or before the next transport write. Cancellation during backoff records a
cancelled result without sending another prompt. Completed prompt responses and
non-retryable failures keep their actual outcomes, including responses received
before update draining finishes. Separately queued turns remain eligible to run.

## `set-mode`

```bash
acpx codex set-mode auto
acpx codex set-mode plan -s backend
acpx set-mode auto       # defaults to codex
```

Calls ACP `session/set_mode`. The set of valid `<mode>` values is **adapter-defined** and not standardized across ACP. Common values seen in the wild:

| Adapter  | Modes                                          |
| -------- | ---------------------------------------------- |
| `codex`  | adapter-defined (see codex-acp release notes)  |
| `claude` | adapter-defined; `plan` and `auto` are typical |
| Others   | check upstream agent docs                      |

Unsupported mode ids are rejected by the adapter, often as `Invalid params`. `acpx` surfaces that error code unchanged.

`set-mode` routes through the queue owner when active and falls back to a fresh client connection otherwise.

When reconnect permits a fresh session, an explicit mode change replaces the saved mode without replaying that previous mode first. This lets you replace a mode the adapter no longer supports. Other saved model and config selections still restore before the requested change. The new mode is saved only after the adapter accepts it; rejection keeps the prior mode preference. Persistent runtime sessions and imported records still require the original native session.

During prompt reconnect, model metadata received while restoring a saved mode takes effect before the saved model is restored. This includes changed model lists, renamed model controls, and removed model support. The final session metadata retains those changes even when no model selection needs replaying.

## `set <key> <value>`

```bash
acpx claude set verbosity terse
acpx set model gpt-5.4         # defaults to codex
```

Calls ACP `session/set_config_option` with the adapter's config key. Values for its advertised model control follow the model-selection rules below; other values are sent unchanged. Config selections are saved using the adapter's accepted values and restored after reconnect, before the next prompt. If a control changes another saved selection, such as reasoning effort after a model switch, ACPX saves the adjusted value or removes the selection when its control disappears. Unselected defaults are not pinned.

A config key named `mode` keeps config-option transport; `set-mode` uses the separate legacy mode control. Their saved preferences remain independent. Existing legacy-mode preferences are not reinterpreted as config selections.

After a genuine resume or load, ACPX restores the saved model first when the adapter advertises model controls, then replays saved configuration. An already loaded, reusable session needs no replay. A failed replay stops the operation with an error instead of silently continuing with defaults.

For applications using `acpx/runtime`, `AcpxRuntime.setConfigOption(...)` returns the native ACP response, including its complete `configOptions`, after saving the accepted state. Use that response to update displayed model and reasoning controls from the same operation, including changed or removed sibling options.

For model selection in an application, use `runtime.setModel({ handle, model })`. It uses the adapter's advertised model control and saves the selection for reconnect. When you need the accepted configuration response, use `setConfigOption` with the advertised model option's ID as `key`. Both methods validate the requested model against the connected session's catalog, including after reconnect. Read `runtime.getStatus({ handle })` for the current model and available IDs. Treat each model ID as opaque; pass exact advertised IDs, including IDs containing slashes, unchanged.

Unknown or ambiguous model selectors are rejected before sending the model change. In-process runtime callers can identify these failures with `isRequestedModelUnsupportedError(error)` and `error.reason === "unadvertised-model"`. When a Cursor alias matches multiple advertised variants, the error also has `ambiguous: true`; a selector with no advertised match omits that flag. Shared runtime callers receive the owner's queue error instead of the in-process error class. Claude ACP retains its forwarding exception: Claude Code accepts or rejects selectors absent from its advertised list. Cursor alone also accepts a bare model name when exactly one advertised bracketed variant matches; an exact advertised ID always wins. See [Cursor](https://github.com/openclaw/acpx/blob/main/agents/Cursor.md) for examples.

Embedded `setModel`, `setMode`, and `setConfigOption` calls also accept optional `signal` and `assertActive` fields. Supply a synchronous `assertActive` callback that throws when the host no longer permits the operation. Authority is checked after queue and storage waits and before the request is handed to the ACP SDK. Rejection preserves the original abort reason or callback error.

```typescript
await runtime.setModel({
  handle,
  model: selectedModel,
  signal: abortController.signal,
  assertActive,
});
```

These fields guard request admission. After SDK admission, the response and accepted state still settle even if the signal aborts or host authority changes. This keeps the saved selection consistent with the agent. Callers that omit the fields retain their existing behavior.

Within an embedded runtime, accepted controls save the current conversation and configuration together. Turn completion and one-shot cleanup wait for those controls to settle before saving final state or releasing the connection. A late control response therefore preserves final output and usage, and its accepted selection remains in the saved session for later turns and reconnect replay. Ordinary `close` still need not wait for the active prompt to finish cancellation; its closed/reset markers survive the prompt's later final save.

The same guard applies to each saved mode, model, and configuration control replayed during reconnect. Revocation stops later replay requests and preserves the original rejection. Replies already accepted by the agent remain saved, including any adjusted sibling selections.

### `set model <id>`

`set model <id>` is a special-case interception. `acpx` prefers an advertised model session config option and updates it through `session/set_config_option`. If an adapter explicitly advertises legacy `models` metadata instead, `acpx` preserves compatibility through `session/set_model`.

Current codex-acp releases advertise the base model and reasoning effort as separate config options.

```bash
acpx codex set model gpt-5.6-sol
acpx codex set reasoning_effort max
acpx claude set model claude-sonnet-4-6
```

For setting the model at session creation instead, use the `--model` global flag. See [Prompting](prompting.md#models).

## `status`

```bash
acpx codex status
acpx codex status -s backend
acpx status              # defaults to codex
```

Reports local queue-owner health for the cwd-scoped session. A healthy warm owner may be processing a prompt or waiting for more work during its idle TTL.

| Text/quiet state | JSON `status` | Meaning                                                                                              |
| ---------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `running`        | `alive`       | Queue owner is healthy and its socket is reachable; this does not establish that a prompt is active. |
| `idle`           | `idle`        | Saved session is resumable and no queue owner is present.                                            |
| `dead`           | `dead`        | A queue-owner lease remains but is unhealthy, or the recorded agent exit was abnormal.               |
| `no-session`     | `no-session`  | No saved record matches this scope.                                                                  |

When available, output also includes the queue-owner PID, model, mode, uptime, and last prompt time. Dead status can include the recorded exit code or signal. The JSON result is a status summary, not a full session record; `no-session` has no local session identity.

Status checks use local lease, process, and socket information and do not send an ACP request to the agent. Use session watch events to observe prompt progress or settlement; owner liveness alone is not a prompt-completion signal.

### Output

- `text`: key/value lines (default).
- `json`: a `status_snapshot` object using the JSON status values above.
- `quiet`: the text/quiet state token.

`idle` is meaningful: it means the persistent session is saved and resumable, but no queue owner is currently running. The next prompt will start an owner and reconnect.

## Routing rules

All four commands (`cancel`, `set-mode`, `set`, `status`) try the queue owner first when one exists for the target session. If no owner is running:

- `cancel` short-circuits with `nothing to cancel`.
- `set-mode` and `set` reconnect to the saved adapter session and apply the change directly.
- `status` simply reports `idle` or `dead`.

This means it is always safe to call these from scripts without worrying about whether a queue owner happens to be running.

## See also

- [Prompting](prompting.md) — `--no-wait` and timeouts.
- [Sessions](sessions.md) — scope rules and queue ownership.
- [CLI reference](CLI.md#cancel-command) — formal command grammar.

## Embedded agent discovery

Import `createAgentRegistry` from `acpx/agent-registry` to inspect agents without loading the runtime engine. The existing `acpx/runtime` export remains available.

`createAgentRegistry({ overrides })` supplies `inspect(agentId)` for checking installed launch entrypoints. A result contains the canonical `id`, display `name`, and either `launch: { kind: "installed", argv }` or `launch: { kind: "missing", requirements }`. Each missing requirement names a command or package. Inspection checks known entrypoints and prerequisites; it does not audit the behavior of arbitrary custom programs. Inspection performs filesystem lookup only; it does not start an agent, install packages, authenticate, or acquire a model catalog.

The optional `resolveExecutable(command)` and `resolvePackageRoot(packageName)` callbacks let an embedding host use its own executable and plugin-package lookup. Return an absolute path, or `undefined` when absent. Explicit overrides retain their precedence. Unknown agents and installer-style overrides that cannot be checked without package execution return `undefined`. Check again when acquiring the runtime; installation facts can change. Resolved argv can contain private configured arguments and belongs in trusted launch code.

The existing `list()` and `resolve()` methods retain their behavior, including configured and raw adapter commands. Custom registries implementing only those methods remain supported. `createAgentRegistry` returns the richer `AcpInspectableAgentRegistry` type.

Registry lookups use explicit entries only. Names such as `constructor` and `__proto__` remain raw commands unless configured; configured values also appear in `list()` and can be inspected normally.

After session acquisition, `getStatus({ handle }).models.availableModels` optionally supplies `{ modelId, name }` entries with native display names. `availableModelIds` remains available. IDs are opaque; pass the selected ID unchanged to `setModel`. Older session records without name metadata may omit `availableModels` until refreshed. A missing authenticated catalog remains a setup error even when its executable is installed. Ordinary `close` releases local inspection resources; optional remote discard and deletion of native history are separate operations.

Within one runtime, turns for the same session record run in submission order; different session records remain concurrent. Queued turns can be cancelled without interrupting their predecessor, and controls continue to reach the active turn.

`prepareFreshSession({ handle })` releases local session resources and records that the next `ensureSession` must create a fresh session, including after a runtime restart. Preparation cancels previously submitted turns for that record and waits for their finalization before recording the reset; local finalization or persistence failures reject preparation. Failed cleanup is retried before that owner can be replaced. Omit `resumeSessionId` on that ensure call. This operation does not require the optional remote `session/close` capability and does not delete native history. Ordinary `close` cancels active and queued turns while keeping the session resumable; the active turn may finish cancellation after close returns. Explicit `close({ handle, reason, discardPersistentState: true })` retains its remote-close requirement.
