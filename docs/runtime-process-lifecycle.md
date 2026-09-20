# Runtime process lifecycle

Embedding hosts can set `AcpRuntimeOptions.processLifecycle` to observe and admit
ACP agent launches. The option is absent by default. The callbacks receive a
unique `launchId`, immutable command/argument data, and a scope identifying a
runtime session or a runtime probe. Spawned and exit events also identify the
child PID and timestamps. Environment values are not included.

`onBeforeSpawn` and `onSpawned` are awaited admission boundaries. Rejecting before
spawn prevents launch. Rejecting after spawn terminates the child before startup
returns that error. An exit during admission is delivered after the admission
callback settles, so a late successful write cannot overwrite an earlier exit
observation.

For embedded runtime session creation, a positive `timeoutMs` bounds ACP
initialization. If the agent never completes the handshake, `ensureSession()`
rejects with `ACP_SESSION_INIT_FAILED` after closing the client and cleaning up
its observed processes. Cleanup can extend beyond the initialization deadline.
Omitting the timeout preserves unlimited initialization. This deadline does not
bound the later `session/new` or `session/load` request.

The host owns admission timeouts, cancellation and recovery. A callback that never
settles can hold startup indefinitely; `close()` is not an admission-cancellation
mechanism. Hosts should bound their own storage or policy operations and settle
or reject admission when abandoning a launch.

If a launch finishes admission after the client was closed, acpx stops that child
without adopting it or disturbing a replacement connection. The admitted child
still produces spawn and exit observations.

`onSpawnFailed` and `onExit` are best-effort observations. They are not awaited,
and their failures do not replace the process outcome. They do not guarantee that
an asynchronous host write is durable when an ACPX operation returns.

These hooks report ACPX-owned processes; they do not persist process leases,
reconcile a host restart, terminate arbitrary descendants, or guarantee cleanup
after abrupt owner death. Hosts retain responsibility for those policies.

On POSIX systems, acpx also performs cooperative descendant cleanup when a
bridge closes, fails initialization or admission, or exits after setup. It
captures descendants after initialization and session setup, and before ending
the bridge's stdin. Surviving processes receive `SIGTERM`, followed by `SIGKILL`
if needed. Cleanup rechecks each process's OS birth timestamp before signaling;
it never treats a saved PID alone as authority. Concurrent teardown paths share
the same cleanup operation, and late exits cannot overwrite a replacement
launch's status. The bridge retains its inherited process group and terminal
signal behavior.

Bridge and descendant teardown has an eight-second budget. POSIX queue-owner
recovery allows twelve seconds before forcibly stopping the owner, leaving room
for that cleanup and cancellation. These budgets exclude host admission callbacks
and separately managed terminals.

This is best-effort cleanup with OS timestamp precision and process-query races.
A descendant can escape observation if it starts after the last snapshot and
every witnessed ancestor exits before the next one. Unavailable OS process
information leaves unverified descendants untouched. Abrupt acpx death still
requires separate host supervision; Windows keeps its existing process cleanup.

## Inspect models without a runtime store

`inspectAgentModels()` from `acpx/runtime` launches an explicit `agentCommand`
argv in `cwd`, initializes ACP, creates a session, and returns normalized
`AcpRuntimeSessionModels`, or `undefined` when no model metadata is advertised.
It does not send a prompt, require a session store, or save an ACPX session record.
The agent may still create its own native session history.

Inspection denies permission requests and disables ACP filesystem and terminal
capabilities. Runtime health probes disable their ACP filesystem and terminal
callbacks while retaining the host permission policy; they ignore host
`fs`/`terminal` options. Disabling those ACP callbacks is a protocol callback
policy, not an OS sandbox for the agent's own filesystem or process access. Inspection inherits
the process environment, with an optional trusted `agentProcessEnv` overlay; it
does not isolate the agent process itself.

Pass an optional `signal` to cancel. `timeoutMs` is a positive discovery deadline
of at most 2,147,483,647 milliseconds and defaults to 120 seconds. Success,
failure, cancellation, and timeout all wait for owned client cleanup. Cleanup
can extend beyond the discovery deadline. A pre-aborted call does not launch
the agent.
