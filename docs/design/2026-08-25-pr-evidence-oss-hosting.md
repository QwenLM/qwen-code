# PR Evidence Hosting on Aliyun OSS

## Problem

Automated PR verification currently publishes screenshots by committing them to
`pr-assets/*` branches in the main repository. A normal clone fetches objects
reachable from every advertised branch, so long-lived PNG-only branches add
hundreds of megabytes to clone traffic and repository storage even though the
images are unrelated to the product source tree.

## Goals

- Keep inline screenshots in Web Shell visual previews and `/verify` reports.
- Stop automated workflows from creating or updating image branches in this
  repository.
- Reuse the existing, tested Aliyun OSS uploader and repository credentials.
- Preserve the current validation, size limits, retries, and fail-safe behavior.
- Keep PR-derived bytes and OSS credentials separated by a trusted publisher
  job.

## Design

Both trusted publisher jobs configure the existing `ossutil` client and invoke
`scripts/upload-aliyun-oss-assets.js`. The uploader keeps its existing
three-attempt retry policy and publishes objects with `public-read` ACL.

Web Shell previews use this immutable prefix:

```text
pr-assets/web-shell-visuals/<pr>/<head-sha>/
```

Re-running the same PR head overwrites the same object names. A new head uses a
new prefix, so an already-posted URL cannot change underneath a reviewer.

Sandboxed `/verify` reports use this immutable prefix:

```text
pr-assets/verify/pr<pr>-<run-id>-<run-attempt>/
```

The workflow continues to accept at most eight PNGs of at most 2 MiB each,
checks PNG magic bytes, sanitizes names, and degrades to a text-only report if
hosting fails.

The publisher jobs run in the base-repository context and never expose OSS
credentials to the jobs that execute PR code. They consume only bounded,
validated image artifacts.

The automated review workflow has a third, separate image path through
`qwen review publish-assets`. That CLI feature remains available for an
explicitly designated assets repository, but the workflow now rejects a
designation that points back to the repository under review. An unset or
self-targeting destination degrades to prose and downloadable run artifacts;
an external image-host repository remains supported.

## Compatibility and cleanup

Existing PR comments keep their Git-backed URLs. The PR-close cleanup workflow
continues deleting historical `pr-assets/*` refs, but no new refs are produced
by the migrated workflows.

OSS object retention is intentionally external to the workflow. The
`pr-assets/` prefix can use a bucket lifecycle rule without changing repository
history or clone behavior.

## Verification

- Execute the workflow-level `/verify` image-hosting harness against a fake OSS
  uploader, including valid images, rejected images, duplicate names, the exact
  size boundary, first publication, and upload failure.
- Assert both publisher workflows call the shared uploader and contain no Git
  image push path.
- Assert the automated review workflow cannot target this repository for image
  branches.
- Run the shared uploader unit tests and workflow parser tests.
