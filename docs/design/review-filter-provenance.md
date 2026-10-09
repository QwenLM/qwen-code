# Review Filter Provenance

[English](review-filter-provenance.md) | [简体中文](review-filter-provenance.zh-CN.md)

## Problem

Review checkouts share Git configuration with the user's repository. A global
include can reach repository-delivered filter commands. Git's inherited scope
does not establish ownership. Inferring an index root from `core.worktree` is
unsafe: that key and corroborating gitfiles are mutable, and worktree-specific
configuration can redirect the root again.

## Decision

Read filter and include keys together with Git's scoped, NUL-delimited config
enumeration. This one result supplies both command keys and source origins.
Exclude unrelated values to bound output. A failed or malformed enumeration
always refuses checkout, including when every scoped query fails.
Both scratch-tree and base-tree creation must call this gate before Git checks
out files. Linked base, scratch and probe trees are first registered with
`--no-checkout`, then screened in their destination context before an explicit
checkout. A conditional user include can activate only for the new gitdir;
screening the source alone does not authorize that destination.
Base-tree reuse still blanks known drivers for its controlled
measurement; that is not authorization to execute them during initial creation.

Keep native global/system slots separate from their included files. Native
slots may be user-owned even when a different worktree tracks them, but never
when the screened checkout or repository administration can rewrite the slot
or its target. Preserve the exact origin spelling; aliases do not inherit trust.

For other origins, refuse files discovered in the same repository family.
Also compare opened spelling, canonical slot and real target against indexed
relative paths, using path-segment suffixes of the file and its ancestors (an
indexed symlink can redirect a prefix). These matches are denial evidence,
not inferred roots. Enumerate the common, linked-worktree and owned submodule
indexes, including nested modules and their worktrees. Do not use index misses
under a guessed root, `core.worktree`, or a newly planted gitfile to grant trust.
Incomplete discovery/index reads cannot exempt an included source.

The local include walk still examines inactive conditional includes because
the future scratch checkout can have a different Git context. Once a trusted
boundary is reached, Git evaluates its transitive active graph; each command
origin is classified independently. Shared-tree residue remains unmeasured
when locally reached user filters may have normalized checkout contents.

## Constraints

This deliberately tightens ambiguous external includes: a genuinely external
file whose path or ancestor ends with an indexed path (case-insensitively,
with Unicode normalization) is refused.
Untracked includes inside a related worktree are also refused. Ordinary external
includes with no such ambiguity and native user slots remain supported.
Initial base creation now refuses repository-local filter commands, consistently
with scratch creation. Users needing checkout transformations must configure
their trusted drivers through global/system origins outside repository control.

Administration traversal is capped at 64 directories and cumulative index
output at 64 MiB. Exceeding a limit prevents an exemption, rather than silently
truncating evidence. Config reads retain their existing 64 MiB bound.

This is a one-shot check, not process isolation. It cannot close same-user
mutation races or recover provenance after all index membership and discovery
evidence have been erased. No new persistent trust store, root snapshot, or
general Git parser is introduced.

## Acceptance

Reproduce the three current failures before changing production code. Verify
worktree-scoped roots, separate/bare layouts, missing markers, submodules,
symlinks, nested includes, failed reads and harmless real filter canaries.
Retain positive controls for native and external included user filters. Run
the review helper suites, build, bundle, typecheck, lint and independent fresh
bundled-CLI checks. Report the executed platforms and any unavailable checks.
