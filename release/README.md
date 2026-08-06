# Release boundary

Release artifacts are built only from this repository and only after the committed repository and npm-package allowlists pass. The `npm-release` GitHub environment must require a human reviewer.

The public repository identity is fixed to `agtbox <dev@agtbox.dev>` for both
commit authors and committers. `npm run verify:authors` checks both fields for
the complete reachable release history before any artifact is built or
published. Internal mirrors must export with this identity and must never copy
operator identities into the public history.

The release workflow accepts an exact `v<package-version>` tag, exports its exact Git tree to an isolated build directory, generates the bundle and dependency metafile there, builds the tarball twice without lifecycle scripts, compares its bytes, scans the retained unpacked artifact, installs that same artifact in clean npm and Bun projects, and publishes it through npm trusted publishing. The manifest binds the tarball to the source-tree object ID, and the publisher verifies that binding again. Traditional npm credentials are rejected.

Before enabling the workflow:

1. Create the `npm-release` GitHub environment and require a human reviewer.
2. Configure the npm trusted publisher for package `@agtbox/cli`, GitHub repository `agtbox/cli`, workflow `release.yml`, environment `npm-release`, and `npm publish` only.
3. Set repository variable `NPM_TRUSTED_PUBLISHING_READY` to `true` only after that relationship is verified.
4. Disallow traditional npm publish tokens for the package.

npm requires a package to exist before its trusted publisher can be configured. The first publication is therefore a separate human-controlled bootstrap gate. Its exact reviewed tarball, SHA-256, and manifest must be approved before using a short-lived publishing credential; the credential must be revoked immediately afterward. Configure trusted publishing before any subsequent version.
