# Windows CUA signing with SignPath

[English](windows-cua-signpath.md) | [简体中文](windows-cua-signpath.zh-CN.md)

## Problem and scope

The Windows SDK's optional UIAccess mode requires a valid Authenticode signature
before deploying its worker under Program Files. Default Windows installation
does not deploy that worker. PR #12442 adds signing before packaging;
this revision replaces its PFX import path with the project's SignPath service.
It does not weaken installation checks, publish a release, or ask users to
install a test root. Only the UIAccess worker is signed by this integration.

## Signing flow

The hosted Windows job builds an unsigned worker for each architecture and
uploads it as a raw PE artifact with a unique architecture-specific filename.
The pinned SignPath action submits that artifact ID to organization
`e2bc00ea-6f24-4cde-9cfc-f0b19b2b6ece`, project `qwen-code`, artifact
configuration `initial`, then downloads the completed signing request's output.
The Windows job has only `actions: read` and `contents: read` permissions.
`SIGNPATH_API_TOKEN` is an Actions secret; no private signing key is imported
into the runner. The action binds its authenticated download to the signing
request created for the uploaded artifact, repository and workflow run.

Only a branch `workflow_dispatch` with `dry_run=true` selects `test-signing`.
Tag refs and all publishing runs select `release-signing`. This includes manual
tag dispatches even when `dry_run` retains its default. Production policy
approval and a publicly trusted certificate are service-side prerequisites.

For tests, the installer checks the known test certificate fingerprint
`0B27B4BA9D646BCDB1FD59B4F229C0DAA7E8EEF0` before importing that certificate into
the disposable hosted runner's Root and TrustedPublisher stores. This trust is
only for CI. A self-hosted runner is outside this design. Production execution
does not import a root. Both paths require `Valid` Authenticode status before
packaging. Missing output or an invalid signature fails the job.

The clean-install check sets `CUA_DRIVER_USE_UIACCESS=1`, consumes the packaged
payload, installs the SDK with lifecycle scripts enabled, and checks the deployed
Program Files worker's signature. It exercises packaging and installation; its native payload
override does not exercise the public download/checksum path.

## Validation and acceptance

Workflow tests check policy routing, artifact inputs, permissions, and ordering
from unsigned build through signing, packaging, and installation. PowerShell
parsing and actionlint check syntax. A retained manually test-signed x64 worker
provides separate evidence of the configured test certificate and PE payload;
it does not prove the workflow's authenticated API submission.

Before merging, run the exact candidate through the branch dry run for both
build targets with `SIGNPATH_API_TOKEN` configured. Both Windows jobs and SDK
installation must pass; publication jobs must remain skipped. ARM64 is
cross-built on an x64 runner, so this is not native ARM64 execution evidence.

Before public release acceptance, provision the production certificate, complete
the release policy approval, and install the publisher-signed candidate on a
clean Windows machine without importing a test root. Exercise an actual UIAccess
input action. A test-signing result cannot satisfy this acceptance criterion.

## Current status and open prerequisites

As of 2026-10-22, the local retained test artifact and static checks are available.
The repository and inherited organization secret lists do not expose
`SIGNPATH_API_TOKEN` to this repository. The previous authenticated SignPath
browser session is unavailable, so the current production certificate status
has not been reverified. The PR remains a draft pending the online signing and
Windows checks. No release or npm publication is authorized by this work.
