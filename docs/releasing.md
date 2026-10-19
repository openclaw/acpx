# Releasing acpx

Releases publish the Node.js package to npm and attach the same tarball and its
SHA-256 checksum to a GitHub Release. There are no native binaries or appcasts.
Publication runs entirely in this repository's
[`release.yml`](https://github.com/openclaw/acpx/blob/main/.github/workflows/release.yml) GitHub Actions workflow. An
external release service is not required. Do not use the legacy local release-it
configuration or publish a locally built package.

1. Confirm `main` CI is green and that no maintainer has another release in progress.
2. Choose a patch for fixes and dependency updates, or a minor for new features.
   Update `package.json`, move every Unreleased bullet into a dated version
   section, and add a one-line `**Highlights:**` summary. Keep an empty
   `## Unreleased` section above the release.
3. Open a release-prep PR. Run independent review and require green CI at its
   exact head before merging.
4. Dispatch `.github/workflows/release.yml` at the merge commit with
   `dry_run: true`. Require the exact run to finish successfully. This builds and
   packages the release without publishing; non-dry dispatches are rejected.
   Dry runs also accept an already published version so dependency and packaging
   checks can run on current `main` without a version bump. Tag-triggered releases
   still require an unpublished version.
5. Create an annotated `vX.Y.Z` tag on that commit, signed with the fleet release
   SSH key. Verify it against the trusted release-key allowlist before pushing.
   Use `.github/release-signers` as the allowed-signers file; the workflow checks
   the same allowlist. Run verification and push in a fail-fast shell so a failed
   verification cannot fall through to publishing:

   ```bash
   set -euo pipefail
   git -c gpg.format=ssh -c user.signingkey="$RELEASE_SIGNING_KEY" \
     tag -s vX.Y.Z "$RELEASE_COMMIT" -m "acpx X.Y.Z"
   git -c gpg.ssh.allowedSignersFile=.github/release-signers verify-tag vX.Y.Z
   git push origin refs/tags/vX.Y.Z
   ```

   `RELEASE_SIGNING_KEY` must point to the approved fleet key, never a developer's
   default key. Repository administrators have a bypass for tag creation only;
   separate rules prohibit tag updates and deletion. Never move or delete an
   existing release tag.

6. Push that tag. The workflow checks main ancestry and package metadata,
   publishes the immutable verified tarball to npm through the `stable-release`
   environment using OIDC provenance, then creates the GitHub Release from the
   changelog section and attaches the tarball and `SHA256SUMS`.
7. Read back the GitHub Release and npm metadata. Download both assets, verify
   the checksum and npm integrity, install the downloaded package in an isolated
   directory, and smoke-test its version and a real command on synthetic input.

If only GitHub Release creation fails after npm succeeds, rerun that failed job;
never republish or retag an existing version. A dry-run artifact is not a release.

## Trusted publisher configuration

The npm package `acpx` trusts GitHub repository `openclaw/acpx`, workflow file
`release.yml`, and environment `stable-release`. Keep those exact values aligned
with the publish job. The environment permits `v*` tags; it does not require an
external service or reviewer. The publish job uses a GitHub-hosted runner, a
version of npm with OIDC support, and `id-token: write`; no npm token secret is
needed. The build job has no publishing permission.

Immediately before the first OIDC publish, inspect `npm trust list acpx --json`
using an authenticated maintainer session. If the package has never successfully
published through OIDC, revoke and recreate the record with the same repository,
workflow, environment, and permissions. Unused new records expire after two days.
Refresh the record immediately before pushing the signed tag, then verify npm
provenance points back to this repository's release run after publication.
