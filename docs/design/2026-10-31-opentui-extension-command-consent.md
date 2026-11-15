# OpenTUI direct extension consent

[English](2026-10-31-opentui-extension-command-consent.md) | [简体中文](2026-10-31-opentui-extension-command-consent.zh-CN.md)

## Problem and scope

A controlled public direct-install reproduction in ordinary approval mode showed native installation committing without asking. Same-candidate Ink and installed Ink displayed consent, accepted No, and retained empty authority/artifact state; their whole control observers later failed on wrapped cancellation text, so neither is reported as a complete passing case. Native Source acquisition supplies its own explicit consent callback and is a separate path.

## Ownership and implementation

The native shell registers the existing consent formatter on its Config's extension manager and presents requests through the existing action-confirmation queue. An effect-local AbortController owns queued and visible requests. The effect depends only on Config and the stable confirmation bridge, so ordinary rerenders preserve pending consent. Config replacement and unmount abort the owner; a captured stale callback rejects instead of approving or opening another dialog. Cleanup does not restore a no-op or overwrite a successor's registration. Each request retains the queue's existing independent yes/no settlement.

This CLI-only change does not change Core APIs, approval modes, provider/headless behavior, or installation transaction boundaries. A cancellation cannot roll back a commit already performed by Core. Global marketplace-choice and extension-setting callback parity remain separate unqualified capabilities; Source acquisition's explicit callbacks remain authoritative.

## Validation and acceptance

The controlled pre-fix native installation committed without consent. Initial Ink controls displayed consent, accepted No, and preserved empty authority/artifact state; their complete observers failed on wrapped cancellation text and remain failed. The first native correction then failed because raw text was mounted under a box. These failures are preserved in the investigation records. The current callback supplies sanitized native text, and the shell regression checks the rendered element through the native-to-DOM test adapter.

The corrected public denial case passed against the precommit e7fe-plus-patch bundle under strict Bun+OpenTUI, Node+Ink and Bun+Ink. A separate installed global Ink baseline also passed, with source identity unknown. All four executions displayed consent, accepted one No, retained the exact initialized authority and entire artifact snapshots, recorded zero model requests, and exited naturally with exit0/signal0. Readiness follows each renderer's existing confirmation UI; it does not add a cosmetic Ink question to native production. These results cover denial, not a subsequent approved installation or hook execution.

Normal build and bundle passed for this precommit patch; the tested entry is `9a16c6a746510853c9640b5368547e5f1e3dbbb07d5bb5bf6e602e4f6b028e54`. Full typecheck passed. After the test-only rejection-assertion correction, the latest three whole test files passed261 tests, covering formatted/native-text consent, Yes/No settlement, FIFO, ordinary rerenders, Config replacement, stale handlers, late answers and unmount. Full lint and native layout verification also passed. No new committed/installed artifact, other-platform, hook-lifecycle or overall migration qualification is claimed.
