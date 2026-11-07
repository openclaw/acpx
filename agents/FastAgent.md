# FastAgent

- Built-in name: `fast-agent`
- Default command: `uvx fast-agent-mcp acp`
- Upstream: https://fast-agent.ai/acp

`acpx fast-agent` starts fast-agent through its ACP entrypoint. It requires `uvx` on `PATH`.

Configure model/provider settings through fast-agent environment variables, fast-agent configuration, or an `acpx` agent override with additional `fast-agent-mcp acp` arguments.

## Python and certificate updates

Fast Agent runs in UV's selected Python environment, separately from acpx's Node.js runtime.
Keep that interpreter and Fast Agent's dependencies patched. Updating acpx or `certifi`
alone does not update the interpreter's TLS implementation or establish incident certificate
rejection. Bare `uvx` can reuse an operator-installed tool and its older dependencies.

To recover without changing an existing tool installation, select an official Python
release containing the certificate distrust fixes. The tested reference is
[Python 3.14.10](https://www.python.org/downloads/release/python-31410/), whose release
notes identify the eMudhra key distrust fix; use the current patched release for your
supported Python series. Inspect its actual executable and TLS backend first, replacing
the example path below:

```bash
/absolute/path/to/patched/python3 -c 'import os, ssl, sys; print(os.path.realpath(sys.executable)); print(sys.version); print(ssl.OPENSSL_VERSION)'
uvx --verbose --isolated --refresh --python /absolute/path/to/patched/python3 fast-agent-mcp --version
```

Check UV's verbose output for the selected interpreter and resolved tool environment,
then use the same selection through acpx. Keep your existing Fast Agent/provider
configuration and run from its working directory:

```bash
acpx --verbose --agent 'uvx --isolated --refresh --python /absolute/path/to/patched/python3 fast-agent-mcp acp' exec 'Reply with a short confirmation'
```

`--isolated` bypasses the installed tool; this does not upgrade or replace that installation.
Manage an installed tool's updates separately through `uv tool upgrade`, including its
Python selection. Keep the explicit acpx override for subsequent launches that should
use this separate environment;
the built-in default remains `uvx fast-agent-mcp acp`.

Linux AMD64 qualification of the OpenAI-compatible provider used official Python 3.14.10
with OpenSSL 3.5.9: legitimate private-CA streaming requests succeeded and two verified
incident chains were rejected even with their roots supplied explicitly. The affected
Python 3.14.4 runtime accepted those chains despite an updated `certifi` bundle. This evidence does
not qualify other platforms, providers, trust-store modes, or operator installations.

Some OpenAI-compatible transport certificate failures appear as "Request timed out" in
the model response. Inspect Fast Agent's configured diagnostic logs for the underlying
certificate error; a timeout or acpx exit status alone does not establish rejection.
After updating the selected interpreter and dependencies, retry a legitimate endpoint.
Keep certificate verification enabled and do not restore incident certificates to recover
connectivity.
