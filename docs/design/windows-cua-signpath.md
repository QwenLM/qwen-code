# Windows CUA signing with SignPath

[English](windows-cua-signpath.md) | [简体中文](windows-cua-signpath.zh-CN.md)

## Problem and scope

The Windows SDK's optional UIAccess mode requires a valid Authenticode signature
before deploying its worker under Program Files. Default Windows installation
does not deploy that worker. PR #12442 replaces the earlier PFX import attempt
with the project's SignPath test-signing service so CI can exercise the signed
UIAccess installation end to end. It does not weaken installation checks,
publish a release, or ask users to install a test root.

## Signing flow

Release builds keep the existing contract: Windows archives carry an unsigned
UIAccess worker, and deployments that need UIAccess sign and trust it on the
target machine. A release never depends on SignPath, so a missing production
certificate cannot block ordinary-mode Windows releases.

Only a branch `workflow_dispatch` with `dry_run=true` test-signs the worker.
Tag refs and publishing runs skip that step. The Windows job has only
`contents: read` permission. A repository script submits each architecture's
worker directly to the SignPath REST API (`SubmitWithArtifact`) for
organization `e2bc00ea-6f24-4cde-9cfc-f0b19b2b6ece`, project `qwen-code`,
policy `test-signing` and artifact configuration `initial`, using the
`SIGNPATH_API_TOKEN` Actions secret. It polls the request and downloads the
signed file. No private signing key is imported into the runner.

The direct API does not use SignPath's GitHub connector, which needs the
SignPath GitHub App for origin verification. The repository cannot install that
App, and the `test-signing` policy does not require origin verification.

The script checks the known test certificate fingerprint
`0B27B4BA9D646BCDB1FD59B4F229C0DAA7E8EEF0` before importing it into the
disposable hosted runner's Root and TrustedPublisher stores, then requires
`Valid` Authenticode status before replacing the built worker. This trust is
only for CI; a self-hosted runner is outside this design. Missing output, an
unexpected signer or an invalid signature fails the job.

The clean-install check consumes the packaged payload and installs the SDK with
lifecycle scripts enabled. Dry runs set `CUA_DRIVER_USE_UIACCESS=1` and check
the deployed Program Files worker's signature. Release builds install in
ordinary mode and check that no UIAccess worker is deployed. The native payload
override does not exercise the public download/checksum path.

## Validation and acceptance

Workflow tests check dry-run routing, the test-signing step, permissions, and
ordering from build through packaging and installation. PowerShell parsing and
actionlint check syntax.

Before merging, run the exact candidate through the branch dry run for both
build targets. Both Windows jobs and SDK installation must pass; publication
jobs must remain skipped. ARM64 is cross-built on an x64 runner, so this is not
native ARM64 execution evidence.

A test-signing result does not prove public trust. Shipping a publicly trusted
UIAccess worker requires a certificate from a publicly trusted CA issued to a
validated legal entity, for example a company signing service, Azure Artifact
Signing, or a CA-issued code signing certificate. SignPath's production policy
requires origin verification through the GitHub App, which this repository
cannot install. That decision is outside this PR.

## Current status and open prerequisites

As of 2026-10-22, `SIGNPATH_API_TOKEN` is configured. The raw-PE configuration
and test-signing policy are valid.
[Run 39793940639](https://github.com/QwenLM/qwen-code/actions/runs/39793940639)
built both Windows targets but the GitHub connector failed with
`Failed to retrieve GitHub App token`, which led to the direct API design.
The PR remains a draft pending the direct-API dry run and Windows acceptance.
No release or npm publication is authorized by this work.
