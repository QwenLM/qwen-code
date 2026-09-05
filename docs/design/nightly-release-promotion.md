# Nightly release promotion

## Goal

Allow a maintainer to select an exact successful nightly release and publish
the same source revision as a stable release without rerunning the release
validation matrix.

## Contract

Promotion is a manual Release workflow mode. The selected nightly must be a
canonical nightly tag pointing at a `chore(release): <tag>` commit with a
single parent, and its GitHub prerelease and npm package must both exist. A
successful Release run must cover the release publication time with the
aggregate quality, no-sandbox integration, Docker integration, and publish
jobs all successful. Missing or ambiguous evidence rejects the promotion.
Initially, only first-attempt runs are eligible: the artifacts API carries no
attempt attribution, so on a re-run the recorded source and the job
conclusions cannot be tied to the same attempt.

### What binds the source

Each Release run records its resolved source SHA as an artifact
(`release-source-<sha>`), so manually dispatched runs stay bound to the
checked-out `ref` rather than the workflow's trigger SHA. That record is the
authority on what `publish` built, and it must equal the parent of the release
commit the tag points at — two independent records of the same revision. A
disagreement means `prepare` and `publish` resolved different revisions, so
nothing can say which one the published nightly contains, and promotion is
refused.

The nightly version's short SHA is only a label written by `prepare`. It can
legitimately lag the revision that was built (a re-run reusing `prepare`'s
outputs did exactly that in `v0.22.3-nightly.20260831.3a0c4c6108`), so a
mismatch is reported as a warning instead of rejecting an otherwise
well-evidenced promotion.

Recording the source is best-effort (`continue-on-error`): it is evidence for
a possible later promotion, not a release requirement, and must not be able to
fail a release that is otherwise fine. A missing record simply makes that run
unpromotable.

### What picks the version

The nightly tag names the source revision, not the version to publish. A
nightly's numeric base comes from main's `package.json` (see
`getNightlyVersion`), which the ordinary stable path publishes on its own —
`0.22.0-nightly.*` shipped as `0.22.0`, `0.22.3-nightly.*` as `0.22.3` — so by
the time a nightly is promoted that number has either already shipped or
fallen behind the `latest` dist-tag. `getPreviewVersion` already compensates
for the same skew when deriving a preview base.

The stable version is therefore a release decision: the workflow's `version`
input names it, or it is derived as the next minor after the `latest`
dist-tag. Either way it must be a valid `X.Y.Z`, must not be lower than
`latest`, and must not already exist on npm, as a git tag, or as a GitHub
release.

### Candidate search

The publishing run is looked up in a window around the nightly's publication
(three days before to one day after), paging through results, rather than
scanning the head of the completed-run list: Release runs are frequent enough
that an unbounded head scan stops finding nightlies older than about a month,
long before their evidence expires. If the window holds more runs than the
search pages through, promotion is refused rather than answered from a partial
scan.

### Reused validation

Validation jobs are skipped only after the evidence check succeeds; publishing
still checks out the verified source SHA, rewrites stable version metadata,
rebuilds the packages and standalone archives, and retains the existing
publication guards. Native audio prebuilds are pinned to the verified source
SHA so a release cannot mix code from two revisions.

Validation is reused from a run that used the release workflow as it stood
then. If `release.yml` has since gained checks, promotion skips them, so a
changed workflow definition is reported as a warning on the promotion run.

## Initial scope

The first version reuses validation evidence rather than cross-run build
artifacts. Retaining and promoting version-neutral artifacts can be added
later if the remaining build-and-publish time justifies the extra lifecycle.

The `release-source-<sha>` record only starts existing once this change is
merged, so no nightly cut before that can be promoted.
