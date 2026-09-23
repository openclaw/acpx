---
description: Land a PR targeting main (merge with proper workflow)
---

Input

- PR: $1 <number|url>
  - If missing: use the most recent PR mentioned in the conversation.
  - If ambiguous: ask.

Do (end-to-end)
Goal: Land PRs targeting `main` in GitHub state = MERGED (never CLOSED). Refuse other or unknown bases before making changes. Prefer `gh pr merge --squash`; use `--rebase` only when preserving commit history is required.

1. Repo clean:
   - `git status -sb`
2. Identify PR meta:

   ```sh
   gh pr view <PR> --json number,title,author,headRefName,baseRefName,headRepository,maintainerCanModify --jq '{number,title,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner,maintainerCanModify}'
   contrib=$(gh pr view <PR> --json author --jq .author.login)
   base=$(OCTOPOOL_FRESH=1 gh pr view <PR> --json baseRefName --jq .baseRefName)
   head=$(gh pr view <PR> --json headRefName --jq .headRefName)
   head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)
   ```

3. Require a main-targeting PR, then assign:
   - The base lookup must succeed and `base` must be exactly `main`. Otherwise stop before assignment, checkout, branch creation, rebase, commit, push, or merge; report the actual base or lookup failure.
   - Do not retarget the PR or fall back to `main` when the base is missing or different.
   - Only after this guard passes: `gh pr edit <PR> --add-assignee @me`
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

- Refresh `base` with step 2's fresh `baseRefName` query and require the same successful `main` result before changing the remote or pushing. Stop on lookup failure or a changed base, preserving prepared local work.

```sh
git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"
git push --force-with-lease prhead HEAD:$head
```

12. Merge PR:

- Refresh and check the base again as in step 11 before merging.
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
