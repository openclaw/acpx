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

## Turns, cancellation, and disconnects

Use a fresh `requestId` for every turn. The ID is preserved through queueing and local status. Reusing an ID while it is queued or active is rejected; IDs do not provide an idempotent retry API.

`turn.promptStarted` resolves when the ACP transport accepts the actual prompt, after queue waiting and session preparation. Queue acceptance alone does not resolve it. It rejects when the turn never reaches the agent. `turn.result` settles after the owner's normal prompt finalization and checkpoint attempts; it reports `completed`, `cancelled`, or `failed`.

`turn.cancel()` or the turn's `AbortSignal` targets that request. Cancelling a queued turn removes it without cancelling another client's active turn. `runtime.cancel({ handle })` intentionally cancels the session's current active turn, like the CLI command.

`turn.closeStream()` stops local event delivery while the submitted turn continues. `runtime.shutdown()` detaches the client and waits for its admitted local operations to settle. It does not kill the shared owner or cancel accepted turns. A detached turn whose result was not received reports a failed local result; the work may still be running.

`runtime.close({ handle, reason })` explicitly performs the CLI's soft close: stop the owner and mark the record closed while retaining local history. A later ensure creates a new open session.

After a submission loses its connection, acpx cannot always know whether the agent ran it. Such uncertain failures are not automatically retried, and the owner is not killed to retry the prompt. Inspect the session before deciding whether to submit new work.

## Configuration and compatibility

Shared runtime options are `cwd`, optional `agentRegistry`, required `permissionMode`, and optional `nonInteractivePermissions`, `permissionPolicy`, `authCredentials`, `authPolicy`, `timeoutMs`, and `ttlMs`. The default registry uses built-in agent commands. Applications with custom commands should pass `createAgentRegistry({ overrides: ... })` and use the identical command in CLI configuration or `--agent`.

Each submitting client supplies its static permission policy. Authentication and the child environment belong to the owner started for that session. Joining a session does not replace the existing owner's credentials. This is local, same-user IPC; it is not a network service or an isolation boundary between mutually untrusted clients.

Custom session stores, process lifecycle callbacks, child environment overlays, MCP resolvers, and per-turn permission or elicitation callbacks belong to `createAcpRuntime()`. They are not serialized or silently ignored by the shared runtime. Shared sessions currently support persistent prompt turns; use the in-process runtime for oneshot sessions and steering.

An older running owner may lack targeted cancellation and prompt-start notifications. Shared clients detect this before submitting work and report `QUEUE_SHARED_RUNTIME_UNSUPPORTED`. Allow that owner to expire when idle, or explicitly close the session before ensuring it again. Existing CLI clients can continue using their existing owners.

The explicit session-wide `runtime.cancel()` and `runtime.close()` operations retain their CLI semantics with older owners. The compatibility gate protects shared turn submission and targeted turn cancellation.
