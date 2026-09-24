---
title: Shared sessions
description: Share one local ACP session owner between an application and acpx CLI processes.
---

# Shared sessions

`createSharedAcpRuntime()` connects applications to the same local session store and queue owners used by the CLI. An application and a terminal can submit prompts to one named conversation without starting competing adapter connections.

```ts
import { createSharedAcpRuntime } from "acpx/runtime";

const runtime = createSharedAcpRuntime({
  cwd: process.cwd(),
  permissionMode: "deny-all",
});

const handle = await runtime.ensureSession({
  sessionKey: "reviewer",
  agent: "pi",
  mode: "persistent",
});
const turn = runtime.startTurn({
  handle,
  requestId: crypto.randomUUID(),
  mode: "prompt",
  text: "Summarize the repository",
});

await turn.promptStarted;
for await (const event of turn.events) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
console.log(await turn.result);
await runtime.shutdown();
```

From a terminal using the same OS user, home directory, working directory, and resolved agent command:

```bash
acpx pi -s reviewer 'Review the previous summary'
acpx pi cancel -s reviewer
acpx pi sessions show reviewer
```

## Identity and ownership

`sessionKey` maps to the CLI's session name. An empty key selects the unnamed default session. Shared lookup uses the exact working directory; it does not walk into parent directories. The scope is the existing `(agentCommand, cwd, name)` tuple. Concurrent `ensureSession()` and CLI `sessions ensure` calls for the same scope select one record.

`findSession({ sessionKey, agent, cwd? })` looks up an open local session without launching an agent. Handles contain the canonical local record and provider session IDs. Keep shared handles with the shared runtime; the in-process runtime has a different ownership contract.

New sessions are created using the normal CLI path. Prompt submission starts or joins the existing queue owner, which keeps the live connection for its idle TTL. Shared turns require the saved provider session to resume successfully; an unavailable session produces an error instead of silently creating a different conversation. The agent must support loading or resuming sessions.

CLI mode, model, and configuration controls update the same retained connection
for a shared session, including while the owner is idle. Accepted controls are
saved by the owner before success is returned. A prompt starting behind an idle
control reads its saved state after that control finishes; an active prompt keeps
its control context until pending acknowledgements and checkpoints settle.

## Turns, cancellation, and disconnects

Use [`runtime.watchSession({ handle, cursor?, signal? })`](session-watch.md) to observe another client's session without submitting work. Watch streams replay retained events and follow new ones, independently of the submitting connection.

Use a fresh `requestId` for every turn. The ID is preserved through queueing and local status. Reusing an ID while it is queued or active is rejected; IDs do not provide an idempotent retry API.

`turn.promptStarted` resolves when the ACP transport accepts the actual prompt, after queue waiting and session preparation. Queue acceptance alone does not resolve it. It rejects when the turn never reaches the agent. `turn.result` settles after the owner's normal prompt finalization and checkpoint attempts; it reports `completed`, `cancelled`, or `failed`.

`turn.cancel()` or the turn's `AbortSignal` targets that request. Cancelling a queued turn removes it without cancelling another client's active turn. `runtime.cancel({ handle })` intentionally cancels the session's current active turn, like the CLI command.

Cancellation also stops remaining retries during backoff or before transport admission. A final adapter response already received keeps its actual outcome while updates drain; cancellation does not replace that completed response.

A timed-out turn with no final ACP response fails even if it produced partial text. The owner cancels and retires its unfinished connection before dispatching the next prompt, retaining final cancellation output under the original request. The successor resumes the saved provider session on a new connection. If connection cleanup fails, the owner stops accepting work and rejects queued prompts instead of reusing that connection.

`turn.closeStream()` stops local event delivery while the submitted turn continues. `runtime.shutdown()` detaches the client and waits for its admitted local operations to settle. It does not kill the shared owner or cancel accepted turns. A detached turn whose result was not received reports a failed local result; the work may still be running.

`runtime.close({ handle, reason })` explicitly performs the CLI's soft close: stop the owner and mark the record closed while retaining local history. A later ensure creates a new open session.

After a submission loses its connection, acpx cannot always know whether the agent ran it. Such uncertain failures are not automatically retried, and the owner is not killed to retry the prompt. Inspect the session before deciding whether to submit new work.

