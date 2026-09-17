# Antigravity

`acpx antigravity` launches Google's official Antigravity ACP runtime. It is a
separate download and sign-in from the Antigravity IDE and CLI. It does not wrap
`agy --print` or the CLI's streaming JSON interface.

## Installation and account setup

Download the archive for your platform from the
[official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
Keep its executable and `localharness_external` helper from the same release
together. Make both executable on Linux/macOS and put the runtime directory on
`PATH`, or override the agent command in your acpx config.

The built-in command is `agy_acp_server.par --uid=` on Linux,
`agy_acp_server.par` on macOS, and `agy_acp_server.exe` on Windows. The Linux
argument follows the official registry. Set `ANTIGRAVITY_HARNESS_PATH` to the
absolute path of the matching helper (`localharness_external.exe` on Windows).
acpx does not download or update these binaries.

The runtime owns authentication. Complete sign-in through an interactive ACP
client before unattended use. Its account profile is rooted at `GEMINI_HOME`
(default `~/.gemini`), not `HOME`. Select personal Google-account authentication
in `<GEMINI_HOME>/antigravity-acp/settings.json`:

```json
{ "auth": { "type": "oauth-personal" } }
```

The official runtime can infer this method from its settings; an acpx
`authCredentials` entry or dummy secret is not needed. Keep the same profile and
credential-storage configuration used during sign-in. A dedicated profile avoids
sharing writable state with another ACP client. `AGY_ACP_FORCE_FILE_STORAGE=1`
selects profile-local credential storage; let the runtime manage that file.

For a subscription-only unattended launcher, remove ambient Google/Gemini API
keys and cloud credential/project variables, select personal OAuth explicitly,
and reject browser sign-in with a clear setup error. Merely setting
`GEMINI_HOME` does not implement that failure policy. Expired credentials may
otherwise start interactive sign-in. Never commit or copy account tokens into
project configuration.

## Sessions and models

```bash
acpx antigravity sessions new --name work
acpx antigravity -s work set model <advertised-model-id>
acpx antigravity -s work 'Summarize this workspace'
```

Available models depend on the signed-in account. Use the exact model IDs
advertised in the session configuration; do not infer them from another Google
client or silently substitute an unavailable model. acpx uses its existing ACP
session reconnect and model configuration support.

## User questions

Antigravity sends fixed-choice user questions through `session/request_permission`
with an `interaction_` tool-call ID. Their options represent answers, not tool
approvals. acpx cancels these requests and reports that a user answer is required,
including under `--approve-all` or an embedding host's permission handler.
Continue those conversations in a client supporting Antigravity questions.
Ordinary tool permissions still follow acpx's permission policy.
