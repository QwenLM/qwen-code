# Installed OpenTUI distribution acceptance

[English](opentui-installed-distribution-acceptance.md) | [简体中文](opentui-installed-distribution-acceptance.zh-CN.md)

## Status and problem

**Implementation candidate, 2026-10-26. Local development proof is complete; the subsequent CI wiring and final delivery candidate remain unverified.** This is one installed-distribution acceptance batch based on main `18e1b2a991d819dba8e4d646eb2d54187269a775`. It does not reuse historical PASS results as evidence for this candidate. It follows the [POSIX npm distribution design](2026-10-21-opentui-npm-distribution.md) and the [migration delivery plan](2026-10-20-opentui-migration-delivery.md).

Before this batch, the permanent installed suite tested a fresh local-prefix `npm install --ignore-scripts` with actual Node 26.4.0 on Darwin arm64 or GNU Linux x64. It audits a real npm tarball, private Bun/native loading, six refusal controls, screen-reader fallback, and a real npm subprocess querying a synthetic registry. The original cases do not cover global bin invocation, actual npx execution, the other two declared POSIX targets, Node 22, or released-version update activation. This batch adds actual global/npx cases for both fixed Node toolchains; public registry and released-upgrade evidence retain their own scope. Passing build/source/fixture checks cannot close these gaps.

The classic and preview installers are separate routes. Before this batch both preview scripts removed the existing preview destination before extraction; truncated input has reproduced deletion of the old entry and data as FAIL. The correction is limited to preserving an existing preview installation when staging or replacement fails; its POSIX regression cases have run locally, while Windows execution remains pending; it does not add a package manager or turn preview into a supported default.

## Goals and boundaries

Keep OpenTUI 0.5.10 and shipping Bun 1.4.4. Keep Node as npm launcher and package-manager interpreter, the existing supervised handoff, current default Ink, screen-reader fallback and existing updater ownership. Do not introduce a runtime selector, global Bun requirement, startup download, new publishing family, general test framework, Windows npm private-Bun support, or musl support.

Deliver permanent actual-layout acceptance, a bounded preview failure-preservation fix, linked test plans, and exact-source/artifact receipts as one coherent review batch. Every delivery PR must remain at or below 6000 added plus deleted lines against its actual base. Do not delete unique assertions or split each platform or scenario into a separate PR to meet that limit.

## Routes and applicability

| Route                                                          | Declared behavior                                                                                  | Required acceptance                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| npm global and npx on Darwin arm64/x64 and GNU Linux arm64/x64 | Explicit interactive OpenTUI uses installation-owned private Bun; npm remains on the original Node | Real bin/cache entry, native/parser and process ownership, fallback/refusal, update ownership                   |
| Classic standalone on the four POSIX targets and win-x64       | Packaged Node/Ink remains the compatibility route                                                  | Actual installation and lifecycle, archive/runtime integrity, strict OpenTUI refusal and update preservation    |
| Bun standalone preview on those five targets                   | Gated preview archive with packaged Bun/native assets                                              | Platform qualification and release-scope decision; Windows Bun PTY is currently excluded by the existing design |
| Windows npm, Linux musl and unsupported CPUs                   | No npm private-Bun handoff                                                                         | Ordinary Node/Ink compatibility and explicit strict refusal; no positive OpenTUI support is silently added      |

The existing 180 planning obligations remain intact: 117 cells concern declared routes, 45 concern conditional preview routes and 18 concern Windows npm compatibility/refusal. These are proposed applicability labels, not PASS results, policy waivers or removal of a user contract. Root/maintainers must adjudicate ambiguous expectations before updating the official matrix. Unsupported Cartesian products are not new implementation obligations.

## Harness and toolchain design

Reuse the current installed suite, process observer and `InteractiveSession`. Extract only genuinely shared pack/inventory, toolchain, installation-receipt and owned-process mechanics into one installed fixture used by the existing suite and new distribution/update tests. Keep scenario assertions explicit. Preserve no-retry, serial execution, bounded budgets and original failures.

Use fixed actual Node 22.23.2 and Node 26.4.0, with the npm belonging to each toolchain. Record executable paths, versions, hashes and modes. Node 24 used to run builds is not a Node 22 product test. Four native POSIX runners, two invoking Node versions, two installation layouts and enabled/disabled lifecycle scripts form 32 actual layout/toolchain/lifecycle contexts; absent runners stay NOT_RUN rather than silently skip. Linux runners must establish glibc availability. A shared artifact must be rebuilt only when its source or inputs change, not once per assertion.

