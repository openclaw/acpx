# Security Policy

If you believe you have found a security issue in `acpx`, please report it privately.

## Reporting

Report vulnerabilities for this repository at:

- [openclaw/acpx](https://github.com/openclaw/acpx)

If you are unsure whether the issue belongs in `acpx`, email **security@openclaw.ai** and include:

1. **Title**
2. **Severity assessment**
3. **Impact**
4. **Affected component**
5. **Technical reproduction**
6. **Demonstrated impact**
7. **Environment**
8. **Remediation advice**

Reports without reproduction steps, demonstrated impact, and remediation advice may be deprioritized.
Given the volume of AI-generated scanner findings, we must ensure we're receiving vetted reports from researchers who understand the issues.

## Bug Bounties

`acpx` is a labor of love. There is no bug bounty program and no budget for paid reports. Please still disclose responsibly so we can fix issues quickly.
The best way to help the project right now is by sending PRs.

## Maintainers: GHSA Updates via CLI

When patching a GHSA via `gh api`, include `X-GitHub-Api-Version: 2022-11-28` (or newer). Without it, some fields, notably CVSS, may not persist even if the request returns 200.

## Scope

`acpx` is a local, headless CLI client for the Agent Client Protocol (ACP). It runs on a trusted machine, spawns local ACP adapters and agents, and stores session/config state on disk.

Security issues in scope generally include:

- unintended command execution caused by `acpx`
- unsafe handling of local credentials or auth material configured through `acpx`
- path traversal or filesystem boundary bypasses in `acpx` client features
- permission-policy bypasses in `fs/*` or `terminal/*` client method handling
- leakage of sensitive local data through `acpx` session persistence or output modes

## Out of Scope

The following are usually out of scope for this repository:

- vulnerabilities in upstream coding agents, ACP adapters, or third-party CLIs that `acpx` launches
- issues that require prior write access to trusted local state such as `~/.acpx/`, project files, or shell startup files
- prompt injection by itself, unless it demonstrates a concrete `acpx` security boundary bypass
- insecure local machine administration or multi-user host setups where the OS trust boundary is already lost
- use of unrecommended or intentionally unsafe custom agent commands provided through `--agent`

If the issue is actually in an upstream tool, please report it to that project. Examples include:

- OpenClaw bridge issues: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- Codex ACP adapter issues: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)
- Gemini CLI issues: [google/gemini-cli](https://github.com/google/gemini-cli)

## Trust Boundaries

`acpx` assumes the local machine and user account running it are trusted.

- Global config is stored in `~/.acpx/config.json`.
- Session metadata and history are stored under `~/.acpx/sessions/`.
- Project config may be read from `<cwd>/.acpxrc.json`.
- Spawned adapters and agents run with the privileges of the current user.

If an attacker can already modify those files or the commands that `acpx` launches, they have already crossed the primary trust boundary.

## Operational Guidance

- Keep `acpx`, Node.js, and the underlying coding agents up to date.
- Review any custom commands configured through `--agent` or `config.agents.*.command` before using them.
- Treat `~/.acpx/config.json` as sensitive if it contains auth credentials.
- Do not share session files or command output if they may contain prompts, file paths, or credentials from local work.
- Prefer running `acpx` on a trusted local machine or isolated CI runner.

## Runtime Requirements

`acpx` requires **Node.js 22.13.0 or later**.

Verify your version with:

```bash
node --version
```
