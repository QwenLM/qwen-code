# Nightly release promotion

## Goal

Allow a maintainer to select an exact successful nightly release and publish
the same source revision as a stable release without rerunning the release
validation matrix.

## Contract

Promotion is a manual Release workflow mode. The selected nightly must be a
canonical nightly tag whose suffix matches the source parent of its release
commit. Its GitHub prerelease and npm package must exist, and a successful
Release run for that source must cover the release publication time with the
aggregate quality, no-sandbox integration, Docker integration, and publish
jobs all successful. Each Release run records its resolved source SHA as an
immutable artifact so manually dispatched runs remain bound to the checked-out
`ref`, not merely the workflow's trigger SHA. Missing or ambiguous evidence
rejects the promotion. Initially, only first-attempt runs are eligible so
artifacts and job results cannot be mixed across rerun attempts.

The stable version is derived by removing the nightly suffix. Validation jobs
are skipped only after the evidence check succeeds; publishing still checks
out the verified source SHA, rewrites stable version metadata, rebuilds the
packages and standalone archives, and retains the existing publication guards.

## Initial scope

The first version reuses validation evidence rather than cross-run build
artifacts. Retaining and promoting version-neutral artifacts can be added
later if the remaining build-and-publish time justifies the extra lifecycle.
