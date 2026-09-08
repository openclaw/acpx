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

The host owns admission timeouts, cancellation and recovery. A callback that never
settles can hold startup indefinitely; `close()` is not an admission-cancellation
mechanism. Hosts should bound their own storage or policy operations and settle
or reject admission when abandoning a launch.

`onSpawnFailed` and `onExit` are best-effort observations. They are not awaited,
and their failures do not replace the process outcome. They do not guarantee that
an asynchronous host write is durable when an ACPX operation returns.

These hooks report ACPX-owned processes; they do not persist process leases,
reconcile a host restart, terminate arbitrary descendants, or guarantee cleanup
after abrupt owner death. Hosts retain responsibility for those policies.
