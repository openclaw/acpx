# Transient runtime environment

Embedded clients can set `AcpRuntimeOptions.agentProcessEnv` to a map of strings
for the agent children owned by that runtime. ACPX snapshots the map when
`createAcpRuntime()` is called. Later mutations of the caller's map do not affect
that runtime. The same overlay applies to probes, new sessions, controls and
reconnections, including sessions loaded from an existing store.

Precedence is protected authentication values, then `agentProcessEnv`, then
persisted `sessionOptions.env`, then the inherited process environment. Windows
uses the same case-insensitive collision handling as session environment values.
The overlay does not change the parent process environment.

Per-session `SessionAgentOptions.env` is saved for reconnects. Its own string
keys and values are preserved exactly, including names such as `__proto__`.

This is trusted embedding-host configuration: executable, loader and other
process settings can change what the child runs. ACPX does not sanitize arbitrary
environment variables. Existing credential protection remains in effect.
Invalid environment entries are rejected without echoing their values.

## Limiting inherited variables

By default, agent children, command probes and ACP terminals inherit the whole
parent environment. Two opt-in lists narrow that inheritance. Both are off by
default; with neither set, the child environment is exactly what it was before
these options existed.

- `AcpRuntimeOptions.agentProcessEnvBlock` lists parent names children do not
  inherit, for example a host's own service token.
- `AcpRuntimeOptions.agentProcessEnvAllow` switches to an allowlist: children
  inherit only process essentials plus the listed parent names. An empty list
  keeps only the essentials and explicit grants.

The essentials keep processes able to start and find their tools: `PATH`,
`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TZ`, `TMPDIR`, `TMP`,
`TEMP`, and every `LC_*` and `XDG_*` name. On Windows they also include
`SystemRoot`, `windir`, `SystemDrive`, `ComSpec`, `PATHEXT`, `USERPROFILE`,
`HOMEDRIVE`, `HOMEPATH`, `USERNAME`, `USERDOMAIN`, `APPDATA`, `LOCALAPPDATA`,
`ProgramData`, `ALLUSERSPROFILE`, and the `ProgramFiles` and
`CommonProgramFiles` directories.

ACPX applies the allowlist first, then removes blocked names from the result, so
a name on both lists is not inherited. Explicit grants apply last and always
win: `ACPX_AUTH_<NAME>` variables pass through both lists, and protected
authentication values, `agentProcessEnv`, persisted `sessionOptions.env` and a
terminal request's own `env` still apply. When ACPX picks an environment
credential for ACP authentication, it skips agent-specific variables such as
Grok Build's `XAI_API_KEY` that children would not inherit, even when the host
environment has them. To keep such a credential, list it in the allowlist and
leave it off the blocklist, or pass it as an `ACPX_AUTH_<METHOD_ID>` grant such
as `ACPX_AUTH_XAI_API_KEY`. Provider keys that an agent reads from its own
environment follow the same lists: allow them by name or supply them through
`agentProcessEnv`.

ACPX snapshots both lists at construction and rejects a list that is not an
array of non-empty names without `=` or NUL. Windows matches names
case-insensitively. The parent process environment is not changed.

## Persistence

ACPX does not copy the overlay into session records, events, status or diagnostics.
An adapter can still echo its own environment into output; this option cannot
prevent that. A new runtime must supply its own overlay, and a previously saved
session environment retains its existing persistence behavior.

## Example

```ts
const runtime = createAcpRuntime({
  cwd,
  sessionStore,
  agentRegistry,
  permissionMode: "approve-reads",
  agentProcessEnv: { ADAPTER_EXECUTABLE: "/opt/agent/bin/agent" },
  agentProcessEnvBlock: ["HOST_SERVICE_TOKEN"],
});
```

An allowlist instead of a blocklist:

```ts
const runtime = createAcpRuntime({
  cwd,
  sessionStore,
  agentRegistry,
  permissionMode: "approve-reads",
  agentProcessEnvAllow: ["ANTHROPIC_API_KEY", "NODE_EXTRA_CA_CERTS"],
});
```
