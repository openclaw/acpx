# Releasing acpx

Releases publish the Node.js package to npm and attach the same tarball and its
SHA-256 checksum to a GitHub Release. There are no native binaries or appcasts.
Use GitHub Actions; do not use the legacy local release-it configuration.

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
5. Create an annotated `vX.Y.Z` tag on that commit, signed with the fleet release
   SSH key. Verify it against the trusted release-key allowlist before pushing.
   Use `.github/release-signers` as the allowed-signers file; the workflow checks
   the same allowlist. Never move or delete an existing release tag.
6. Push that tag. The workflow checks main ancestry and package metadata,
   publishes the immutable verified tarball to npm through the `stable-release`
   environment using OIDC provenance, then creates the GitHub Release from the
   changelog section and attaches the tarball and `SHA256SUMS`.
7. Read back the GitHub Release and npm metadata. Download both assets, verify
   the checksum and npm integrity, install the downloaded package in an isolated
   directory, and smoke-test its version and a real command on synthetic input.

If only GitHub Release creation fails after npm succeeds, rerun that failed job;
never republish or retag an existing version. A dry-run artifact is not a release.
