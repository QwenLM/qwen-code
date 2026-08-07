# Review repository context

## Problem

The review pipeline needs a bounded way for repositories to declare review guidance without teaching shared roster, prompt, coverage, and composition code about individual projects. Repository metadata is security-sensitive for pull request reviews because the reviewed branch must not be able to opt into or remove trusted context.

## Manifest

A repository may provide strict JSON at `.qwen/review-context.json`:

```json
{
  "version": 1,
  "label": "Example repository",
  "rules": [
    {
      "paths": ["packages/*/src/**"],
      "relatedPaths": ["packages/cli/src/commands/review/**"],
      "domains": ["runtime"],
      "recommendedTests": ["test:runtime"],
      "requiredConfigurations": ["debug"],
      "requiredAgents": ["test-matrix"],
      "unverifiedDimensions": ["Alternate configuration"],
      "verificationNotes": ["Run the repository-native focused tests"]
    }
  ]
}
```

The top-level fields are exactly `version`, `label`, and `rules`. Each rule requires `paths`; all other rule fields are optional. Unknown or missing required fields, comments, unsupported versions, oversized values, control characters, and duplicate array entries are rejected. Arrays are human-authored and may be written in any order; values from all matching rules are merged, deduplicated, and returned sorted and unique (the internal wire format keeps the strict sorted-and-unique check). Rule order is preserved. The total `paths` globs across all rules, the merged `relatedPaths` glob list, and every merged field are capped at the wire bounds and rejected fail-closed, so a matching burst cannot stall the step or outgrow the contract. Note the example's `relatedPaths` wildcard is scoped to one subsystem on purpose: wildcard `relatedPaths` are subject to the 128 resolved-file bound below, and a repository-wide scope like `packages/*/src/**` exceeds it on a repository this size.

`paths` and `relatedPaths` use repository-relative `/`-separated globs. Matching is case-sensitive on every platform and `?` consumes one UTF-16 code unit. The supported metacharacters are `*`, `?`, and a complete `**` path segment. Absolute paths, backslashes, empty or `.`/`..` segments, negation, brace expansion, character classes, and extended glob syntax are rejected.

A rule matches when any changed path matches one of its `paths` globs. If no rule matches, the provider returns no context. A matching rule's deduplicated `relatedPaths` globs are expanded from the worktree with dot files enabled, directory results disabled, symlink traversal disabled, and case-sensitive matching. Related globs containing wildcards must start with a non-wildcard directory segment so expansion cannot begin with a repository-wide wildcard; a completely static entry resolves to itself when it exists as a regular file. Globs whose path enters a dependency or build-output directory at any depth are rejected at validation (compared case-insensitively, on every platform), so the never-descend invariant holds for scan roots as well as recursion. Changed paths are removed from the result. Resolved files must remain inside the worktree. Expansion never descends into dependency and build-output trees (`node_modules`, `dist`, and the other conventional names the scan skips) and fails closed when any limit is exceeded: 16384 visited entries across the scan (files and directories, matching or not — calibrated on this repository's installed checkout, so a honestly scoped subtree, including all of `packages/`, never trips it), 128 resolved files in the result, and a matching-work budget charged per attempted pattern match (pattern length times path length) in both the rule filter and the expansion, which reports the matching-work limit and keeps a matching burst from stalling the step.

## Trust boundary

`repo-context` reads the fixed manifest path through `RepositoryContextProviderInput.readIdentityFile`. For pull request plans, the manifest therefore comes only from the trusted merge-base commit recorded by the fetch stage. The pull request head cannot opt in, opt out, or change the rules. For local plans, the manifest comes from the current worktree after safe-relative-path validation and realpath containment.

Identity reads return the same shape in both modes (CRLF normalised to LF, surrounding whitespace trimmed) and are capped at one megabyte, fail closed: an absent file yields `null`, but a file that is present, unreadable, or oversized throws rather than masquerading as "not this repository". Both modes follow a symlinked identity file itself under the same containment rule, and a directory yields nothing in both. A pull request plan whose merge base never resolved (`mergeBaseSha: null`) — or whose base fetch failed, leaving the recorded sha possibly stale — writes a `null` artifact without consulting the worktree at all: falling back to the worktree would read the manifest from the PR head, the exact read this boundary forbids, and a possibly stale sha is not a trusted source either.

Three residuals are recorded so the guarantee is not overstated. First, for pull request plans the RULES come from the merge base, but `relatedPaths` globs are expanded against the head worktree, so the head still decides which files the base's globs resolve to; impact is low because reviewers read the head tree anyway. Second, local reviews read the manifest from the current worktree, so reviewing an untrusted repository lets that repository put one bounded, control-character-free block of guidance — the label plus six capped arrays — into every code-reviewing brief; the one-megabyte read ceiling, the validation bounds, and inert rendering are the mitigation. Third, the two modes resolve identity symlinks with different engines: the pull request reader never descends through a symlinked intermediate path COMPONENT (the worktree reader does), and it caps identity symlink chains at 16 hops where the kernel resolves up to ~40 — throwing at the cap rather than degrading. A repository committing `.qwen` itself as a symlink to an in-tree directory therefore attaches context in local reviews and never in pull request reviews; the direction is fail-safe (strictly less, never more), but an operator diagnosing "context attaches locally but never on PRs" should know the asymmetry is by construction.

The manifest provider is statically registered in-process and returns the generic `RepositoryContext` shape with provider `manifest`. Its complete output passes through the shared `validateRepositoryContext` validator before downstream consumers use it. No dynamic plugin registry, shell execution, templates, or opaque payloads are supported.

## Review workflow

Medium- and high-effort local and same-repository pull request reviews invoke `repo-context` after the review plan is captured. The command receives absolute plan, worktree, and output paths. Low-effort reviews and cross-repository lightweight reviews skip repository context because they do not run the full local-tree workflow.

Code-review agents receive the generic context headed by its label. The build-and-test role receives recommended tests, required configurations, and verification notes. Required roles are merged into the normal roster without duplication, and only when the review's effort, topology, and mode already permit them — a manifest cannot inflate a medium review with the adversarial personas, re-add whole-diff walkers to a chunked fan-out, or demand a tree-grepping role from a review with no tree. Composition discloses unverified dimensions as non-blocking proof boundaries; a present-but-invalid context fails every consumer closed rather than being silently dropped anywhere.

Status: this is the foundation — the contract, the command, and the downstream consumers, exercised by unit tests and the review skill. No `.qwen/review-context.json` ships with this change, so nothing beyond tests runs end to end until a repository adopts one.
