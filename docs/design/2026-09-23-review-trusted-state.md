# Review Trusted State Outside Workspaces

[English](2026-09-23-review-trusted-state.md) | [简体中文](2026-09-23-review-trusted-state.zh-CN.md)

Status: Implemented by this change; not yet merged.

## Problem

The review pipeline treats its worktree lease and base-tree records as host authority. A lease can authorize cleanup to remove a worktree and branch, while a base-tree record decides whether a built comparison tree is safe to reuse. These records currently live in `<repository>/.qwen/review-leases`.

The tool-execution sandbox makes the repository workspace writable. Bubblewrap compensates by masking `.qwen/review-leases`, but an additive Landlock ruleset cannot express a hidden or denied child under an otherwise writable workspace. Keeping this state in the workspace therefore prevents Landlock from preserving the same review security boundary.

## Goals

- Keep review leases and base-tree trust records outside every writable repository workspace.
- Preserve one lock scope for a review's outer repository and its nested review worktrees.
- Keep repository namespaces collision-resistant and stable across symlink spellings.
- Stop relying on a backend-specific mask while preserving user-configured sandbox masks.
- Ignore, rather than migrate or trust, authority found in the retired in-workspace directory.

## Non-goals

- This change does not implement Landlock.
- This change does not make unsandboxed execution safe from another process running as the same user.
- This change does not preserve concurrent lease coordination with older CLI builds that only know the in-workspace location.
- This change does not remove the older `.qwen/tmp` compatibility mirror; that mirror remains advisory and is never read as authority.

## Design

Trusted review state moves to `$QWEN_HOME/review-state/<repository-hash>`. The hash is SHA-256 over the canonical outermost repository root. Existing roots are resolved through `realpath`, which unifies symlink spellings without collapsing distinct repositories on a case-sensitive volume.

The layout is:

```text
$QWEN_HOME/review-state/<repository-hash>/
├── qwen-review-lease-pr-<n>.json
└── base-tree/pr-<n>/
    ├── <plan-hash>.json
    └── review-pr-<n>-base.lock/
```

A review started inside another review worktree derives the first outer `.qwen/tmp` boundary lexically and hashes that outer repository root. It therefore shares the same lease and base-tree namespace as the outer review. The derivation never consults a Git pointer inside reviewed content.

The sandbox already treats `QWEN_HOME` as a protected root during policy admission. A configured `QWEN_HOME` that overlaps the workspace is rejected before execution. Under the sandbox, the global state remains on the read-only host view while the workspace is writable.

The CLI no longer appends `<workspace>/.qwen/review-leases` to `maskedPaths`. Explicit masks supplied by the operator policy remain unchanged. The retired directory remains excluded from local-diff capture so residue from an older build does not become review input, but no lease or base-tree decision reads from it.

## Migration and Compatibility

The first new capture creates a fresh lease in the global namespace. Existing `.qwen/review-leases` content is ignored even when it is well-formed, because reviewed code could have modified it while the workspace was writable. Automatically importing it would move attacker-controlled state across the trust boundary.

Operators should finish or clean up active reviews before moving between builds that use different lease locations. A downgrade cannot safely consume the new global lease, and the new build cannot safely honor the old workspace lease.

## Risks

- Changing `QWEN_HOME` changes the trusted-state namespace and can leave stale state under the previous root.
- A repository move changes its path hash and can leave stale state under the previous namespace.
- Mixed-version concurrent reviews cannot coordinate across the location change; the safe operational rule is to avoid that overlap.

These cases lose reuse or require cleanup. They do not grant reviewed code authority over the new state.

## Validation Plan

- Verify direct and nested repository paths select the expected global namespace and different repositories do not collide.
- Plant a valid-looking lease in `.qwen/review-leases` and verify acquisition and base-tree identity ignore it.
- Exercise atomic acquisition, same-session refresh, cleanup, trust-record reclamation, and base-tree reuse tests against the new location.
- Verify sandbox configuration preserves explicit operator masks without adding the retired built-in mask.
- Build and typecheck Core and CLI, run focused lint and formatting checks, and run the review host-execution canary.
- On Linux, verify a workspace-write sandbox can modify the retired workspace path but cannot modify the global trusted state, while review cleanup still acts only on the real lease.

## Acceptance Criteria

- No production lease or base-tree authority path is inside the repository workspace.
- An outer repository and review worktrees nested below it share one repository namespace.
- In-workspace planted state cannot block acquisition, rotate base-tree trust, or redirect cleanup.
- The automatic `.qwen/review-leases` mask is absent and explicit masks are preserved.
- Focused tests, build, typecheck, lint, formatting, and diff checks pass.

## Follow-up

After this change merges, the Landlock fallback can be restacked on `main`. It must reject any remaining non-empty `maskedPaths` policy and preserve the established bubblewrap hardening and fail-closed behavior.
