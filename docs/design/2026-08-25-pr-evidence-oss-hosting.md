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
pr-assets/web-shell-visuals/<pr>/<head-sha>/<run-id>/
```

An object key is never written twice. The head SHA binds a URL to the code it
depicts; the run id keeps a re-run of that same head from writing back over the
objects an already-posted comment references. That matters because GitHub
serves comment images through a caching image proxy: reusing a key would leave
reviewers looking at the previous run's screenshots at a URL whose bytes had
changed. The Git-backed design got this property free from the per-run commit
SHA in the raw URL.

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

## Bucket selection

Both publishers resolve the destination as
`ALIYUN_OSS_PR_ASSETS_BUCKET` → `ALIYUN_OSS_BUCKET` → `qwen-code-assets`, with
the public base URL derived from whichever bucket wins (or set explicitly via
`ALIYUN_OSS_PR_ASSETS_PUBLIC_BASE_URL`). Unset, this is exactly today's shared
bucket. The knob exists because PR evidence is untrusted, PR-derived content
while the shared bucket also serves release, desktop, and live-host downloads;
setting one variable separates them without a workflow change.

It does not narrow the credential: these jobs hold the same OSS key the release
sync uses. Scoping a dedicated RAM user to the `pr-assets/` prefix is ops work
outside this PR, and is the reason the destination is a variable rather than a
constant.

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
