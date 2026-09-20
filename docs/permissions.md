---
title: Permissions
description: Permission modes, non-interactive policy, and how acpx handles ACP permission requests for tool calls and file writes.
---

ACP agents request permission for tool actions like writing files, running shell commands, or fetching URLs. `acpx` mediates those requests against a policy you choose at the command line (or in [config](config.md)).

## Modes

Choose exactly one. The flags are mutually exclusive — passing more than one is a usage error.

| Flag              | Behavior                                                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| `--approve-all`   | Auto-approve tool permission requests without prompting.                     |
| `--approve-reads` | Auto-approve read/search requests; prompt for everything else. **(default)** |
| `--deny-all`      | Auto-deny/reject every permission request whenever the protocol allows.      |

Set a project default in `.acpxrc.json` or a global default in `~/.acpx/config.json`:

```json
{ "defaultPermissions": "approve-all" }
```

CLI flags always win over config.

## Per-tool policy

Use `--permission-policy <json-or-file>` (or `--policy`) to override selected ACP tool permission requests without changing the broader mode:

```bash
acpx --permission-policy '{"autoApprove":["read","search"],"escalate":["execute"],"defaultAction":"deny"}' \
     --format json codex exec 'run the repo checks'
```

Policy keys:

- `autoApprove`: tool kinds, tool title heads, titles, or raw input tool names to approve
- `autoDeny`: matched tools to deny
- `escalate`: matched tools that require user or orchestrator approval
- `defaultAction`: optional fallback for unmatched requests: `approve`, `deny`, or `escalate`

Rule precedence is `autoDeny`, then `autoApprove`, then `escalate`, then `defaultAction`, then the normal permission mode. Matches are case-insensitive. In non-interactive output, an escalated request is denied for the current turn. Text mode prints a `[permission]` notice; JSON mode keeps the raw ACP stream and includes structured escalation details, including tool input when supplied by the agent, in the `session/request_permission` response `_meta.acpx.permissionEscalation` object so an orchestrator can resume with a broader policy.

Embedding clients that use `acpx/runtime` can apply the same policy through
`AcpRuntimeOptions.permissionPolicy`. For tool permissions, a host
`onPermissionRequest` callback gets the first chance to decide; returning no decision falls back to the configured
policy and permission mode. The embedded runtime does not currently expose
structured permission-escalation notifications to the host.

Pass `onPermissionRequest` to `startTurn()` or `runTurn()` to override the runtime
callback for one prompt. Each turn owns its handler, including when one runtime
serves concurrent sessions. Returning `undefined` or throwing falls back to the
configured policy and mode, without calling the runtime callback. Use
`permissionMode: "deny-all"` when missing host decisions must deny permission.
The callback's signal aborts when the turn finishes, times out, is cancelled,
or its connection closes. Pending permission requests then return cancellation;
a late host response cannot approve the action.

### Session-specific embedded policies

Use `AcpRuntimeOptions.sessionPermissions(context)` when one embedded runtime
serves sessions with different client permission policies. The context contains
the stored `sessionKey`, `cwd`, `agentCommand`, and optional `agentArgv`.
Return overrides for `permissionMode`, `nonInteractivePermissions`,
`permissionPolicy`, or `onPermissionRequest`; omitted fields inherit the runtime
defaults. Returning `undefined` uses all runtime defaults.

ACPX resolves this policy when creating or reconnecting a session client,
including control-only reconnections. A retained connection keeps its original
policy. Health probes do not call the resolver, and session records do not store
the resolved policy or callback. Shared CLI sessions do not support this option.

Turn callbacks keep the precedence and fallback behavior described above.
Approving an ACP tool request does not separately authorize `fs/*` or terminal
operations: those use the client's permission mode. An embedding host that
selects `approve-all` for delegated operations must still own its admission and
approval decisions; this is not a sandbox for the agent process.

## User questions

