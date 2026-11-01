# Managed runtime 0.26.3 test repair

[English](managed-runtime-0263-test-repair.md) | [简体中文](managed-runtime-0263-test-repair.zh-CN.md)

## Problem and scope

CLI 0.26.3 is already published. Its separate Managed runtime release fails in
`Issue13180HardenedVerificationTest`: an unqualified `JdbcTemplate` binds string
identities to `VARBINARY` columns, which H2 rejects. Production stores use
`managedJdbcTemplate`, which binds those identities as bytes.

The correction selects that same bean in the test. It preserves all anonymous,
intruder and owner assertions, and changes no production code or schema.

## Recovery for the existing tag

The Managed runtime workflow checks out the exact published tag. A rerun of the
old workflow therefore cannot consume the fix from main. After this change is
merged, manually dispatch the workflow from main with `tag=v0.26.3` and
`dry_run=false`.

A checked-in patch from the workflow's pinned tooling revision applies only to
the affected Java test, only for `v0.26.3`, and only for source commit
`eeee1443a7e36ab22b2f1dcded8dec64b621a7ee`. The step requires a clean tracked
checkout, verifies the patch's sole target, checks applicability, and verifies
the resulting changed-file list. Unexpected input fails before building.

The complete SDK and server verification commands remain unchanged. Publication
still checks the immutable tag and existing asset bytes, adds only missing
assets, and verifies GitHub and OSS downloads. The original tag, production
source, CLI version and existing artifacts are not rewritten. Other versions do
not receive this patch. This is a one-release repair, not a general overlay API.

## Validation and acceptance

- CI must run the existing ownership test with its original assertions.
- Workflow regression coverage must apply the patch to the original test and
  produce the corrected test without changing a production-file sentinel.
- Wrong source commits and patches targeting production files must be rejected.
- After merge, the manual release must pass the full Maven gates and publish the
  missing 0.26.3 runtime JAR and checksum to both existing channels.

Local tests and builds are not run for this task. Static review is not runtime
acceptance; the PR and subsequent release CI must provide that evidence. Until
then the Managed runtime backfill remains pending. The recovery step must remain
available for reproducible 0.26.3 retries; changes to it require review.
