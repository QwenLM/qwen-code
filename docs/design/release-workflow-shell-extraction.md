# Release workflow shell extraction

## Problem

`release.yml` mixes orchestration, operational history, and long shell
programs. Routine maintenance therefore grows the workflow and repeatedly
consumes its size-ratchet allowance.

## Design

Keep job orchestration, permissions, conditions, action invocations, and inputs
in YAML. Move the executable preparation, validation, publishing, and failure
notification logic into repository-owned scripts.
Combine adjacent publish commands only where they already share a job,
permissions, and failure boundary.

Every job that invokes an extracted script checks out `.github/scripts` from
`github.workflow_sha` into an isolated path before execution. This keeps manual
releases of older branches or commits working and prevents an operator-selected
release ref from supplying _the extracted helper scripts_ that receive release
credentials. It does not stop ref-supplied code from running inside a
credential-bearing step: version resolution still executes the ref's
`scripts/get-release-version.js` with the job token, and the release commit
still runs the ref's `.husky` hooks in the step that holds the bot PAT. Both
paths predate this extraction and are unchanged by it. After running code from
the selected ref, credential-bearing steps delete and re-checkout that isolated
path, which resets `.release-workflow` only — never `.husky` or `package.json`.
Versioning remains separate from the bot-PAT step, preserving the existing
credential boundary.

The pre-checkout workspace cleanup remains inline. It must execute before any
checkout can safely read from a persistent self-hosted workspace, so moving it
to a repository script would invert its security boundary. Its historical
commentary is reduced to the non-obvious invariants enforced by its tests.

After extraction, record the smaller `release.yml` size as the new baseline.
Future shell maintenance changes the scripts, not the workflow baseline.
