# CodeBuddy

CodeBuddy can be used as a custom ACP command, for example:

```bash
acpx --agent 'codebuddy --acp' exec 'review this repository'
```

Some CodeBuddy versions send legacy `session/request_permission` option kinds.
ACPX normalizes only these known pairs before ACP validation:

| Legacy kind | Option ID       | ACP kind       |
| ----------- | --------------- | -------------- |
| `allow`     | `allow_once`    | `allow_once`   |
| `allow`     | `allow_session` | `allow_always` |
| `reject`    | `deny`          | `reject_once`  |

The original option IDs, labels, and other fields remain intact, so a host’s
selection is returned using the exact ID the agent offered. This compatibility
applies only when the launched executable is `codebuddy` (including Windows
`.cmd`, `.exe`, or `.ps1` forms) or initialization reports `agentInfo.name` as
`codebuddy`, ignoring case. Unknown pairs and unrelated agents still undergo
normal ACP validation. Already-valid ACP kinds are unchanged.