For global installation, use actual npm global installation into an owned prefix. Resolve the global package root through that npm rather than assuming local-prefix `node_modules`; invoke the installed bin with a controlled PATH and verify its realpath and actual Node process. For npx, invoke that toolchain's real `npm exec`/npx against the exact tarball in an empty workspace and owned `HOME/.npm` cache. Record the selected `_npx` installation and its artifact identity, not the first directory found. Do not fabricate a cache tree around a local installation.

The current npx classifier recognizes `/.npm/_npx` and `/npm/_npx`. A custom cache outside these shapes needs reproduction before claiming a defect or changing production behavior. Keep that risk visible; do not make a test pass by injecting a false installation identity.

## Canonical CI artifact and development evidence

The existing GNU Linux x64 installed job remains the single package producer. Its original nine scenarios retain their assertions and receipts; after the same tarball audit it additionally exports the published-file inventory and source receipt. Only a successful producer uploads these files and the tarball. All four native targets download those same bytes. A small binder checks tarball/inventory hashes, byte length and the actual checkout commit/diff before changing only two local paths in a new receipt. It never rewrites the canonical original or runs a package manager. Each host runs both complete twelve-case legs serially with fixed Node 22.23.2/26.4.0, separate outputs and the same bound artifact. A failed first leg leaves the second NOT_RUN; neither failures nor unhandled errors are ignored or retried.

