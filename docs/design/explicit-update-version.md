# Explicit standalone update versions

`qwen update` currently discovers a release through npm before downloading it. An operator who already selected an exact release cannot install it when registry access is unavailable, even if release artifacts are reachable.

Add `--target-version` to the CLI update command. Validate and normalize the concrete version locally, skip version discovery, and reuse the standalone updater with that target. Without the option, preserve discovery and existing installation instructions. The existing `--version` option keeps its display-only meaning.

Explicit selection permits same-version reinstalls and downgrades: it is a request to install exactly that release, not to find a newer release. Stable and concrete prerelease versions are accepted, with an optional leading `v`; mutable tags and malformed versions are rejected. Unsupported installation methods return an error directing the user to install the exact version manually, without registry discovery or suggesting an unpinned upgrade.

Artifact routing continues to honor `QWEN_UPDATE_BASE_URL`. The archive, checksums and signature use the same resolved release root. The updater checks the new executable's version against the requested version before replacing the installation. Existing integrity checks, locking, extraction safeguards, atomic replacement and rollback remain unchanged.

Changes are limited to the CLI command and its tests, standalone version validation and smoke testing, and user documentation. No daemon/UI endpoints, automatic update policies, registry mirrors or release infrastructure are introduced. No open design questions remain.
