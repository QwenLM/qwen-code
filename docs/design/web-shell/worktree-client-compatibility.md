# Worktree client compatibility

[English](worktree-client-compatibility.md) |
[简体中文](worktree-client-compatibility.zh-CN.md)

## Scope

This addendum addresses F1 and F2 in
[PR #11816's verification report](https://github.com/QwenLM/qwen-code/pull/11816#issuecomment-5851912768).
It supersedes the missing-session-id rules in sections 6.2 and 7.1 of the
[optional worktree design](web-shell-branch-session-optional-worktree.md).
The branch transaction and worktree lifecycle remain outside this fix.

## Decisions

When a published branch cannot activate its worktree, the Web Shell action
rethrows the original error without dispatching a generic failure notice. The
App owns the recovery toast and refreshes the source session catalog. Other
errors, including an unknown publication outcome, retain their generic notice.

Older Web Shell clients send a managed worktree `cwd` without `sessionId`.
The daemon derives a candidate session id from the bounded regular
`.qwen-session` marker at the managed worktree root only when the query field
is absent. The marker is a lookup hint, not sufficient authorization.
Explicit invalid or mismatched ids are rejected without attempting inference.

The candidate must pass the existing authorization checks: a live snapshot
from the selected runtime, matching workspace ownership, matching durable
sidecar, matching marker, canonical managed-root containment, shared Git
common directory, and a valid Git directory backpointer. Nested cwd requests
use the marker at the enclosing managed worktree root. Failures never fall
back to the primary workspace or authorize a different checkout.

These routes remain selected-runtime scoped with live-session ownership
validation. The same resolver covers status, diff/file diff, log/commit detail,
branch listing, checkout, branch creation, push, pull, commit, and GitHub PR
creation. Trust, runtime generation, environment, and mutation admission keep
their existing checks. New clients continue to send the explicit owner id.

## Acceptance criteria

- An activation failure produces exactly one recovery toast; ordinary and
  outcome-unknown errors still produce a generic notice.
- Old-style `cwd`-only requests work for a valid live managed worktree and its
  subdirectories, without broadening access to other repository directories.
- Explicit wrong, malformed, empty, or repeated ids fail. Missing, malformed,
  symlinked, or mismatched markers fail; an unavailable live owner, wrong
  runtime, invalid sidecar, or mismatched Git directory also fails.
- Read and mutation paths use identical owner inference and validation.
- Focused regression tests fail on the original PR head and pass with the fix;
  build, typecheck, and package tests validate the resulting change.