The hosted labels are `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15` and `macos-15-intel`, with actual platform/CPU and Linux glibc assertions. Presence in the [official runner inventory](https://github.com/actions/runner-images/blob/6d35e16176367288d91febefafbd221cb2da6ca1/README.md) does not prove repository scheduling access or native execution. Canonical and per-host evidence artifact names include run and attempt identity. The Windows installer failure exit includes both complete installer files, so the existing warning-only broad script suite cannot hide a preview failure. Its merge-queue/schedule/dispatch trust policy remains unchanged; an ordinary PR is not automatically Windows proof. Eight common preview cases can execute there, while three POSIX-specific cases remain explicit skips.

Local Darwin arm64 development validation before this CI wiring, using main `18e1b2a991d819dba8e4d646eb2d54187269a775` plus the uncommitted distribution changes, passed build, typecheck including integration, lint and bundle. Two installer whole files passed 148 cases with 11 existing platform skips. One audited tarball contained 1,375 published files; its original nine installed cases and twelve new cases under each actual Node version passed: 33 product cases, no failures or skips. Source/runtime/controller and full artifact guards remained unchanged during each new twelve-case leg, with no timeout, forced cleanup or remaining owned processes. These are exact pre-CI candidate development results, not proof for later wiring, a future commit, another platform or a released upgrade. Final delivery must bind its own exact source and artifact evidence. The original truncated-archive deletion FAIL and unchanged-oracle corrected PASS remain separate records.

## Product and failure contracts

A positive case needs a TTY, strict OpenTUI selection, actual installation-owned Bun/native mappings, parser/highlight output, a closed model request, and natural exit without surviving owned processes. `--version`, a source bundle, or a wrapper log alone is insufficient. Preserve original Node identity for npm operations and observe all subprocess starts and exits.

Exercise ordinary installation and `--ignore-scripts`, no global Bun, a decoy Bun, real `--omit=optional` installation, missing/non-executable Bun, missing native/grammar assets, disabled relaunch and inherited runtime flags. Strict failure and nonstrict working Ink fallback are separate assertions. Screen-reader, headless/protocol/help/version routes retain their existing behavior. Read-only behavior requires effective restricted permissions, not chmod under an unrestricted identity.

Freeze source, tarball, toolchains and initial installation inventories. Updater tests may change only their declared staging/version/pointer paths; do not disable immutability guards wholesale. Capture process birth identity so reused PIDs cannot count as owned survivors. Forced cleanup is failure evidence, not natural-exit acceptance.

## Updates, authentication and preview preservation

Test actual released origin installation, product update entry, staging/activation, and re-entry through the original global launcher. Verify base version/ctime and launcher identity, the selected version directory/pointer, actual new executable/assets, user data preservation and old live-session isolation. Running a new payload directly does not prove activation. Failed download, authentication, wrong version, incomplete CLI or failed smoke must leave the previously working installation and active pointer usable and clean up only owned staging.

npx currently declares updates inapplicable. Its acceptance is explicit old/new version cache invocation and failed-candidate isolation without global or unrelated cache mutation. Do not add a managed self-updater to npx as a test convenience. Failed-update preservation and an explicit user-requested downgrade are different contracts: the existing keep-highest activation rule is not waived or replaced. The downgrade/rollback policy needs a maintainer decision.

The user confirmed public `https://registry.npmjs.org/` only: actual anonymous metadata, downloads, installs and applicable updates are the final registry route. Preserve original Node/npm configuration and retain configuration-forwarding regressions; no private registry, new credentials or publishing permission is required or authorized. A local registry can provide deterministic candidate/failure or synthetic configuration cases, but its synthetic status remains explicit. A real old release plus a synthetic candidate endpoint is not proof of a public released-to-released upgrade. Do not publish a candidate, change dist-tags or invent a version to claim that evidence.

For preview scripts, unpack into an owned sibling staging directory, check the expected target launcher/runtime/package structure before touching the active destination, and replace only after staging succeeds. Preserve or restore the old preview on extraction, validation or activation failure. Keep classic installation and PATH untouched. Apply matching POSIX and PowerShell behavior without a new updater, lock service or persistent runtime cache. Preserve the documented local `--archive` checksum bypass as an explicitly unverified input mode; do not silently treat it as verified release provenance. Archive trust, path/link handling and replacement cleanup need regression coverage before finalizing the implementation.

## Release provenance and evidence

GitHub metadata read on 2026-10-26 shows CLI stable [v0.26.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.1), published 2026-10-24, with five classic archives, five preview archives and `SHA256SUMS`; [v0.26.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.0) is another released-origin candidate. This GitHub listing is metadata only: release asset downloads, hashes and actual executability remain NOT_RUN. GitHub `releases/latest` currently selects an SDK release, so a generic latest endpoint must not choose the CLI baseline.

This checkout also declares version 0.26.1. Same-version candidate bytes are not the already published package. Anonymous public npm metadata reads for 0.26.0 and 0.26.1 have passed: public 0.26.0 has no private Bun optional dependency, while public 0.26.1 pins the four POSIX Bun packages to 1.3.14, distinct from this source candidate’s 1.4.4. Select the released origin, candidate source/version and allowed endpoint explicitly; downloads, integrity and update activation for existing public releases still need controlled execution. No publishing operation is part of acceptance. Keep real release, unpublished candidate, local fixture, actual public registry access and cross-platform evidence separate.

Each attempt records source commit/tree, artifact hash and file audit, target and libc, invoking Node/npm and private Bun/native identities, actual entry/cache, installation flags, output/assertions, exact exit/cleanup and immutable before/after maps. Keep FAIL, SKIP and NOT_RUN with their scope. Never assemble final acceptance by combining successful rows from different candidates.

## Validation and acceptance criteria

1. Freeze final source and packaging inputs; audit one real npm pack and matching target archives. Reconcile English/Chinese design and the E2E plan before execution.
2. Baseline existing permanent tests and the globally installed CLI as required by project workflow, recording exact versions and unavailable baselines; no candidate claim follows from a baseline.
3. Run affected build/typecheck and focused tests, then actual global/npx contexts on the declared native runners and fixed Node toolchains. Preserve the existing nine-case scope and add new evidence rather than relabeling it.
4. Exercise real update activation and failed-update preservation, npx cache transition, authentication boundaries and both preview-script failure paths. Qualify Windows classic separately from gated preview and its PTY limitation.
5. Audit the full final diff and evidence with two consecutive clean passes, then request unified review. Missing runner, release or authentication evidence remains explicitly open; merged tooling does not complete the whole migration.

All 180 obligations and manual IME, clipboard/device, accessibility and terminal-lifecycle contracts remain tracked. Default runtime/renderer, release rollout and Ink removal still require their separate acceptance gates and maintainer approval. This batch changes none of those policies.

## Open decisions

- Actual scheduling and execution on the remaining native POSIX and Windows runners; local Node 22.23.2/26.4.0 proof does not close those cells. The public anonymous registry decision is resolved.
- Exact released-origin package/archive and candidate endpoint/version; downloads, integrity and activation of the existing public releases remain unverified.
- Preview scope and Windows PTY expectations; full preview parity must not be inferred from archive availability.
- npx custom-cache classification reproduction and explicit downgrade/rollback policy.
- Final installed products versus synthetic fixtures and the still-open platform/manual/default gates.
