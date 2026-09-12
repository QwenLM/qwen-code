# Focused automatic review for static documentation navigation

[English](2026-09-09-low-risk-nav-review.md) | [简体中文](2026-09-09-low-risk-nav-review.zh-CN.md)

## Problem

PR #11426 changed one navigation entry (+1/-3), but the automatic review
launched 16 initial agents, two reverse auditors and two verifiers. It spent
90 minutes investigating existing example-documentation problems and timed out
before publishing. The current micro-diff gate reduces the timeout, not the
amount of review work.

## Design

The automatic workflow identifies itself with `QWEN_REVIEW_AUTOMATIC=true`.
After fetching the PR, the CLI may record `reviewProfile: docs-nav` in the
captured plan. Explicit review requests, local reviews, resumed reviews,
effective incremental reviews and captures without a fresh merge base retain their
existing behavior.

Classification uses the complete captured diff and the immutable base/head
file contents. Initially the only eligible shape is one existing regular
`docs/**/_meta.ts` file, fewer than 25 added plus removed lines, with an
`export default` object containing only literal strings and objects on both
sides. The set AND ORDER of top-level navigation keys must stay unchanged — key
order is the sidebar order, and a `type: 'separator'` groups the entries after
it, so a pure reorder is structure, not presentation. Only labels,
`title`, and `display` (`hidden` or `normal`) may change; other metadata must
remain identical. Imports, calls, spreads, computed keys, escapes, renames,
mode changes and unsupported syntax retain the full review. The classifier
never evaluates the file and does not affect CI's shared docs-only classifier.

The shared docs-only classifier controls CI routing, not the review roster or
the causal scope of its findings. Extending it alone would still leave the
review work that timed out on #11426. This profile bounds that work separately.

The focused profile keeps the existing high-effort invocation and its posting
authorization. The plan's profile changes the required work: one navigation
reviewer reads the whole diff, relevant PR context and direct navigation
consumers, then returns candidates or an explicit clean receipt. Candidate
findings must explain the behavior difference caused by this PR before they
enter one independent verification pass. Existing defects outside that causal
scope do not trigger verification or further exploration. There is no reverse
audit or specialist fan-out. The reviewer receives explicit reads for both
captured revisions rather than inferring a base from the branch's last commit.
Repository-declared extra reviewers retain the normal roster only when the
existing effort, topology and mode policy would admit those roles.

Coverage checks require the focused reviewer and, when posting findings, the
existing independent-verifier evidence. Composition discloses the focused
scope and omitted reverse audit, caps a clean result at COMMENT, and preserves
verified blocking findings. That disclosure also prevents the posted ledger
from certifying an incremental anchor. The skill must not promote a full-review
cache from this profile. Publishing continues through the existing submit
command, with the same authorization, commit, anchor and presubmit checks.

## Implementation areas

- Workflow: mark automatic invocations; leave explicit requests and budgets alone.
- Capture and classification: derive the profile from base/head, never a user flag.
- Roster and briefs: one focused role, causal scope for the finder and verifier.
- Coverage: share profile selection with the roster and disclose reduced scope.
- Bundled review instructions: dispatch, single verification, publication and cache rules.
- Tests: conservative classification, full-review fallbacks, coverage and posting contracts.

## Scope and validation

This change does not alter deadline admission, general medium/minimal behavior,
security review policy for executable changes, or the CI test classifier.
Unsupported navigation syntax simply keeps the existing review.

Baseline CLI probes and a local bundled replay of #11426 will verify the
roster and completion behavior. Publishing is tested without a public write.
A one-line permission change, executable metadata and a mixed diff must still
require the full review. Missing reviewer/verifier evidence must cap the
result; a focused clean result must not approve or anchor a later full review.
The performance target is a completed result in 10–15 minutes, measured rather
than inferred from agent count.

## Open questions

None for this initial, deliberately narrow profile. Additional low-risk file
shapes require separate evidence and can be added later.