Updated clients accept complete owner responses without a fixed receive-buffer ceiling, including large events and accumulated session histories from older owners. Each response is assembled and parsed in memory; unfinished responses also have no application-level size bound. The owner's [output backlog limits](CLI.md#prompt-queueing) still apply, and older clients retain their previous receive limit.

On macOS and Linux, the owner disconnects an output observer whose buffered writes stop progressing, while the admitted turn continues and remains observable through session watching; Windows retains stalled output because named pipes do not report partial write progress reliably enough to disconnect without truncating a reader that is still consuming output.

## Configuration and compatibility

Shared runtime options are `cwd`, optional `agentRegistry`, required `permissionMode`, and optional `nonInteractivePermissions`, `permissionPolicy`, `authCredentials`, `authPolicy`, `timeoutMs`, and `ttlMs`. The default registry uses built-in agent commands. Applications with custom commands should pass `createAgentRegistry({ overrides: ... })` and use the identical command in CLI configuration or `--agent`.

Each submitting client supplies its static permission policy. Authentication and the child environment belong to the owner started for that session. Joining a session does not replace the existing owner's credentials. This is local, same-user IPC; it is not a network service or an isolation boundary between mutually untrusted clients.

Custom session stores, process lifecycle callbacks, child environment overlays, MCP resolvers, and per-turn permission or elicitation callbacks belong to `createAcpRuntime()`. They are not serialized or silently ignored by the shared runtime. Shared sessions currently support persistent prompt turns; use the in-process runtime for oneshot sessions and `mode: "steer"` turns. In-process steer turns queue like prompts; see [Steer turns](prompting.md#steer-turns). `startTurn()` still rejects a per-turn `assertActive`, because a shared turn runs inside the owner and cannot consult the submitting client again after admission.

## Session controls

`setMode({ handle, mode })`, `setModel({ handle, model })`, `setConfigOption({ handle, key, value })`, and `getCapabilities({ handle? })` work on shared sessions with the same signatures and return shapes as [`createAcpRuntime()`](session-control.md). `setConfigOption` resolves `key` against the saved option catalog and returns the adapter's full `configOptions` response. `getCapabilities()` without a handle reports the controls acpx implements; with a handle it adds `configOptionKeys` from the saved record. Newly advertised keys become available after the owner checkpoints them. Model selections are validated by the owner against its connected session's model catalog.

Capability results are independent mutable snapshots. Editing their control or config-key arrays does not affect another result, a saved session, or another runtime instance.

Shared controls are owner-only. When no queue owner holds the session, a control fails with `ACP_BACKEND_UNAVAILABLE` instead of opening its own adapter connection. Falling back to a direct connection would contend with the owner for the session, and that path may create a different provider session when the saved one no longer loads — the same trade shared turns already refuse. Submitting a turn starts an owner. The equivalent `acpx` command is an alternative rather than a way to start one: with no owner it applies the control over a temporary direct connection of its own, so it changes the selection without leaving an owner behind for the next shared control. Once an owner does exist it serves the control on its retained connection, whether or not a prompt is running.

An owner that advertises `persistsControlState` saves the accepted selection itself before reporting success, so updated shared clients do not write the record. Race-free persistence requires updated callers and an updated owner. A running v0.17.1 owner still needs caller-side persistence, and older callers may write even with an updated owner. Those whole-record writes can race other callers or owner checkpoints, leaving saved state stale even though the agent keeps what it accepted. Use updated clients and let an older owner expire while idle before resuming work. One shared client always runs its own controls for a session one at a time.

Controls accept the same optional `signal` and `assertActive` fields as the in-process runtime. The shared runtime checks them locally on the way in and again immediately before the request is written to the owner's socket, so authority withdrawn while the control is still finding the owner or opening its connection means nothing was sent. Authority is never consulted after that write: a control the owner has accepted still settles its response and saved state, and cannot be recalled. The check also covers this client only — it does not gate controls the CLI or another application sends to the same owner.

An older running owner may lack targeted cancellation and prompt-start notifications. Shared clients detect this before submitting work and report `QUEUE_SHARED_RUNTIME_UNSUPPORTED`. Allow that owner to expire when idle, or explicitly close the session before ensuring it again. Existing CLI clients can continue using their existing owners.

The explicit session-wide `runtime.cancel()` and `runtime.close()` operations retain their CLI semantics with older owners. The compatibility gate protects shared turn submission and targeted turn cancellation.
