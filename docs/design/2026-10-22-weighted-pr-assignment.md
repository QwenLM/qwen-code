# Weighted PR Owner Assignment

[English](2026-10-22-weighted-pr-assignment.md) | [简体中文](2026-10-22-weighted-pr-assignment.zh-CN.md)

## Problem

PR assignment currently selects the eligible area owner with the fewest open
assigned issues. The load query counts issues, so assigning another PR does not
increase that number. One person with 17 issues can receive every new PR routed
to a pool whose other members have 18 or more issues.

## Design

For PR assignment, give each eligible owner weight `1 / (openIssues + 1)` and
sample once from the normalized weights using `Math.random()`. Adding one keeps
zero-issue owners valid. Every eligible owner has a positive probability, and
a lower measured issue count gives a higher probability within the same pool.

For example, issue counts of 0, 1, and 3 produce weights of 1, 1/2, and 1/4,
and probabilities of 4/7, 2/7, and 1/7. Equal loads produce equal probabilities.
A pool containing one eligible owner still selects that owner.

Keep the PR selector in `.github/scripts/assign-pr-owner.mjs`. The existing
issue selector remains in `.github/scripts/assign-issue-owner.mjs`, and issue
assignment continues using its current minimum-load and tie-rotation rule.
Both paths continue sharing the policy loader and issue-count query.

Path-based area selection, fallback to a broader area, author exclusion, live
write-permission checks, and the pre-write coverage/head checks remain in force.
Once a mapped owner is assigned or has reviewed, later runs do not draw another
owner. A dry run draws a candidate without writing; a later run can draw someone
else because dry runs do not reserve a selection.

Assignment and dry-run summaries record the exact, unrounded draw, the effective
issue loads in eligible-owner selection order, and the owners whose load lookup
remained unavailable after retry. The same evidence is retained when GitHub
silently rejects the selected assignee. The picker receives the draw explicitly;
selection and its summary share that one draw. An unavailable lookup still uses
zero for weighting, but its owner appears in the unavailable list so it can be
distinguished from a measured zero load.

## Scope and Tradeoffs

This changes PR selection only. It adds no settings, dependencies, persistent
rotation state, or workflow permissions. The existing count remains capped at
100 open issues and excludes PRs. Failed load queries retain the existing retry
and zero-load fallback, so the weights represent the available estimate rather
than a complete measure of workload.

Random selection can still choose the same owner repeatedly. It spreads the
chance of assignment rather than guaranteeing a rotation or equal workloads.
The PR number no longer decides the selected owner.

## Validation and Acceptance Criteria

- Deterministic draws verify interval boundaries, zero loads, equal loads,
  single-owner pools, and a positive chance for a busier owner.
- A fixed grid of draws verifies the independently calculated 4:2:1 ratio,
  avoiding a flaky statistical test against live randomness.
- Full script tests control randomness only through a test-process preload and
  verify that both lower- and higher-load owners can reach the actual assignment
  request. Reverting to minimum-load selection must fail these checks.
- The preload rejects a second random draw. Assignment, dry-run, and silently
  rejected-assignment summaries expose the draw, ordered effective loads, and
  unavailable owners. Load-query failure is distinguishable from a true zero.
- Preload paths are file URLs, so temporary directories containing `#` or `?`
  work correctly on POSIX systems.
- Existing tests continue to cover author exclusion, area fallback, permission
  filtering, dry runs, load-query failures, stale heads, existing owners, and
  assignment API failures. The issue-assignment suite must remain unchanged and
  pass.
- Baseline and updated script probes use a stub GitHub CLI; no real PR is
  reassigned during verification. This workflow runs independently of the Qwen
  interactive CLI.

## Open Questions

None for this change. Counting assigned PRs or refining area ownership can be
considered separately if the issue-based probability is insufficient.