Some agents also encode fixed-choice user questions as permission requests.
When acpx recognizes such a question and cannot select an answer explicitly,
it cancels the request and fails the prompt with `PERMISSION_PROMPT_UNAVAILABLE`
(exit code `5`). This takes precedence over permission modes, per-tool policies,
and host permission callbacks, including for existing custom launchers. Continue
in a client that supports those questions. See the
[supported question behavior](https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md#user-questions).

## What counts as a "read"

Read/search requests in `--approve-reads`:

- Reading file contents (`fs/read_text_file` and read-shaped tool calls)
- Listing directories
- Search/grep tool calls
- Anything the adapter classifies as non-mutating

Everything else — write, edit, shell command, network call, etc. — falls into the prompt-or-deny path.

When the adapter omits the tool kind, acpx recognizes complete leading action words
such as `Read`, `cat`, or `grep`. A filename like `README.md` in a delete request,
or the letters `cat` inside `Truncate`, do not grant read approval. Unrecognized
titles follow the normal prompt-or-deny behavior.

## Interactive prompting

In an interactive TTY, `--approve-reads` shows:

```text
Allow <tool>? (y/N)
```

`y` approves the single request. `N` (default) denies it. The agent decides what to do with a denial — most adapters surface it as a tool error and let the model choose to retry, ask differently, or give up.

For the identified Codex ACP adapter, acpx prefers its offered one-time refusal that lets the turn continue. When cancellation is selected instead, a notice explains that it can end the turn; acpx never approves an operation to avoid cancellation. JSON consumers receive the notice in the permission response's `_meta.acpx.permissionNotice`; quiet output uses stderr and embedded runtimes emit a status event. See [Codex permission refusals](https://github.com/openclaw/acpx/blob/main/agents/Codex.md#permission-refusals).

There is no per-session "approve next 3" option. Every non-read request is its own prompt unless you pass `--approve-all`.

Interactive tool, file-write, and terminal questions share one input queue per acpx process. Only one question is shown at a time, and each requires its own answer. Closing stdin denies the current question and any waiting questions.

## Non-interactive policy

When there is no TTY (pipes, CI, queued prompts driven by another process), the prompt cannot be shown. `--non-interactive-permissions` decides what happens:

| Policy | Behavior                                                 |
| ------ | -------------------------------------------------------- |
| `deny` | Treat the un-promptable request as denied. **(default)** |
| `fail` | Fail the prompt with `PERMISSION_PROMPT_UNAVAILABLE`.    |

Set a project default if you want CI runs to fail loudly:

```json
{ "nonInteractivePermissions": "fail" }
```

## Exit code 5

If, by the end of a prompt, every permission request was denied or cancelled and none were approved, `acpx` exits with code `5` (`PERMISSION_DENIED`). This makes the "agent could not do anything because permissions were locked down" case detectable from a wrapping script.

If at least one request was approved (auto or explicit), exit code is whatever the prompt result indicates — typically `0` for success, `1` for an agent/runtime error.

## Sandboxing with `--cwd`

`--cwd <dir>` sets the working directory the agent operates in. ACP `fs/*`
methods resolve paths through an fs-safe root: ordinary files and contained
symlinks work, while symlinks outside cwd and special files such as FIFOs are
rejected. Writes preserve existing file modes and truncate through an admitted
descriptor; writes to hardlinked files are rejected to avoid modifying aliases.
Reads retain their existing size behavior.

These filesystem checks are best-effort guardrails within acpx's trusted-user
model, not an OS sandbox. They do not isolate a hostile same-user process or
confine arbitrary shell commands launched through terminal capabilities.

```bash
acpx --cwd ~/repos/api --approve-all codex 'fix everything you find'
```

## `--no-terminal`

Disables the ACP terminal capability for newly-spawned agent clients:

```bash
acpx --no-terminal codex exec 'summarize without spawning shell tools'
```

`acpx` advertises `clientCapabilities.terminal: false` during ACP `initialize`. Agents that respect the advertised capability will avoid terminal calls; agents that do not will get a hard error if they try.

`--no-fs` similarly disables ACP filesystem reads and writes. Disabled methods return a JSON-RPC method-not-found error even under `--approve-all`; they never reach the local filesystem or terminal handlers. Capabilities stay fixed for the lifetime of the connection. Changing these flags takes effect when a new agent client starts, after an existing warm owner expires or is explicitly closed.

This is a cleaner way to forbid shell access than blanket-denying every permission prompt, because the agent knows the capability is unavailable up front and can plan around it.

## Authentication

Permissions and auth are separate. ACP `authenticate` handshakes are configured through:

- `ACPX_AUTH_<METHOD_ID>` environment variables, e.g. `ACPX_AUTH_OPENAI_API_KEY=sk-…`
- Config `auth` map (see [Config](config.md#authentication))

Ambient provider env vars like `OPENAI_API_KEY` are still passed through to child agents, but they do **not** trigger ACP auth-method selection on their own. This avoids surprise login flows in adapters such as `codex-acp`.

## Permission flags in flows

Flow definitions can declare required permissions. If a flow needs `approve-all` and you run it without `--approve-all`, `acpx` fails fast before the flow starts and tells you which flag to pass.

```bash
# pr-triage example requires --approve-all
acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
```

See [Flows](flows.md#permissions) for how flow permission requirements work.

## Practical patterns

Read-only audit:

```bash
acpx --deny-all codex 'analyze this code without touching anything'
```

Trusted CI run:

```bash
acpx --approve-all --non-interactive-permissions fail \
     codex exec 'apply formatter and run lint'
```

Local exploration with the default safety net:

```bash
# Default --approve-reads, prompts in TTY for writes
acpx codex 'investigate why the build is slow'
```

## See also

- [CLI reference](CLI.md#permission-modes) — full table.
- [Config](config.md) — `defaultPermissions`, `nonInteractivePermissions`.
- [Sessions](sessions.md) — how `--cwd` becomes part of the scope key.
