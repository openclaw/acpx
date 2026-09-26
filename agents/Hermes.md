# Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) provides an ACP stdio server.
Configure it as a [custom agent](../docs/custom-agents.md) using the Python
interpreter from its installation:

```json
{
  "agents": {
    "hermes": {
      "argv": ["/path/to/hermes/venv/bin/python", "-m", "acp_adapter"]
    }
  }
}
```

On Windows, use the corresponding `venv/Scripts/python.exe` path. Install Hermes
with its ACP dependencies and configure its model/provider before launching it.
The normal acpx prompt queue still applies.

## Optional active-turn guidance

The source checkout includes
[`examples/hermes-steer/hermes_steer.py`](../examples/hermes-steer/hermes_steer.py),
an optional launcher with a separate local control channel. It calls Hermes'
`redirect()` API on an active turn. It does not send another ACP prompt, change
acpx's queue, or replace the original turn's output owner.

Use absolute paths in custom-agent configuration:

```json
{
  "agents": {
    "hermes": {
      "argv": [
        "/path/to/hermes/venv/bin/python",
        "/path/to/acpx/examples/hermes-steer/hermes_steer.py",
        "run",
        "--control-dir",
        "/private/path/hermes-steer"
      ]
    }
  }
}
```

Use a private directory owned by your user; on Windows its inherited ACL must
restrict access to your account. Descriptors contain authentication tokens. Do
not commit, share, or include them in logs. The server binds only to `127.0.0.1`
and requires a random bearer token. Each launcher has an independent descriptor.

Start a task normally:

```bash
acpx hermes sessions new
acpx hermes 'Review the login module'
```

While that prompt is running, discover its owner and live ACP session ID:

```bash
python /path/to/acpx/examples/hermes-steer/hermes_steer.py list --control-dir /private/path/hermes-steer
```

Send guidance to those exact IDs from the returned JSON:

```bash
python /path/to/acpx/examples/hermes-steer/hermes_steer.py steer --control-dir /private/path/hermes-steer --owner OWNER --session-id SESSION --message 'Focus only on verification-code replay'
```

Use `--file /path/to/guidance.txt` instead of `--message` for UTF-8 text from a file.
`list` and `steer` use only Python's standard library; `run` needs Hermes installed
in its interpreter. Errors produce JSON on stderr and a nonzero exit code.

An `accepted: true` response means Hermes accepted the guidance for its current
turn. It does not prove the model consumed it: subsequent cancellation or turn
completion can still win. During model sampling, Hermes can resample with the
correction; during tool execution, it defers guidance to the next tool-result
boundary within the current turn without aborting that tool. Idle, cancelling, unknown, unsupported, and late-rejected
turns return errors. They never silently become queued prompts or new turns.

Guidance bypasses acpx's prompt journal. Keep the caller's guidance text when
replaying from acpx logs alone; the tested Hermes runtime records it in its own
conversation history.

Owner IDs are not acpx session names. Copy the owner and ACP session ID from
`list`; the launcher does not guess targets, restore sessions, retry guidance,
or restart dead owners. Stale descriptors appear under `unavailable`. Normal
shutdown removes the descriptor. This example uses Hermes internal session and
startup APIs, so recheck compatibility when upgrading Hermes. The script is
independent of acpx internals and can be kept separately when updating acpx.
On Windows it preserves the optional memory-provider warm-up added in newer
[Hermes startup code](https://github.com/NousResearch/hermes-agent/commit/80f4c6d6bfe5714964d01db2b71b0894a16a50d2),
before starting background threads. Older Hermes revisions without that hook
continue to work.

## Test the example

These tests use a fake runtime and real loopback HTTP/CLI calls, with no model
credentials or Hermes installation required:

```bash
python -B -m unittest discover -s examples/hermes-steer -p 'test_*.py' -v
```

The launcher was also exercised on Windows with Hermes commit
[`79445a4`](https://github.com/NousResearch/hermes-agent/commit/79445a496c86a19332ad786494b8384d2167e2d0): an acpx
prompt reached the real Hermes ACP server and agent loop against a local mock
model endpoint. Guidance reached a second model request while the original acpx
prompt was still running; that prompt completed normally. Idle guidance was
rejected without another model call. Separate real-Hermes checks covered
cancellation. These checks used no paid model and do not establish MiMo behavior.

The example is distributed in the source checkout, not the npm package.
