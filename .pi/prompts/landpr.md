---
description: Land a PR (merge with proper workflow)
---

Input

- PR: $1 <number|url>
  - If missing: use the most recent PR mentioned in the conversation.
  - If ambiguous: ask.

Do (end-to-end)
Goal: PR must end in GitHub state = MERGED (never CLOSED). Prefer `gh pr merge --squash`; use `--rebase` only when preserving commit history is required.

1. Assign PR to self:
   - `gh pr edit <PR> --add-assignee @me`
2. Repo clean:
   - `git status`
3. Identify PR meta:

   ```sh
   gh pr view <PR> --json number,title,author,headRefName,baseRefName,headRepository,maintainerCanModify --jq '{number,title,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner,maintainerCanModify}'
   contrib=$(gh pr view <PR> --json author --jq .author.login)
   head=$(gh pr view <PR> --json headRefName --jq .headRefName)
   head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)
   ```

4. Fast-forward base:
   - `git checkout main`
   - `git pull --ff-only`
5. Create temp base branch from main:
   - `git checkout -b temp/landpr-<ts-or-pr>`
6. Check out PR branch locally:
   - `gh pr checkout <PR>`
7. Rebase PR branch onto temp base:
   - `git rebase temp/landpr-<ts-or-pr>`
   - Fix conflicts and keep history tidy.
8. Fix + tests + changelog:
   - Implement fixes and adjust tests as needed.
   - Update [`CHANGELOG.md`](../../CHANGELOG.md) for user-facing changes under `## Unreleased`.
9. Validation gate:
   - Docs-only changes: `pnpm run check:docs`
   - Code changes: `pnpm run check`
   - Code + docs changes: run both
10. Final merge-ready commit:

- Use a concise message and include the PR number when appropriate, for example:
  - `git commit -m "fix(conformance): harden runner startup and cwd handling (#130)"`
- `land_sha=$(git rev-parse HEAD)`

11. Push updated PR branch:

```sh
git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"
git push --force-with-lease prhead HEAD:$head
```

12. Merge PR:

- Squash (preferred): `gh pr merge <PR> --squash`
- Rebase (history-preserving fallback): `gh pr merge <PR> --rebase`
- Never `gh pr close`

13. Sync main:

- `git checkout main`
- `git pull --ff-only`

14. Comment on PR with what landed:

```sh
merge_sha=$(gh pr view <PR> --json mergeCommit --jq '.mergeCommit.oid')
gh pr comment <PR> --body "Landed via temp rebase onto main.\n\n- Gate: validation completed for this repo's change scope\n- Land commit: $land_sha\n- Merge commit: $merge_sha\n\nThanks @$contrib!"
```

15. Verify PR state == MERGED:

- `gh pr view <PR> --json state --jq .state`

16. Delete temp branch:

- `git branch -D temp/landpr-<ts-or-pr>`
